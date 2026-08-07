import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

import { organization, project } from "./tenancy.ts";
import { user } from "./identity.ts";
import {
  createdAt,
  idText,
  moment,
  oneOf,
  prefixCheck,
  updatedAt,
} from "./columns.ts";

/**
 * A grader is authored logic that produces a verdict. A metric measures and a
 * grader judges: nobody decided that a call took four minutes, but somebody had
 * to decide that verifying identity before disclosing a balance matters and
 * write the criteria down. These tables hold that decision.
 *
 * Graders belong to a project and apply to every one of its tests by default,
 * and to production conversations when their scope says so. A test's own grader
 * array adds scenario-specific ones on top; there is no second kind of grader
 * and none of this is ever attached to a suite, so a test's verdict can never
 * depend on which suite it was run from.
 *
 * Two tables, the persona's and the test's shape exactly, so that two different
 * things can be pointed at — and here the split carries more weight than
 * anywhere else in the schema. **What a grader judges by is versioned; where and
 * how loudly it applies is not.** Tightening a threshold changes what a verdict
 * means, so it mints an immutable version and takes effect from now on, leaving
 * last week's run saying exactly what it said. Promoting a grader from P1 to P0,
 * pointing it at production, or sampling it differently changes nothing about
 * any judgment already made, so those live on the identity row and take effect
 * everywhere the moment they are written.
 */

/**
 * What kind of judgment this is. Anthropic's nomenclature, at the dev's
 * direction, and flat rather than nested: one word decides what the config
 * holds and how the engine executes it.
 *
 * `expected_behaviors` is deliberately absent. The built-in that judges a test
 * against its own expected behaviors is implicit and always-on — applying it is
 * part of what running a test means — so it is never attached, never detached,
 * and never a row here (ADR-0004). Reserved and named for later: `state_check`,
 * which verifies the end state through a customer's own hooks, and `code`, which
 * runs a customer's own logic.
 */
export const GRADER_TYPES = [
  "llm_rubric",
  "metric_threshold",
  "tool_calls",
  "phrase_match",
] as const;
export type GraderType = (typeof GRADER_TYPES)[number];

/**
 * How loudly a judgment speaks: P0 blocks, P1 warns, P2 informs. A run's
 * headline reads "all P0 passed, two P1 warnings" rather than one
 * undifferentiated failure.
 *
 * The same three words carry the priority a test's expected behaviors each
 * carry, which is why they live here beside the grader rather than inside it —
 * one vocabulary for "how much does this matter", asked of authored logic and
 * of a written-down expectation alike.
 */
export const PRIORITIES = ["P0", "P1", "P2"] as const;
export type Priority = (typeof PRIORITIES)[number];

/**
 * Which conversations a grader judges. The same grader judges simulations and
 * production traces — "tested against" and "monitored for" are one vocabulary —
 * and where it applies is its own setting.
 *
 * `simulations` is the default because production grading spends money on
 * traffic nobody triggered, and that has to be a deliberate choice rather than
 * a surprise on a bill.
 */
export const GRADER_SCOPES = ["simulations", "production", "both"] as const;
export type GraderScope = (typeof GRADER_SCOPES)[number];

export const grader = pgTable(
  "grader",
  {
    id: idText("id").primaryKey(),
    organizationId: idText("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    projectId: idText("project_id").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    /**
     * Set at creation and never edited. The config in every version is shaped
     * by this word, so changing it would leave the versions behind it holding
     * parameters for a kind of judgment this grader no longer makes — which is
     * a different grader wearing the old one's history.
     */
    type: text("type").notNull(),
    priority: text("priority").notNull(),
    scope: text("scope").notNull().default("simulations"),
    /** Per cent of production conversations judged; simulations are all judged. */
    productionSampleRate: integer("production_sample_rate")
      .notNull()
      .default(100),
    /**
     * How far this grader has got towards its next sampled trace, in the same
     * per cent the rate is written in — **an accumulator, deliberately not a
     * coin toss**.
     *
     * Every completed production trace adds the rate to it, and crossing a
     * hundred is this grader's turn and takes a hundred back off. So a quarter
     * is literally every fourth trace, and a rate that divides a hundred less
     * neatly spends exactly what it accumulates and carries the remainder into
     * the next stretch rather than rounding it away. A customer who chose 25%
     * and watched four calls go by can point at the one that was judged.
     * Randomness would bill the same in the long run and would make every
     * skipped call unanswerable: "why was that one not judged" deserves a better
     * answer than "it did not come up".
     *
     * A column rather than a table of its own, because it belongs to exactly one
     * grader and is exactly one number. It is not versioned for the reason the
     * rate beside it is not — how often a grader ran changes nothing about what
     * any verdict already meant — and nothing that moves it touches
     * `updated_at`, which says when somebody last *changed* this grader.
     * Ordinary traffic is not an edit.
     */
    productionSampleAccumulator: integer("production_sample_accumulator")
      .notNull()
      .default(0),
    /**
     * Circular with the version table on purpose; the constraint is deferred so
     * create can insert both rows in one transaction.
     */
    currentVersionId: idText("current_version_id")
      .notNull()
      .references((): AnyPgColumn => graderVersion.id),
    deletedAt: moment("deleted_at"),
    createdBy: idText("created_by").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    prefixCheck("grader_id_prefix", table.id, "grd"),
    oneOf("grader_type_allowed", table.type, [...GRADER_TYPES]),
    oneOf("grader_priority_allowed", table.priority, [...PRIORITIES]),
    oneOf("grader_scope_allowed", table.scope, [...GRADER_SCOPES]),
    // A sampling rate is a percentage of the traffic that arrives, so the two
    // ends are "none of it" and "all of it" and there is nothing outside them.
    check(
      "grader_production_sample_rate_is_a_percentage",
      sql`${table.productionSampleRate} between 0 and 100`,
    ),
    // What is left after the last hundred was taken off, so it is a remainder
    // and never reaches a hundred itself.
    check(
      "grader_production_sample_accumulator_is_a_remainder",
      sql`${table.productionSampleAccumulator} between 0 and 99`,
    ),
    // The pairing, not each column on its own: a grader cannot name one
    // organization and another organization's project.
    foreignKey({
      name: "grader_project_organization_fk",
      columns: [table.projectId, table.organizationId],
      foreignColumns: [project.id, project.organizationId],
    }).onDelete("cascade"),
    index("grader_organization_id_project_id_idx")
      .on(table.organizationId, table.projectId)
      .where(sql`${table.deletedAt} is null`),
  ],
);

export const graderVersion = pgTable(
  "grader_version",
  {
    id: idText("id").primaryKey(),
    graderId: idText("grader_id")
      .notNull()
      .references(() => grader.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    /**
     * Everything the judgment is made by: the rubric text for an `llm_rubric`,
     * the parameters for a deterministic type. Deliberately jsonb, for the
     * reason a persona's traits and a test's content are: four types shape it
     * four ways today and reserved types will shape it more, and a field
     * promoted to a column later is a cheap migration.
     */
    config: jsonb("config").notNull(),
    /**
     * The judge this grader insists on, overriding the project's default —
     * provider and model, never a key. Null means the project's choice, which is
     * what nearly every grader wants: a cheap judge for the routine checks, and
     * a stronger one named here on the subtle rubric that needs it.
     */
    judgeModel: jsonb("judge_model"),
    createdBy: idText("created_by").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
  },
  (table) => [
    prefixCheck("grader_version_id_prefix", table.id, "grv"),
    unique("grader_version_grader_id_version_unique").on(
      table.graderId,
      table.version,
    ),
  ],
);
