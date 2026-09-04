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

import { persona } from "./personas.ts";
import { organization, project } from "./tenancy.ts";
import { user } from "./identity.ts";
import {
  createdAt,
  idText,
  moment,
  prefixCheck,
  updatedAt,
} from "./columns.ts";

/**
 * A test suite is one named, unversioned container inside a project. A test is
 * one authored specification inside exactly one suite: the situation to put an agent in, what
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

export const testSuite = pgTable(
  "test_suite",
  {
    id: idText("id").primaryKey(),
    organizationId: idText("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    projectId: idText("project_id").notNull(),
    name: text("name").notNull(),
    /** Hidden from authoring after permanent product deletion. */
    deletedAt: moment("deleted_at"),
    createdBy: idText("created_by").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    prefixCheck("test_suite_id_prefix", table.id, "ste"),
    check("test_suite_name_is_not_blank", sql`btrim(${table.name}) <> ''`),
    foreignKey({
      name: "test_suite_project_organization_fk",
      columns: [table.projectId, table.organizationId],
      foreignColumns: [project.id, project.organizationId],
    }).onDelete("cascade"),
    unique("test_suite_id_project_id_unique").on(table.id, table.projectId),
    index("test_suite_organization_id_project_id_idx")
      .on(table.organizationId, table.projectId)
      .where(sql`${table.deletedAt} is null`),
  ],
);

export const test = pgTable(
  "test",
  {
    id: idText("id").primaryKey(),
    organizationId: idText("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    projectId: idText("project_id").notNull(),
    suiteId: idText("suite_id").notNull(),
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
     * new after every identity write and permanent deletion. The name, the
     * description and the deleted state are live; the scenario and everything
     * else a run executes is versioned, and carries a version id instead.
     *
     * **Two tokens because they guard two different losses.** A rename that
     * loses a race is retyped in a second; a scenario edit that loses one may
     * be an afternoon's work. Making one token cover both would refuse the
     * cheap edit because somebody else made the expensive one.
     */
    revision: idText("revision").notNull(),
    /** Hidden from authoring after permanent product deletion. */
    deletedAt: moment("deleted_at"),
    createdBy: idText("created_by").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    prefixCheck("test_id_prefix", table.id, "tst"),
    prefixCheck("test_revision_prefix", table.revision, "rev"),
    // The pairing, not each column on its own: a test cannot name one
    // organization and another organization's project.
    foreignKey({
      name: "test_project_organization_fk",
      columns: [table.projectId, table.organizationId],
      foreignColumns: [project.id, project.organizationId],
    }).onDelete("cascade"),
    foreignKey({
      name: "test_suite_project_fk",
      columns: [table.suiteId, table.projectId],
      foreignColumns: [testSuite.id, testSuite.projectId],
    }),
    // Looks redundant next to the primary key; it is the composite-foreign-key
    // target that lets a simulation prove the test it pins is its own
    // project's, which makes a simulation of another project's test
    // unrepresentable.
    unique("test_id_project_id_unique").on(table.id, table.projectId),
    // Deliberately no unique index on (project_id, name): duplicate test names
    // are valid inside one suite or across several suites.
    index("test_organization_id_project_id_idx")
      .on(table.organizationId, table.projectId)
      .where(sql`${table.deletedAt} is null`),
    index("test_suite_id_id_idx")
      .on(table.suiteId, table.id)
      .where(sql`${table.deletedAt} is null`),
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
    /**
     * The tools this test answers for itself, as a list of
     * `{tool, answer}` or `{tool, error}` entries.
     *
     * **The test carries its own world, and there is no project half.** A mock
     * tool used to be a project row a test could override; it is a sentence in
     * the test now, versioned with the test exactly as an expected behavior is,
     * because "the calendar has no free slots" is a fact about this scenario
     * and about nothing else in the project.
     *
     * A column of its own rather than a key inside `content`, because the claim
     * gate asks the database directly whether a run's tests mock anything — one
     * `mock_tools is not null` over the join, rather than a jsonb key dug out of
     * every version. Null means this test mocks nothing, which is what most
     * tests do; an empty list is written as null so the two can never say the
     * same thing in two ways.
     */
    mockTools: jsonb("mock_tools"),
    /**
     * The world outside the conversation that this test asks for:
     * `retell_dynamic_variables` for the platform's own template variables, and
     * `job_dispatch_metadata` for what LiveKit hands the worker it dispatches.
     *
     * Beside the mock tools rather than inside them for the same reason they
     * are beside the content: it is a different question, asked of a different
     * lane, and a reader after one never pays for the other. Null means this
     * test asks for nothing, and an empty object is written as null.
     */
    env: jsonb("env"),
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
 * and it is gone. Which graders grade a simulation is answered entirely by the
 * project's project graders and their scope: every matching project grader is
 * included once in the grading plan. Attachment through test content
 * forced a scenario-specific decision through the wrong object, when "where does
 * this grader apply" is the grader's own setting.
 *
 * A version's content is therefore the scenario, the expected behaviors, the
 * mock tools and the env, and nothing else. Scenario-specific grading returns as
 * selectors on the project grader's JSON scope, over test suites and tests,
 * where the same question is asked once per grader rather than once per test.
 */
