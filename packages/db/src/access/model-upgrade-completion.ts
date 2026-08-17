import { sql } from "drizzle-orm";

import { db } from "../client.ts";
import { modelUpgradeCompletion } from "../schema/upgrade.ts";

/**
 * Whether this installation has finished moving onto model selections — the one
 * fact the later removal of the legacy paths is allowed to act on.
 *
 * **It is a marker rather than a release number, and that is the whole point.**
 * A release cannot know whether a particular deployment's personas have all
 * been given selections, whether somebody's queued simulation is still waiting
 * on the old work-order contract, or whether an old grading plan still has a
 * judge credential to resolve. Only the installation knows, and it can only
 * know by asking. So the conditions are re-asked on every boot and the stamp is
 * written the first time they all hold.
 *
 * **Written once, never withdrawn.** Nothing writes a legacy-shaped row any
 * more, so a deployment that finished cannot un-finish; a marker that could
 * flip back would be one no cleanup could safely read.
 *
 * **This file builds the marker and the checks that read it. It removes
 * nothing.** Taking the legacy paths out is the next release's work, and doing
 * any of it here would be removing them before the marker they are gated on
 * could ever have been written.
 */

/**
 * What is still standing between this installation and the removal.
 *
 * Each word names one condition, and the four together are the ticket's own
 * sentence: every current persona and grader has explicit models, and no
 * nonterminal work depends on a legacy contract or a legacy credential
 * reference.
 */
export const UPGRADE_CONDITIONS = [
  /** Some current persona version still carries no selections. */
  "personas",
  /** Some current grader version still carries no selection. */
  "graders",
  /**
   * Some simulation that has not finished is pinned to a persona version with
   * no selections — which is a work order on the old simulation contract, still
   * to be claimed or still being conducted.
   */
  "simulations",
  /**
   * Some grading job that has not finished belongs to a run whose frozen plan
   * names a judge credential — the legacy credential reference, still to be
   * resolved.
   */
  "grading",
] as const;
export type UpgradeCondition = (typeof UPGRADE_CONDITIONS)[number];

export type ModelUpgradeCompletion = {
  /** Whether the marker is written. */
  readonly completed: boolean;
  /** When it was written, or null while it is not. */
  readonly completedAt: Date | null;
  /**
   * What is still outstanding, in the order above. Empty exactly when the
   * marker is written — and it is what a person reading a drain check needs,
   * because "not finished" with nothing after it sends somebody looking.
   */
  readonly outstanding: readonly UpgradeCondition[];
};

/** Whether each condition still has work behind it. */
async function outstandingConditions(): Promise<readonly UpgradeCondition[]> {
  const { rows } = (await db().execute(sql`
    select
      exists (
        select 1 from persona p
          join persona_version v on v.id = p.current_version_id
         where v.models is null
      ) as personas,
      exists (
        select 1 from grader g
          join grader_version gv on gv.id = g.current_version_id
         where g.type = 'llm_as_judge'
           and g.deleted_at is null and gv.grader_model is null
      ) as graders,
      exists (
        select 1 from simulation s
          join persona_version v on v.id = s.persona_version_id
         where s.status in ('queued', 'claimed', 'running') and v.models is null
      ) as simulations,
      exists (
        select 1 from grading_job j
          join simulation s on s.id = j.simulation_id
          join grading_plan p on p.run_id = s.run_id
         where j.status in ('pending', 'claimed')
           and jsonb_array_length(p.judge_credential_ids) > 0
      ) as grading
  `)) as unknown as { rows: readonly Record<string, boolean>[] };

  const [answer] = rows;
  if (answer === undefined) throw new Error("the upgrade conditions answered nothing");
  return UPGRADE_CONDITIONS.filter((condition) => answer[condition] === true);
}

async function storedMarker(): Promise<Date | null> {
  const [row] = await db()
    .select({ completedAt: modelUpgradeCompletion.completedAt })
    .from(modelUpgradeCompletion)
    .limit(1);
  return row?.completedAt ?? null;
}

/**
 * The marker as it stands, and what is outstanding while it is not written.
 *
 * **The read a drain check makes.** It asks nothing of the caller and writes
 * nothing, so it is safe from any process and at any moment — including from a
 * worker deciding whether it is still obliged to speak the old contract.
 *
 * Not authorized against an `AuthContext`, on `seedRunningGraders`' terms:
 * there is no customer here. Whether this deployment has finished an upgrade is
 * a fact about the deployment, it spans every organization on it, and there is
 * no organization a caller could name.
 */
export async function readModelUpgradeCompletion(): Promise<ModelUpgradeCompletion> {
  const completedAt = await storedMarker();
  if (completedAt !== null) {
    return { completed: true, completedAt, outstanding: [] };
  }
  return {
    completed: false,
    completedAt: null,
    outstanding: await outstandingConditions(),
  };
}

/**
 * Write the marker if — and only if — every condition holds.
 *
 * Called on boot, after the upgrade itself, so a deployment whose last legacy
 * persona was given selections this morning is marked complete at its next
 * restart rather than never. Idempotent: the row is one row and a second write
 * conflicts with itself and does nothing.
 */
export async function recordModelUpgradeCompletion(): Promise<ModelUpgradeCompletion> {
  const completedAt = await storedMarker();
  if (completedAt !== null) {
    return { completed: true, completedAt, outstanding: [] };
  }

  const outstanding = await outstandingConditions();
  if (outstanding.length > 0) {
    return { completed: false, completedAt: null, outstanding };
  }

  const [written] = await db()
    .insert(modelUpgradeCompletion)
    .values({ singleton: true, completedAt: new Date() })
    .onConflictDoNothing({ target: modelUpgradeCompletion.singleton })
    .returning({ completedAt: modelUpgradeCompletion.completedAt });

  return {
    completed: true,
    completedAt: written?.completedAt ?? (await storedMarker()),
    outstanding: [],
  };
}
