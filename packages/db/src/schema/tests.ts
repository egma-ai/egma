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
 * A project contains test suites; each test belongs to one suite.
 * The identity row holds live metadata. Versions hold the scenario, expected
 * behaviors, and other execution content that simulations pin. The agent
 * under test is selected by the run.
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
     * Optimistic concurrency token for identity edits and deletion.
     * Execution content has a separate version ID, so a metadata edit need not
     * conflict with an edit to the scenario.
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
     * Versioned mock tools owned by this test: {tool, answer} or {tool, error}.
     * Stored separately so claims can query mock_tools IS NOT NULL.
     * An empty list is normalized to null.
     */
    mockTools: jsonb("mock_tools"),
    /**
     * Optional test environment: retell_dynamic_variables or
     * job_dispatch_metadata for LiveKit workers. Empty objects become null.
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
    // Supports persona usage queries.
    index("test_persona_persona_id_idx").on(
      table.personaId,
    ),
  ],
);
