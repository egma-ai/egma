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

import { MODALITIES } from "./agents.ts";
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

/**
 * What a grader is allowed to look at — its evidence boundary, declared rather
 * than discovered.
 *
 * It is **versioned content**, beside the config and for the same reason:
 * widening what a check reads changes what its verdict meant, and a verdict
 * decided on the transcript alone must stay readable as exactly that after
 * somebody points the same grader at the outcome as well.
 *
 * The three deterministic types have theirs fixed by the registry — a
 * `metric_threshold` reads measures because that is what a threshold *is* — and
 * only `llm_rubric` chooses, because only a rubric's author knows which
 * evidence their criteria are written about.
 */
export const GRADER_READS = [
  "transcript",
  "outcome",
  "tool_calls",
  "measures",
] as const;
export type GraderRead = (typeof GRADER_READS)[number];

/**
 * The judges egma can ask. It grows one provider at a time, behind one seam,
 * and the list is here beside the other closed vocabularies because two tables
 * hold it: the project's default judge below, and the per-grader override on a
 * version row.
 */
export const JUDGE_PROVIDERS = ["openai"] as const;
export type JudgeProvider = (typeof JUDGE_PROVIDERS)[number];

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
    /**
     * The opaque revision of everything on this row that is live rather than
     * versioned — the name, the description, the priority, the scope, the
     * sampling rate, and whether it is archived.
     *
     * **Minted fresh on every write, never derived.** A revision computed from
     * the row's own fields would repeat itself the moment somebody renamed a
     * grader back, and an edit written against the first spelling would then be
     * accepted against the second. It is opaque so that nothing outside can do
     * arithmetic on it or guess the next one.
     *
     * The version pointer beside it answers the other half of the same
     * question: a live edit carries `expected_revision`, and a versioned edit
     * carries the version it was written against as well. Two fields because
     * they move independently — renaming a grader must not make a rubric edit
     * somebody is still typing stale.
     */
    revision: idText("revision").notNull(),
    deletedAt: moment("deleted_at"),
    createdBy: idText("created_by").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    prefixCheck("grader_id_prefix", table.id, "grd"),
    prefixCheck("grader_revision_prefix", table.revision, "rev"),
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

/**
 * Where a project's judge gets its key from. Two words, and the difference is
 * whose account is spent.
 *
 * - `credential` — an organization judge credential the customer created and
 *   can rotate. The row stores its `jcr_` id and no secret at all.
 * - `platform` — the deployment's own judge, given to a project that had
 *   configured none. It is **not customer-readable and has no rotating UI**:
 *   the operator who configured the deployment owns it, and a project that
 *   holds it holds a pointer at the deployment rather than at a key of its own.
 *
 * The deployment's sealed key stays on the row for a `platform` setting because
 * that is where seeding has always put it, and seeding is the one path that
 * must not be disturbed — it writes inside the transaction that creates a
 * project and again in the boot backfill, both `onConflictDoNothing`, which is
 * the whole of the promise that a project's chosen judge is never replaced.
 * Nothing customer-facing reads it: the browser is told the source is the
 * platform and is offered no hint and no rotation.
 *
 * A project with **no row at all** is `needs_setup`, which is a state rather
 * than a fault: it says LLM grading is unavailable until an admin finishes
 * setup, and the run door refuses to start work that would need a judge.
 */
export const JUDGE_SOURCES = ["credential", "platform"] as const;
export type JudgeSource = (typeof JUDGE_SOURCES)[number];

/**
 * The judge a project's judged graders run on, and the one key they speak with.
 *
 * **One row per project**, because "which model judges here" is one answer for
 * a whole product area rather than a decision anybody makes per check. The
 * `judge_model` on a version row is the exception, written down: it overrides
 * the provider and the model and never the key, so bringing your own judge
 * costs one secret rather than one per grader.
 *
 * **A table of its own rather than four columns on `project`, and the secret is
 * the reason.** The project row is read whenever a session is resolved and
 * whenever a list of projects is drawn; a sealed key sitting on it would be one
 * careless `select *` away from a log line. The tenancy tables hold no secret
 * today and this keeps it that way. `organization_settings` is this same shape
 * one level up and for the same kind of reason: something a tenant may or may
 * not have configured, keyed by the row it belongs to and read only by what
 * needs it.
 *
 * The sealed envelope is the connection's, verbatim — the same `v1.<iv>.<
 * ciphertext>.<tag>` under the same master key, opened in one place. A judge key
 * cannot be hashed for the reason a provider credential cannot: egma has to
 * replay it to OpenAI every time it judges.
 */
export const judgeConfiguration = pgTable(
  "judge_configuration",
  {
    /**
     * The project this is the judge for, and the row's whole identity — there
     * is one judge configuration per project or none, so there is no second
     * identifier to mint and none to name wrongly.
     */
    projectId: idText("project_id").primaryKey(),
    organizationId: idText("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    /** The judge model's own name, as the provider spells it. */
    model: text("model").notNull(),
    /** Where the key comes from. See `JUDGE_SOURCES`. */
    source: text("source").notNull(),
    /**
     * The organization credential this project spends from, for a `credential`
     * setting — a reference and never a second copy of the secret. Null for the
     * deployment's own `platform` judge.
     */
    credentialId: idText("credential_id").references(
      (): AnyPgColumn => judgeCredential.id,
    ),
    /**
     * The deployment's own sealed key, for a `platform` setting alone, written
     * only by egma's seeding. Null for a `credential` setting, where the
     * envelope lives on the credential and this row holds no secret at all.
     */
    credentials: text("credentials"),
    /**
     * The last characters of the deployment's key. Null for a `credential`
     * setting: its hint belongs to the credential, and nothing customer-facing
     * hints at the platform's key at all.
     */
    credentialsHint: text("credentials_hint"),
    createdBy: idText("created_by").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    prefixCheck("judge_configuration_project_id_prefix", table.projectId, "prj"),
    oneOf("judge_configuration_provider_allowed", table.provider, [
      ...JUDGE_PROVIDERS,
    ]),
    oneOf("judge_configuration_source_allowed", table.source, [
      ...JUDGE_SOURCES,
    ]),
    /**
     * Exactly one place a key can come from, held by the database rather than
     * by whoever writes the row. A `credential` setting that also carried an
     * envelope would be two secrets with no rule saying which is spent, and a
     * `platform` setting with no envelope would be a project that reads as
     * judged and cannot judge.
     */
    check(
      "judge_configuration_has_one_key_source",
      sql`(${table.source} = 'credential' and ${table.credentialId} is not null and ${table.credentials} is null and ${table.credentialsHint} is null) or (${table.source} = 'platform' and ${table.credentialId} is null and ${table.credentials} is not null)`,
    ),
    // The pairing, not each column on its own: a judge configuration cannot
    // name one organization and another organization's project.
    foreignKey({
      name: "judge_configuration_project_organization_fk",
      columns: [table.projectId, table.organizationId],
      foreignColumns: [project.id, project.organizationId],
    }).onDelete("cascade"),
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
    /**
     * What this version of the grader is allowed to look at, from
     * `GRADER_READS`. Nonempty, always: a grader that reads nothing can decide
     * nothing, and storing the empty set would make "reads everything" and
     * "reads nothing" one value.
     */
    reads: text("reads").array().notNull(),
    /**
     * Which modalities this version can score, from `MODALITIES`. Nonempty for
     * the reason above, and defaulted to both at every write door — because a
     * grader that named neither would be `skipped` on every conversation
     * forever, which is a check somebody wrote and believes in that can never
     * fire.
     *
     * A grader whose set excludes the conversation's modality is **`skipped`**,
     * never failed. "Didn't interrupt the caller" is meaningless on chat, and
     * scoring it as a failure would make a suite red for a check that was never
     * about that conversation.
     */
    modalities: text("modalities").array().notNull(),
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
    // Nonempty, and drawn from the settled lists. Both halves are here rather
    // than only at the write door because an old row is read back as a
    // vocabulary the engine dispatches on, and a value nothing ever offered
    // would be a grader silently skipping everything.
    check(
      "grader_version_reads_are_a_nonempty_known_set",
      sql`array_length(${table.reads}, 1) >= 1 and ${table.reads} <@ ${sql.raw(`array[${GRADER_READS.map((read) => `'${read}'`).join(", ")}]::text[]`)}`,
    ),
    check(
      "grader_version_modalities_are_a_nonempty_known_set",
      sql`array_length(${table.modalities}, 1) >= 1 and ${table.modalities} <@ ${sql.raw(`array[${MODALITIES.map((modality) => `'${modality}'`).join(", ")}]::text[]`)}`,
    ),
  ],
);

/**
 * An organization's judge credential: a label, a provider, and the sealed key
 * egma replays to that provider every time it judges.
 *
 * **It belongs to the organization and not to a project**, which is the whole
 * change this table makes. A key is a billing relationship with a model
 * provider, and billing attaches to the customer — so one key can serve every
 * project, and an organization that genuinely has two accounts holds two
 * credentials and points each project at the one it should spend from. The
 * project stores a *reference*; it never holds a second copy of the secret.
 *
 * **The secret is write-only and there is no read that returns it.** `COLUMNS`
 * in the access module names every column an answer may carry and the envelope
 * is not among them, so the field is absent from the read shape rather than
 * blanked — leaking one through a serializer is not a thing anybody can forget.
 * Rotation replaces the whole envelope: it is sealed over the whole value, so
 * there is no shape in which one could be edited in place, and an admin
 * replacing a key never has to read the one they are replacing.
 *
 * **What a person may see is the hint**, the last few characters, which exists
 * for exactly one job: telling two keys apart when deciding which project
 * should spend from which. It is not enough of the secret to be one.
 *
 * `archived_at` is here and is deliberately **not exposed by any route yet**.
 * Archiving a credential has to be refused while an active project points at
 * it, while a nonterminal simulation's frozen plan names it, and while a
 * claimed grading job still needs it — and frozen grading plans arrive with the
 * run-planning effort. A column with no safe door is honest; a door with no
 * protection behind it would strand work mid-flight.
 */
export const judgeCredential = pgTable(
  "judge_credential",
  {
    id: idText("id").primaryKey(),
    organizationId: idText("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    /** What a person calls it — "Acme production key". Never unique. */
    label: text("label").notNull(),
    /**
     * Immutable. The key belongs to one provider's account, so changing this
     * would be a different credential wearing the old one's identity — and
     * every project pointing at it would silently start spending somewhere
     * else.
     */
    provider: text("provider").notNull(),
    /** The sealed envelope, never the key. Named by no read. */
    credentials: text("credentials").notNull(),
    /** The last characters of the key, so two keys can be told apart. */
    credentialsHint: text("credentials_hint").notNull(),
    revision: idText("revision").notNull(),
    /** Set by nothing yet; see this table's note. */
    archivedAt: moment("archived_at"),
    createdBy: idText("created_by").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    prefixCheck("judge_credential_id_prefix", table.id, "jcr"),
    prefixCheck("judge_credential_revision_prefix", table.revision, "rev"),
    oneOf("judge_credential_provider_allowed", table.provider, [
      ...JUDGE_PROVIDERS,
    ]),
    index("judge_credential_organization_id_idx")
      .on(table.organizationId)
      .where(sql`${table.archivedAt} is null`),
  ],
);
