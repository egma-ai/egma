import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  unique,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

import { agent } from "./agents.ts";
import { persona } from "./personas.ts";
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
 * A test is one authored specification: the situation to put an agent in, what
 * should happen, and which personas call about it. These tables hold that and
 * nothing else — the agent under test is named by a run, and who a persona is
 * lives in their own tables.
 *
 * Two tables, the persona's shape exactly, so that two different things can be
 * pointed at. A suite names the identity row — this test, whatever it currently
 * checks. A run pins a version row — this test, frozen as it was when the
 * simulation happened, so improving a test today never rewrites what an old
 * result meant. Renames touch the identity row only; the scenario and the
 * expected behaviors live in the version.
 */

export const test = pgTable(
  "test",
  {
    id: idText("id").primaryKey(),
    organizationId: idText("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    projectId: idText("project_id").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    /**
     * Circular with the version table on purpose; the constraint is deferred so
     * create can insert both rows in one transaction.
     */
    currentVersionId: idText("current_version_id")
      .notNull()
      .references((): AnyPgColumn => testVersion.id),
    /**
     * What an edit to the live half says it was written against: opaque, and
     * new after every identity write and every lifecycle change. The name, the
     * description and the archive state are live; the scenario and everything
     * else a run is judged by is versioned, and carries a version id instead.
     *
     * **Two tokens because they guard two different losses.** A rename that
     * loses a race is retyped in a second; a scenario edit that loses one may
     * be an afternoon's work. Making one token cover both would refuse the
     * cheap edit because somebody else made the expensive one.
     */
    revision: idText("revision").notNull(),
    /**
     * The opaque revision of the applicable-agent set, and **nothing else on
     * this row**.
     *
     * A third token rather than a third meaning for the first, because which
     * agents a test applies to is neither content nor identity: linking an
     * agent changes no version, makes no repository copy stale, and must not
     * refuse a rename typed in another tab. It moves only when a link is added
     * or removed, and a link edit names only this one.
     */
    applicabilityRevision: idText("applicability_revision").notNull(),
    /**
     * When this test stopped being available for new work, or null while it is.
     * Archive rather than delete: its versions, its links and the runs that
     * pinned it stay exactly where they are, and the whole of what Archive does
     * is stop it entering a new run.
     */
    archivedAt: moment("archived_at"),
    /**
     * Why it was archived, when nobody chose to.
     *
     * Only an upgrade writes one. A test whose project held no active agent
     * when the applicable-agent relation arrived had no honest link to be
     * given, so it was archived rather than left targetless — and a person
     * finding it in the archive is owed the reason, because the fix is to link
     * an agent rather than to wonder who removed it. A person's own Archive
     * leaves this null: they know why.
     */
    archiveReason: text("archive_reason"),
    createdBy: idText("created_by").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    prefixCheck("test_id_prefix", table.id, "tst"),
    prefixCheck("test_revision_prefix", table.revision, "rev"),
    prefixCheck(
      "test_applicability_revision_prefix",
      table.applicabilityRevision,
      "rev",
    ),
    oneOf("test_archive_reason_allowed", table.archiveReason, ["needs_agent"]),
    // A reason with nothing to explain is a row saying two things at once.
    check(
      "test_archive_reason_needs_an_archive",
      sql`${table.archiveReason} is null or ${table.archivedAt} is not null`,
    ),
    // The pairing, not each column on its own: a test cannot name one
    // organization and another organization's project.
    foreignKey({
      name: "test_project_organization_fk",
      columns: [table.projectId, table.organizationId],
      foreignColumns: [project.id, project.organizationId],
    }).onDelete("cascade"),
    // Looks redundant next to the primary key; it is the composite-foreign-key
    // target that lets a simulation prove the test it pins is its own
    // project's, which makes a simulation of another project's test
    // unrepresentable.
    unique("test_id_project_id_unique").on(table.id, table.projectId),
    // Deliberately no unique index on (project_id, name): cloning a test copies
    // the name verbatim, so two tests in one project may share one.
    index("test_organization_id_project_id_idx")
      .on(table.organizationId, table.projectId)
      .where(sql`${table.archivedAt} is null`),
  ],
);

/**
 * Which agents a test applies to — the targets a run may execute it against.
 *
 * **On the identity row, never on a version, and that is the whole decision.**
 * Which agents a test is worth running against is target coverage, not test
 * content: linking a second agent to compare a prompt variant says nothing new
 * about what the test checks, and minting a version for it would fill a history
 * with entries nobody authored and make every repository copy stale for a
 * change no file can see. So the set has its own revision on the identity row
 * and versions nothing.
 *
 * **A run pins the agent it chose**, so a link removed afterwards cannot
 * rewrite what an old run executed. Applicability is a live admission rule and
 * only ever decides what may start.
 *
 * A test always applies to at least one agent. The rule is the access layer's
 * rather than a constraint's, because a constraint would have to be deferred to
 * let a create write the identity row before its first link, and a deferred
 * constraint refuses at commit with nothing to say about which link was the
 * last one.
 */
export const testAgent = pgTable(
  "test_agent",
  {
    testId: idText("test_id")
      .notNull()
      .references(() => test.id, { onDelete: "cascade" }),
    /**
     * No `on delete` beyond the cascade the composite key below carries: an
     * agent is archived rather than deleted, and an archived agent keeps its
     * links — the test stays linked and simply has nowhere active to run.
     */
    agentId: idText("agent_id")
      .notNull()
      .references(() => agent.id, { onDelete: "cascade" }),
    /**
     * Carried on the row rather than joined for, because it is what the two
     * composite keys below check against: a link between a test of one project
     * and an agent of another cannot be written at all.
     */
    projectId: idText("project_id").notNull(),
    createdBy: idText("created_by").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({
      name: "test_agent_pk",
      columns: [table.testId, table.agentId],
    }),
    // The leading half of the key, exactly as the mock tool's scope junction
    // pins its own. What the agent id is, the composite key below settles.
    prefixCheck("test_agent_test_id_prefix", table.testId, "tst"),
    // The pairing, not each column on its own: the same tenancy triangle a
    // connection is held to, one level across instead of one level down.
    foreignKey({
      name: "test_agent_test_project_fk",
      columns: [table.testId, table.projectId],
      foreignColumns: [test.id, test.projectId],
    }).onDelete("cascade"),
    foreignKey({
      name: "test_agent_agent_project_fk",
      columns: [table.agentId, table.projectId],
      foreignColumns: [agent.id, agent.projectId],
    }).onDelete("cascade"),
    // What answers "which tests apply to this agent" — the agent's own detail
    // page, and the admission check a run makes before it starts.
    index("test_agent_agent_id_idx").on(table.agentId),
  ],
);

export const testVersion = pgTable(
  "test_version",
  {
    id: idText("id").primaryKey(),
    testId: idText("test_id")
      .notNull()
      .references(() => test.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    /**
     * Deliberately jsonb, for the reason the persona's traits are: what a test
     * says is still settling, and a field promoted to a column later is a cheap
     * migration. Today: the scenario, and the expected behaviors.
     */
    content: jsonb("content").notNull(),
    createdBy: idText("created_by").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
  },
  (table) => [
    prefixCheck("test_version_id_prefix", table.id, "tstv"),
    unique("test_version_test_id_version_unique").on(
      table.testId,
      table.version,
    ),
    // The other half of the pin a simulation carries: the composite-foreign-key
    // target that proves this version really is a version of the test it names,
    // checked by the database rather than by the code that wrote it.
    unique("test_version_id_test_id_unique").on(table.id, table.testId),
  ],
);

/**
 * Which personas call about a version's scenario, and in which order. Three
 * personas on a version means executing it produces three simulations, so the
 * set is content and belongs to the version rather than to the identity row.
 *
 * **By identity, never by version.** Editing a persona must not mint a false
 * new version of every test that names them; a run resolves each one and pins
 * the version it actually met.
 */
export const testPersona = pgTable(
  "test_persona",
  {
    testVersionId: idText("test_version_id")
      .notNull()
      .references(() => testVersion.id, { onDelete: "cascade" }),
    /**
     * No `on delete` clause on purpose. A version that named a persona goes on
     * naming them for as long as any run that pinned it is kept, so removing
     * the row outright is refused rather than quietly emptying a version.
     */
    personaId: idText("persona_id")
      .notNull()
      .references(() => persona.id),
    /** Where in the authored order this persona sits, counting from one. */
    position: integer("position").notNull(),
  },
  (table) => [
    primaryKey({
      name: "test_persona_pk",
      columns: [table.testVersionId, table.personaId],
    }),
    prefixCheck(
      "test_persona_test_version_id_prefix",
      table.testVersionId,
      "tstv",
    ),
    // Authored order is a fact about the version, so two personas on one
    // version can never claim the same place in it.
    unique("test_persona_version_id_position_unique").on(
      table.testVersionId,
      table.position,
    ),
    // Nothing reads this way yet; it is what answers "which tests name this
    // persona" when deleting one has to say.
    index("test_persona_persona_id_idx").on(
      table.personaId,
    ),
  ],
);

/*
 * **A test names no graders, and there is no junction to name them through.**
 *
 * There was one — `test_grader`, the persona junction's shape verb for verb —
 * and it is gone. Which graders judge a simulation is answered entirely by the
 * project's running copies and their scope: every active copy whose scope
 * covers the source judges everything in it. Attachment through test content
 * forced a scenario-specific decision through the wrong object, when "where does
 * this grader apply" is the grader's own setting.
 *
 * A version's content is therefore the scenario, the expected behaviors and the
 * mock overrides, and nothing else. Scenario-specific grading returns as
 * Langfuse-shaped **filters on the running copy** — `{field, operator, values}`
 * over test and agent — in the custom-grader era, where the same question is
 * asked once per grader rather than once per test.
 */
