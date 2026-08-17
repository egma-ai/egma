import { and, eq, isNull, sql } from "drizzle-orm";

import { db } from "../client.ts";
import { platformInstance } from "../schema/platform.ts";
import { platformInstanceId } from "./instance.ts";

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
 * **The stamp is written once and never withdrawn, and it is not a
 * permission.** It records the first moment every condition held. During the
 * compatibility period the ordinary authoring doors still write personas and
 * graders with no selections, so a stamped installation can legitimately go
 * back to having outstanding work — which is why the read below re-evaluates
 * every condition on every call and answers `completed` from that, never from
 * the stamp. Anything deciding whether a legacy path may be removed must ask
 * this door and act on its answer, not on the presence of a timestamp.
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
   * Some grading job that has not finished still resolves through the legacy
   * judge path — either its run's frozen plan names a judge credential, or the
   * plan pins a grader version that carries no selection of its own and will
   * therefore ask the project's judge configuration when it runs.
   *
   * **Both halves, and the second is the one that is easy to miss.** A plan
   * judged by the *deployment's* own judge names no credential at all — the
   * plan stores the `platform` sentinel rather than an id, so the credential
   * index is empty — and a marker that only read that index would declare a
   * deployment finished while grading jobs were still queued behind exactly
   * the configuration the next release removes.
   */
  "grading",
] as const;
export type UpgradeCondition = (typeof UPGRADE_CONDITIONS)[number];

export type ModelUpgradeCompletion = {
  /**
   * Whether the conditions hold **now**, evaluated freshly on every read.
   *
   * **Never read off the stamp, and that is the whole rule.** The stamp says
   * when the conditions first held; it does not say they still do. During the
   * compatibility period the ordinary authoring doors can still write a persona
   * or a grader with no selections — that is what makes the period a period —
   * so a stamped installation can legitimately acquire new legacy-shaped work
   * the day after it was stamped. Anything that acts on this must ask, not
   * remember.
   */
  readonly completed: boolean;
  /**
   * When the conditions were first all true, or null while they never have
   * been. It is a record of a moment and never a permission.
   */
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
           and (
             jsonb_array_length(p.judge_credential_ids) > 0
             or exists (
               select 1
                 from jsonb_array_elements(p.groups) as grp
                 cross join lateral jsonb_array_elements(grp->'items') as item
                 join grader_version gv on gv.id = item->>'graderVersionId'
                where item->'judge'->>'tag' = 'configured'
                  and gv.grader_model is null
             )
           )
      ) as grading
  `)) as unknown as { rows: readonly Record<string, boolean>[] };

  const [answer] = rows;
  if (answer === undefined) throw new Error("the upgrade conditions answered nothing");
  return UPGRADE_CONDITIONS.filter((condition) => answer[condition] === true);
}

/**
 * The stamp as it stands, read off the row that means "this installation".
 *
 * A missing row is a missing marker rather than a fault: an installation that
 * has never answered its own identity has never been asked anything, so it has
 * certainly not finished.
 */
async function storedMarker(): Promise<Date | null> {
  const [row] = await db()
    .select({ completedAt: platformInstance.modelUpgradeCompletedAt })
    .from(platformInstance)
    .where(eq(platformInstance.singleton, true))
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
  // Both, always, and in that order: the conditions as they are now, and the
  // moment they first held. A read that short-circuited on the stamp would be
  // the one thing this type's own documentation forbids.
  const [outstanding, completedAt] = await Promise.all([
    outstandingConditions(),
    storedMarker(),
  ]);

  return { completed: outstanding.length === 0, completedAt, outstanding };
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
  const outstanding = await outstandingConditions();
  const completedAt = await storedMarker();

  if (outstanding.length > 0) {
    // Stamped already and no longer clear: the stamp stays, because it records
    // a moment that really happened, and the answer says what is standing now.
    return { completed: false, completedAt, outstanding };
  }
  if (completedAt !== null) {
    return { completed: true, completedAt, outstanding: [] };
  }

  // The identity row is minted here if this installation has never answered its
  // own identity, which is the ordinary state of a deployment whose public
  // route nobody has called yet.
  await platformInstanceId();

  const now = new Date();
  const [written] = await db()
    .update(platformInstance)
    .set({ modelUpgradeCompletedAt: now })
    .where(
      and(
        eq(platformInstance.singleton, true),
        isNull(platformInstance.modelUpgradeCompletedAt),
      ),
    )
    .returning({ completedAt: platformInstance.modelUpgradeCompletedAt });

  return {
    completed: true,
    // The row a concurrent boot stamped first, where this update matched
    // nothing: two replicas finishing together settle on one moment rather than
    // on whichever wrote last.
    completedAt: written?.completedAt ?? (await storedMarker()),
    outstanding: [],
  };
}
