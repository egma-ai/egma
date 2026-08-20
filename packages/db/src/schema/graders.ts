import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
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
 * down. The executable criteria live in immutable shared library revisions
 * below; these tables hold the decision to run one exact revision here.
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
 * What a **library identity** is: one stable word deciding what every immutable
 * definition revision may hold and which engine executes it. It is not copied
 * onto running copies. A database guard makes changing it in place impossible;
 * a different execution kind needs a new Library identity.
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
 * One immutable executable revision of a Library entry.
 *
 * The stable `grader_library` row below owns identity, tenancy and the current
 * revision pointer. The Library UI joins that pointer to this table. Each time
 * executable catalog content changes, seeding inserts one row here and moves
 * active copies by minting grader versions that reference it. A run keeps the
 * older reference it already pinned.
 *
 * The entry id and revision number are the identity. There is no second opaque
 * id because every caller already has both values, and a second id would add no
 * fact. The circular foreign key back from the Library row is deferred in the
 * migration so a new entry and its first immutable revision land together.
 */
export const graderLibraryVersion = pgTable(
  "grader_library_version",
  {
    libraryId: idText("library_id")
      .notNull()
      .references((): AnyPgColumn => graderLibrary.id, {
        onDelete: "cascade",
      }),
    version: integer("version").notNull(),
    prompt: text("prompt"),
    params: jsonb("params").notNull(),
    outputDefinition: jsonb("output_definition"),
    sourceCode: text("source_code"),
    sourceCodeLanguage: text("source_code_language"),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({ columns: [table.libraryId, table.version] }),
    prefixCheck(
      "grader_library_version_library_id_prefix",
      table.libraryId,
      "grl",
    ),
    check(
      "grader_library_version_source_code_within_budget",
      sql`${table.sourceCode} is null or octet_length(${table.sourceCode}) <= ${sql.raw(
        String(LARGEST_GRADER_SOURCE_CODE_BYTES),
      )}`,
    ),
    check(
      "grader_library_version_source_code_columns_agree",
      sql`(${table.sourceCode} is null) = (${table.sourceCodeLanguage} is null)`,
    ),
  ],
);

/**
 * The shelf: every grader identity, egma's own and — when custom authoring
 * arrives — a team's, in one table. Executable revisions live in the immutable
 * version table above.
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
 * egma's code** (`grader-library/catalog.ts`). The identity row points at one
 * shared current immutable definition. When executable content changes,
 * seeding inserts one definition revision, then mints and promotes one grader
 * version per active copy. New runs get it; older runs keep the exact revision
 * they pinned.
 *
 * **The table name is plural-ish on purpose and is a recorded exception** to
 * the schema's singular naming: it names the shelf rather than one thing on it,
 * exactly as the reference implementation's `eval_templates` does.
 *
 * A running copy points here by `library_id`, but a worker executes only the
 * immutable definition referenced by its grader version. The shelf identity is
 * the factory and UI anchor; the version is the record a run can safely pin.
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
     * The immutable definition revision the Library currently presents.
     *
     * **Bumped by the catalog upsert, and only when something actually
     * changed.** A new grader version stores this number beside `library_id`,
     * so execution can resolve the exact immutable definition without following
     * this current pointer later.
     */
    currentDefinitionVersion: integer("version").notNull().default(1),
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
    // The pairing, not each column on its own: an entry cannot name one
    // organization and another organization's project. Both null skips it,
    // which is exactly the egma-owned row.
    foreignKey({
      name: "grader_library_project_organization_fk",
      columns: [table.projectId, table.organizationId],
      foreignColumns: [project.id, project.organizationId],
    }).onDelete("cascade"),
    // The current Library template always names one immutable definition row.
    // This is deferred in migration 0037 so the entry and its first version can
    // be inserted in one transaction.
    foreignKey({
      name: "grader_library_current_version_fk",
      columns: [table.id, table.currentDefinitionVersion],
      foreignColumns: [
        graderLibraryVersion.libraryId,
        graderLibraryVersion.version,
      ],
    }),
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
 * The running copies: one row per grader a project actually judges with.
 *
 * A copy is made by pressing **Use** on a library entry, or seeded at project
 * creation. It carries the *deployment* — where it applies, how loudly, how
 * often — and its **filled-in values** in immutable versions. The identity row
 * carries no executable definition. Its current grader version references one,
 * so catalog reconciliation moves the copy to a new grader version while an
 * older run stays on the version it pinned.
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
     * A grader with no entry would be an identity with no definition history,
     * which is not a grader at all. `restrict` rather than `set null` for the
     * same reason: deleting the entry would remove the immutable definitions
     * its grader versions and old verdicts name. The
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
    // A grader version names both the copy and its stable Library identity.
    // This pair lets one composite foreign key prove the two agree.
    unique("grader_id_library_id_unique").on(table.id, table.libraryId),
  ],
);

export const graderVersion = pgTable(
  "grader_version",
  {
    id: idText("id").primaryKey(),
    graderId: idText("grader_id").notNull(),
    version: integer("version").notNull(),
    /** The one immutable Library definition this grader version executes. */
    libraryId: idText("library_id").notNull(),
    libraryVersion: integer("library_version").notNull(),
    /**
     * The copy's **filled-in values** — one set per assertion, each answering
     * the parameters its library entry declares. Latency's are a measure and a
     * bound; expected_behaviors' are empty, because its assertions are the
     * test's own sentences and arrive at judging time.
     *
     * The executable definition is not copied into every project row. The
     * `library_id` and `library_version` reference beside this config point at
     * one shared immutable definition. Together these three facts are the
     * complete judgment a run pins.
     *
     * Deliberately jsonb, for the reason a persona's traits and a test's
     * content are: what an entry asks for is the entry's own decision and grows
     * with the shelf, and a field promoted to a column later is a cheap
     * migration.
     */
    config: jsonb("config").notNull(),
    /**
     * The exact provider/model pair an `llm_as_judge` version executes.
     * Required by the write module for model-judged graders and null for `code`
     * graders, which make no provider call. A key never belongs here: workers
     * resolve the deployment's current provider bundle when they claim work.
     */
    judgeModel: jsonb("judge_model"),
    createdBy: idText("created_by").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
  },
  (table) => [
    prefixCheck("grader_version_id_prefix", table.id, "grv"),
    // The model may be null only because code graders do not call a model.
    // The write module and the database trigger in 0037 enforce that pairing;
    // this check keeps every non-null value on the shared executable catalog.
    check(
      "grader_version_judge_model_allowed",
      sql`${table.judgeModel} is null or ${table.judgeModel} = jsonb_build_object('provider', 'openai', 'model', 'gpt-4o-mini')`,
    ),
    foreignKey({
      name: "grader_version_library_version_fk",
      columns: [table.libraryId, table.libraryVersion],
      foreignColumns: [
        graderLibraryVersion.libraryId,
        graderLibraryVersion.version,
      ],
    }).onDelete("restrict"),
    foreignKey({
      name: "grader_version_grader_library_fk",
      columns: [table.graderId, table.libraryId],
      foreignColumns: [grader.id, grader.libraryId],
    }).onDelete("cascade"),
    unique("grader_version_grader_id_version_unique").on(
      table.graderId,
      table.version,
    ),
  ],
);
