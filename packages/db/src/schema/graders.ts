import { sql } from "drizzle-orm";
import {
  boolean,
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
 * A grader is a **running copy** of a library entry: the row that judges, and
 * the thing a verdict row names. A metric measures and a grader judges — nobody
 * decided that a call took four minutes, but somebody had to decide that
 * verifying identity before disclosing a balance matters and write the criteria
 * down. The criteria live on the shelf below; these tables hold the decision to
 * run them here.
 *
 * Graders belong to a project and apply to every one of its tests inside their
 * scope, and to production conversations when their scope says so. There is no
 * per-test attachment and none of this is ever attached to a suite, so a test's
 * verdict can never depend on which suite it was run from.
 *
 * Two tables, the persona's and the test's shape exactly, so that two different
 * things can be pointed at — and here the split carries more weight than
 * anywhere else in the schema. **What a grader judges by is versioned; where and
 * how loudly it applies is not.** Tightening a bound changes what a verdict
 * means, so it mints an immutable version and takes effect from now on, leaving
 * last week's run saying exactly what it said. Making a grader a diagnostic,
 * pointing it at production, or sampling it differently changes nothing about
 * any judgment already made, so those live on the identity row and take effect
 * everywhere the moment they are written.
 */

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
 * What a **library entry** is, and what the running copy that was made from it
 * is too — one word, copied down at Use time and frozen there, deciding what
 * the entry's definition holds and which engine executes it.
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
     * The shape an `llm_as_judge` entry's judge must **reply** in — the
     * decision, its one-sentence reason, and the turns it rests on — so that
     * what the prompt above commands, what the engine parses, and what the
     * Library screen promises are one statement. Null for a `code` entry.
     *
     * It describes the *judge's answer*, not the verdict row written from it:
     * a row carries a verdict and a score, exists for assertions no judge was
     * ever asked about, and turns `cannot_determine` into `skipped`. Two
     * documents, and this column is the first one.
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

/**
 * The running copies: one row per grader a project actually judges with.
 *
 * A copy is made by pressing **Use** on a library entry, or seeded at project
 * creation. It carries the *deployment* — where it applies, how loudly, how
 * often — and its **filled-in values** in immutable versions. It does not carry
 * the definition, and that is the shape's whole reason for existing: the judge
 * prompt and the code are read through `library_id` at judging time, so what
 * the Library screen shows and what a judge is sent can never be two different
 * strings. A definition copied down drifts from the one on screen, which is the
 * documented failure this arrangement makes unreachable.
 *
 * **Dormant is no row at all.** There is no enable switch and no `none` scope:
 * pressing Use is the enabling, and deleting the copy is the switching off.
 */
export const grader = pgTable(
  "grader",
  {
    id: idText("id").primaryKey(),
    organizationId: idText("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    projectId: idText("project_id").notNull(),
    /**
     * The entry this is a copy of — **the connecting tissue, and never null**.
     *
     * A grader with no entry would be a row with no definition to read at
     * judging time, which is not a grader at all. `restrict` rather than
     * `set null` for the same reason: an entry somebody deleted while a project
     * was judging with it must be refused, not quietly orphaned, because the
     * copy would go on being resolved and would find nothing to judge by. The
     * refusal is written in the access layer too, where it can name the copies
     * standing in the way; this is the backstop that makes the rule true of the
     * database rather than only of the code above it.
     */
    libraryId: idText("library_id")
      .notNull()
      .references(() => graderLibrary.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    description: text("description"),
    /**
     * Copied from the entry at Use time and never edited. The config in every
     * version is shaped by this word, so changing it would leave the versions
     * behind it holding parameters for a kind of judgment this grader no longer
     * makes — which is a different grader wearing the old one's history.
     */
    type: text("type").notNull(),
    /**
     * Whether a test can pass while this copy does not.
     *
     * `true` — the default, and what a copy somebody switched on is for: the
     * test cannot pass unless this grader fully passes. `false` makes it a
     * **diagnostic**: judged, displayed with its fraction, and unable to fail
     * anything. Those are the two roles v0 has, and they are what is left where
     * the P0/P1/P2 ladder was — a boolean rather than three words, because
     * binary scoring leaves a middle rung nothing to say.
     *
     * A live setting rather than versioned content, on the scope's exact terms:
     * making a blocker into a diagnostic changes nothing about any judgment
     * already made, so it is written in place and takes effect everywhere at
     * once. What the row said last week still says it.
     */
    required: boolean("required").notNull().default(true),
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
    // The entry's own two words, and the reserved three refused by name here
    // exactly as they are on the shelf: a copy is only ever made by copying a
    // type down, so the two lists are one list and the database says so.
    oneOf("grader_type_allowed", table.type, [...LIBRARY_TYPES]),
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
    // Which copies point at an entry, asked every time somebody tries to take
    // that entry off the shelf, and asked again by the backfill that gives a
    // project the one copy it must have.
    index("grader_library_id_idx").on(table.libraryId),
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
     * The copy's **filled-in values** — one set per assertion, each answering
     * the parameters its library entry declares. Latency's are a measure and a
     * bound; expected_behaviors' are empty, because its assertions are the
     * test's own sentences and arrive at judging time.
     *
     * **The definition is never in here.** No prompt, no code, no criteria: the
     * entry holds those and is read through `library_id` when a conversation is
     * judged. What a version freezes is what somebody typed, which is exactly
     * what a run pins and what a verdict has to stay readable against.
     *
     * Deliberately jsonb, for the reason a persona's traits and a test's
     * content are: what an entry asks for is the entry's own decision and grows
     * with the shelf, and a field promoted to a column later is a cheap
     * migration.
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
     * This grader version's **own** LLM selection: a provider from the model
     * catalog and a model ID. Not an override of anything — the key behind it
     * is the organization's model-provider credential for that provider, or
     * Egma's own under managed access, resolved when the grading claim is
     * prepared.
     *
     * **Beside `judge_model` rather than in place of it, and the difference is
     * the whole reason for a second column.** `judge_model` overrides a
     * *project's* judge configuration and takes that project's key with it;
     * this names a complete selection and takes the organization's. A version
     * with this set is new work and never consults the project's judge; a
     * version with only `judge_model` is work authored before the model catalog
     * existed and keeps resolving exactly as it did. Null here is therefore an
     * ordinary state and means "compatibility path", never a fault.
     */
    graderModel: jsonb("grader_model"),
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
