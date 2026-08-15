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
  uniqueIndex,
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

/**
 * What a **library entry** is, which is a different question from what the
 * running copy above is — one word decides what the entry's definition holds
 * and which engine executes it.
 *
 * Two words in v0. `llm_as_judge` carries a `prompt` and an `output_definition`
 * and is executed by asking a model; `code` carries parameters a person fills
 * in at **Use** time and is executed by egma's own engine.
 *
 * Three more are **reserved and refused by the constraint below**, so a row can
 * never quietly hold one before the machinery that executes it exists — a
 * grader that nothing can run is a check somebody believes in that can never
 * fire, which is the false trust this product exists to kill. `human` is the
 * return path for corrections, writing verdict rows under its own grader id;
 * `ml_model` is unspecified; `external` is egma calling a customer's endpoint
 * and storing no code. Each is named here so the day one arrives is the day
 * this list grows by one word, rather than the day somebody invents a spelling.
 */
export const LIBRARY_TYPES = ["llm_as_judge", "code"] as const;
export type LibraryType = (typeof LIBRARY_TYPES)[number];

/**
 * The words the constraint turns away, written down beside the ones it takes.
 *
 * They are here rather than only in prose because a refusal has to be able to
 * say *this word is spoken for, and this is what it will mean* — which is a
 * different sentence from "egma has never heard of that".
 */
export const RESERVED_LIBRARY_TYPES = ["human", "ml_model", "external"] as const;
export type ReservedLibraryType = (typeof RESERVED_LIBRARY_TYPES)[number];

/**
 * How much source a custom `code` entry may carry, in bytes.
 *
 * Null in v0 — nothing writes it and no dispatcher exists to run it — and the
 * cap is written down now for the reason the mock tool's answer cap is: a limit
 * discovered at execution time is a limit somebody meets after they have
 * written the thing. A quarter of a mebibyte is the reference implementation's
 * (Langfuse stores customer eval code in a text column of this size), and code
 * that needs more than this is a service rather than a grader.
 */
export const LARGEST_GRADER_SOURCE_CODE_BYTES = 256 * 1024;

/**
 * The shelf: every grader definition, egma's own and — when custom authoring
 * arrives — a team's, in one table.
 *
 * **This is the one table whose tenancy is nullable and *means* it, and the
 * exception is the whole point.** Everywhere a customer's data lives, an
 * `organization_id` is `not null`, because a row belonging to nobody is a row
 * no permission can describe. Here, *belonging to nobody* is a real and
 * permanent state: **null tenancy means egma owns the entry**, which is what a
 * predefined grader is, and it is where the Owner label on the Library screen
 * is derived from rather than from a flag somebody could set the other way. The
 * alternative — a `predefined` boolean beside a tenancy pointing at some house
 * organization — would need a house organization on every deployment and would
 * let the two disagree.
 *
 * (`device_code` also leaves the pair null and means the opposite thing by it:
 * a terminal nobody has aimed yet, filled in at approval. Null as *not yet* and
 * null as *never* are two different decisions, which is why the schema's shape
 * suite names both tables and refuses a third.)
 *
 * The two columns move together, held by a check — the device code's own
 * arrangement, borrowed whole: an entry belongs to a project inside an
 * organization, or to egma. There is no third state, because a definition owned
 * by an organization and by no project would be a grader nothing could scope —
 * graders belong to a project, as tests and personas do.
 *
 * **Predefined entries are seeded by a deterministic upsert from a catalog in
 * egma's code** (`grader-library/catalog.ts`), so an egma release that improves
 * a judge prompt upgrades every project. That places predefined definitions
 * deliberately outside run pinning: they are product behaviour, release-tracked
 * exactly as the engine code executing beside them, and which definition judged
 * a given verdict is reconstructable from the catalog's git history plus this
 * row's `version`. Run pinning protects customer-authored meaning — test
 * versions and the running copy's filled-in config, both pinned — and custom
 * entries version and pin when authoring arrives.
 *
 * **The table name is plural-ish on purpose and is a recorded exception** to
 * the schema's singular naming: it names the shelf rather than one thing on it,
 * exactly as the reference implementation's `eval_templates` does.
 *
 * The definition is never copied down onto a running copy. A copy points here
 * by `library_id` and the definition is read through that pointer at judging
 * time — a copied definition drifts from the one on screen, which is the
 * documented failure this two-level shape exists to make unreachable.
 */
export const graderLibrary = pgTable(
  "grader_library",
  {
    id: idText("id").primaryKey(),
    /**
     * Null for an entry egma owns. See the table's own note: this is the
     * schema's one deliberate exception to hard-required tenancy, and the
     * Owner label is derived from it.
     */
    organizationId: idText("organization_id").references(
      () => organization.id,
      { onDelete: "cascade" },
    ),
    /** Null for an entry egma owns, and never null on its own. */
    projectId: idText("project_id"),
    /** What a person calls it: `expected_behaviors`, `latency`. */
    name: text("name").notNull(),
    description: text("description"),
    /** `llm_as_judge` or `code`; the reserved three are refused below. */
    type: text("type").notNull(),
    /**
     * How many times this definition has been written.
     *
     * **Bumped by the catalog upsert, and only when something actually
     * changed.** It is what makes "which prompt judged this verdict" answerable
     * against the catalog's history: the release that changed the words is the
     * release that moved this number. A run does not pin it, deliberately — see
     * the table's note.
     */
    version: integer("version").notNull().default(1),
    /**
     * The judge prompt, with its variable slots, for an `llm_as_judge` entry.
     * Null for a `code` entry, which is executed rather than asked.
     *
     * It lives on the row rather than only in the engine so that the Library
     * screen can show a developer the words their conversations are judged by.
     */
    prompt: text("prompt"),
    /**
     * The schema of what **Use** asks for, as an ordered list of parameter
     * declarations — latency declares a measure from the catalog and a bound;
     * expected_behaviors declares nothing, because its assertions are the
     * test's own sentences and wire themselves at judging time.
     *
     * jsonb rather than columns for the reason a persona's traits are: two
     * entries shape it two ways today and a third will shape it a third way,
     * and a field promoted to a column later is a cheap migration.
     */
    params: jsonb("params").notNull(),
    /**
     * The shape an `llm_as_judge` entry's judge must answer in — `{score,
     * rationale}` — so that what the engine reads back and what the Library
     * screen promises are one statement. Null for a `code` entry.
     */
    outputDefinition: jsonb("output_definition"),
    /**
     * A custom `code` entry's own source, and the language it is written in.
     *
     * **Both null in v0**, and reserved rather than speculative: `code` today
     * means egma's own engine executing a parameterised definition with no
     * stored source, and customer code arrives with a dispatcher seam to run it
     * safely. The columns are here so that arriving is an insert rather than a
     * migration, and the cap beside them is the reference implementation's.
     */
    sourceCode: text("source_code"),
    sourceCodeLanguage: text("source_code_language"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    prefixCheck("grader_library_id_prefix", table.id, "grl"),
    // Two words, and the reserved three refused by name: a row holding a type
    // no engine executes is a grader that can never fire.
    oneOf("grader_library_type_allowed", table.type, [...LIBRARY_TYPES]),
    // The nullable-tenancy exception, bounded: an entry belongs to a project
    // inside an organization, or it belongs to egma. Written as a check rather
    // than left to convention, because "owned by nobody" is a real state here
    // and only the database can keep it from becoming three states.
    check(
      "grader_library_tenancy_is_whole_or_egmas",
      sql`(${table.organizationId} is null) = (${table.projectId} is null)`,
    ),
    // The cap on a custom entry's source, held where a hand-written insert
    // meets it too.
    check(
      "grader_library_source_code_within_budget",
      sql`${table.sourceCode} is null or octet_length(${table.sourceCode}) <= ${sql.raw(
        String(LARGEST_GRADER_SOURCE_CODE_BYTES),
      )}`,
    ),
    // A language names source, and source names a language: a row carrying one
    // without the other is half a definition.
    check(
      "grader_library_source_code_columns_agree",
      sql`(${table.sourceCode} is null) = (${table.sourceCodeLanguage} is null)`,
    ),
    // The pairing, not each column on its own: an entry cannot name one
    // organization and another organization's project. Both null skips it,
    // which is exactly the egma-owned row.
    foreignKey({
      name: "grader_library_project_organization_fk",
      columns: [table.projectId, table.organizationId],
      foreignColumns: [project.id, project.organizationId],
    }).onDelete("cascade"),
    // One predefined entry per name, held by the database rather than by the
    // catalog's author: two egma-owned entries called `latency` would be two
    // shelves' worth of one thing, and the second would be seeded by an id
    // somebody duplicated.
    uniqueIndex("grader_library_predefined_name_unique")
      .on(table.name)
      .where(sql`${table.organizationId} is null`),
    index("grader_library_organization_id_project_id_idx").on(
      table.organizationId,
      table.projectId,
    ),
  ],
);

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
    /**
     * The sealed envelope, never the key. Never selected by any read; the one
     * opener is the access layer's judge-key resolver, and the only caller of
     * that is egma's own grading engine.
     */
    credentials: text("credentials").notNull(),
    /** The last characters of the key, kept so a person can tell two apart. */
    credentialsHint: text("credentials_hint").notNull(),
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
