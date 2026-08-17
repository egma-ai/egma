import { eq, sql } from "drizzle-orm";

import { db } from "../client.ts";
import { platformInstance } from "../schema/platform.ts";
import { platformInstanceId } from "./instance.ts";
import { UPGRADING_MODEL_SETUP } from "./model-upgrade.ts";

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

/**
 * The four conditions, as one SQL expression each.
 *
 * **Written once and used twice**: to *report* what is standing, and — inside
 * the very statement that writes the stamp — to decide whether it may be
 * written at all. A second copy of these predicates is a second thing that can
 * disagree with the one that actually gates the marker, and the one that gates
 * it is the one that matters.
 */
const CONDITIONS = {
  personas: sql`exists (
    select 1 from persona p
      join persona_version v on v.id = p.current_version_id
     where v.models is null
  )`,
  graders: sql`exists (
    select 1 from grader g
      join grader_version gv on gv.id = g.current_version_id
     where g.type = 'llm_as_judge'
       and g.deleted_at is null and gv.grader_model is null
  )`,
  simulations: sql`exists (
    select 1 from simulation s
      join persona_version v on v.id = s.persona_version_id
     where s.status in ('queued', 'claimed', 'running') and v.models is null
  )`,
  grading: sql`exists (
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
  )`,
} as const satisfies Record<UpgradeCondition, unknown>;

/** Whether each condition still has work behind it. */
async function outstandingConditions(): Promise<readonly UpgradeCondition[]> {
  const { rows } = (await db().execute(sql`
    select
      ${CONDITIONS.personas} as personas,
      ${CONDITIONS.graders} as graders,
      ${CONDITIONS.simulations} as simulations,
      ${CONDITIONS.grading} as grading
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

  /**
   * The conditions and the stamp, decided by **one statement**.
   *
   * **A read followed by a write is two moments, and the stamp is a permanent
   * record of one.** Another replica serving this database can commit a
   * selection-free persona between them — ordinary authoring, still legal for
   * the whole compatibility period — and the timestamp would then memorialise a
   * state that never simultaneously held. Nothing is *stranded* by that,
   * because every read re-evaluates and the cleanup release is required to as
   * well; but a permanent record of a moment that never happened is still
   * wrong, and it is a record operators and a later release read.
   *
   * So the conditions are re-asserted in the `where` of the update that writes
   * the stamp. One statement takes one snapshot: work committed before it began
   * is seen and the stamp is refused, and work committed after it began was not
   * yet true at the moment the stamp names. Either way the timestamp is honest.
   *
   * **`statement_timestamp()` rather than `now()`, and the difference is the
   * whole point of the sentence above.** In Postgres `now()` is the
   * *transaction's* start, and this transaction waits on an advisory lock
   * before its update runs — so `now()` would stamp a moment before the
   * predicate that justifies it was ever evaluated, by however long the wait
   * lasted. Seconds, in practice. But this is a permanent record that a later
   * release and an operator both read as "everything was clear at this time",
   * and a record must not name a moment before its own evidence.
   *
   * The advisory lock is the upgrade act's own, so a boot's upgrade and the
   * marker that follows it cannot interleave with another replica's.
   */
  return db().transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${UPGRADING_MODEL_SETUP}::text, 0))`,
    );

    const { rows } = (await tx.execute(sql`
      update platform_instance
         set model_upgrade_completed_at = statement_timestamp()
       where singleton
         and model_upgrade_completed_at is null
         and not ${CONDITIONS.personas}
         and not ${CONDITIONS.graders}
         and not ${CONDITIONS.simulations}
         and not ${CONDITIONS.grading}
      returning model_upgrade_completed_at
    `)) as unknown as {
      // A raw statement, so the driver hands back what Postgres wrote rather
      // than what a typed column read would have parsed. Read as a string and
      // turned into the moment it names, once, here.
      rows: readonly { model_upgrade_completed_at: string }[];
    };

    const [stamped] = rows;
    if (stamped !== undefined) {
      return {
        completed: true,
        completedAt: new Date(stamped.model_upgrade_completed_at),
        outstanding: [],
      };
    }

    // Nothing was written, and there are two ways that happens: a concurrent
    // boot stamped it first, or a condition stopped holding between the report
    // above and this statement. Reading both back says which, and neither is a
    // fault.
    const [row] = await tx
      .select({ completedAt: platformInstance.modelUpgradeCompletedAt })
      .from(platformInstance)
      .where(eq(platformInstance.singleton, true))
      .limit(1);
    const settled = row?.completedAt ?? null;
    const standing = await outstandingConditions();
    return {
      completed: settled !== null && standing.length === 0,
      completedAt: settled,
      outstanding: standing,
    };
  });
}
