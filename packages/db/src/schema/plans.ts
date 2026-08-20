import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  unique,
} from "drizzle-orm/pg-core";

import { run } from "./runs.ts";
import { organization, project } from "./tenancy.ts";
import { user } from "./identity.ts";
import { createdAt, idText, moment, oneOf, prefixCheck } from "./columns.ts";

/**
 * The two things run creation has to write down beside the run itself: what
 * will judge it, and which request created it.
 *
 * They live together because they are the same kind of fact — a decision made
 * once, at the door, that nothing afterwards may quietly change — and because
 * neither belongs to the run's execution lifecycle, which `runs.ts` is about.
 */

/**
 * When a run's grading plan was decided, and whether one was decided at all.
 *
 * Three states, and the third is the honest one for history nobody can
 * reconstruct.
 *
 * - `run_start` — the plan was frozen in the transaction that created the run.
 *   Every run created from now on has this.
 * - `migration_snapshot` — the run predates frozen plans, and something about
 *   it was still outstanding when egma was upgraded: a nonterminal simulation,
 *   or a grading job still `pending` or `claimed`. The upgrade captured the
 *   plan as it stood *then*, because that work is about to be graded and has to
 *   be graded against something written down. `captured_at` says when, and a
 *   reader must be told it was captured during an upgrade rather than at start.
 * - `not_recorded` — the run predates frozen plans and had nothing outstanding.
 *   **No plan is invented for it.** Reconstructing one from today's graders
 *   would put a sentence on an old run claiming it was judged by things that
 *   may not have existed when it ran, and a page must never present that as a
 *   pin.
 */
export const GRADING_PLAN_STATES = [
  "run_start",
  "migration_snapshot",
  "not_recorded",
] as const;
export type GradingPlanState = (typeof GRADING_PLAN_STATES)[number];

export const gradingPlan = pgTable(
  "grading_plan",
  {
    id: idText("id").primaryKey(),
    /** One plan per run, and the unique below is what makes that true. */
    runId: idText("run_id").notNull(),
    organizationId: idText("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    projectId: idText("project_id").notNull(),
    state: text("state").notNull(),
    /**
     * When the plan below was decided. Null exactly on `not_recorded`, where
     * there is no plan and therefore no moment — the two are one fact and the
     * check holds them together.
     */
    capturedAt: moment("captured_at"),
    /**
     * The plan: groups under a tagged test reference, each holding its items.
     *
     * **A tagged union, never one nullable shape.** A group is either a pinned
     * test version or the one testless group an upgraded instance's older
     * simulations fall into, and an item is either an authored grader or a
     * built-in — and the two item shapes genuinely differ. An authored item has
     * a grader identity, a pinned grader version, an origin, a scope and one
     * priority for the whole item; the built-in has a reserved key and an
     * engine version, and its verdicts take their priority one at a time from
     * the behaviors of the pinned test version. Folding the two into one row of
     * mostly-null columns would make every reader guess which half applied.
     *
     * `access/run-plans.ts` owns the shape and is the only thing that writes
     * one. Empty on `not_recorded`, where the state is the whole answer.
     */
    groups: jsonb("groups").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    prefixCheck("grading_plan_id_prefix", table.id, "gpl"),
    oneOf("grading_plan_state_allowed", table.state, [...GRADING_PLAN_STATES]),
    // One plan per run: the plan is a property of the run, and a second one
    // would leave two answers to "what judges this" with nothing to choose
    // between them.
    unique("grading_plan_run_id_unique").on(table.runId),
    // A plan and the moment it was decided arrive together, and `not_recorded`
    // has neither. Held here so that no reader has to decide what an empty
    // plan with a timestamp would mean.
    check(
      "grading_plan_recorded_plans_carry_their_moment",
      sql`(${table.state} = 'not_recorded')
        = (${table.capturedAt} is null)`,
    ),
    check(
      "grading_plan_groups_are_a_list",
      sql`jsonb_typeof(${table.groups}) = 'array'`,
    ),
    // An unrecorded plan holds nothing at all, so nothing can be read off it
    // as though it were a pin.
    check(
      "grading_plan_unrecorded_holds_nothing",
      sql`${table.state} <> 'not_recorded'
        or ${table.groups} = '[]'::jsonb`,
    ),
    // The tenancy triangle, edge by edge, as everywhere else: the project is
    // this organization's, and the run is that project's.
    foreignKey({
      name: "grading_plan_project_organization_fk",
      columns: [table.projectId, table.organizationId],
      foreignColumns: [project.id, project.organizationId],
    }).onDelete("cascade"),
    foreignKey({
      name: "grading_plan_run_project_fk",
      columns: [table.runId, table.projectId],
      foreignColumns: [run.id, run.projectId],
    }).onDelete("cascade"),
    index("grading_plan_organization_id_project_id_idx").on(
      table.organizationId,
      table.projectId,
    ),
  ],
);

/**
 * The operations a client may safely send twice.
 *
 * **A run is the expensive kind of write**: it dials real telephony, spends a
 * real judge, and is the object a team's release gate reads. A browser that
 * retried a request whose answer was lost — a dropped connection, a proxy
 * timeout, somebody's second click — would produce a second run over the same
 * agent, and the two would disagree about nothing in particular while costing
 * twice.
 *
 * So the client names the attempt and egma remembers the name. The scope is
 * the organization, the project, the actor and the operation, because a key is
 * a word somebody's client chose and two people's clients may well choose the
 * same word: narrowing it to the actor is what stops one person's `retry-1`
 * from answering another's.
 *
 * The body is remembered as a digest rather than kept, because the point of
 * comparing is only to tell *the same request again* from *a different request
 * under a reused name* — and the second has to be refused out loud rather than
 * quietly answered with somebody else's run.
 */
export const IDEMPOTENT_OPERATIONS = ["start_run"] as const;
export type IdempotentOperation = (typeof IDEMPOTENT_OPERATIONS)[number];

export const idempotentOperation = pgTable(
  "idempotent_operation",
  {
    organizationId: idText("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    projectId: idText("project_id").notNull(),
    /**
     * Who sent it. Never nullable, unlike a run's `triggered_by`: a run of a
     * person since erased is still the team's record, but a key without an
     * actor could be reused across people and is not a key this table can hold.
     */
    actorId: idText("actor_id").notNull(),
    operation: text("operation").notNull(),
    /** The client's own word for this attempt. Opaque, and never egma's. */
    idempotencyKey: text("idempotency_key").notNull(),
    /**
     * A hex digest of the request this key first carried, so a reused key with
     * different contents is refused rather than answered with the first run.
     */
    requestDigest: text("request_digest").notNull(),
    /** What the first attempt produced — a `run_` id for `start_run`. */
    resultId: idText("result_id").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    // The scope *is* the identity: organization, project, actor, operation and
    // the key, exactly as the contract states it. A second row for the same
    // five is what the insert races against, and losing that race is how a
    // duplicate learns it is one.
    primaryKey({
      name: "idempotent_operation_pk",
      columns: [
        table.organizationId,
        table.projectId,
        table.actorId,
        table.operation,
        table.idempotencyKey,
      ],
    }),
    // The table's identity is the whole five-column key, so there is no id of
    // its own to pin. Its leading column is pinned instead — the shape the two
    // junction tables use, where the row's identity is a tuple and the half
    // this table owns is the one that carries the format.
    prefixCheck(
      "idempotent_operation_organization_id_prefix",
      table.organizationId,
      "org",
    ),
    oneOf("idempotent_operation_allowed", table.operation, [
      ...IDEMPOTENT_OPERATIONS,
    ]),
    check(
      "idempotent_operation_key_is_not_empty",
      sql`length(${table.idempotencyKey}) > 0`,
    ),
    foreignKey({
      name: "idempotent_operation_project_organization_fk",
      columns: [table.projectId, table.organizationId],
      foreignColumns: [project.id, project.organizationId],
    }).onDelete("cascade"),
    foreignKey({
      name: "idempotent_operation_actor_fk",
      columns: [table.actorId],
      foreignColumns: [user.id],
    }).onDelete("cascade"),
  ],
);
