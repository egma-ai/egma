import { sql } from "drizzle-orm";
import {
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

import { digitalHuman } from "./digital-humans.ts";
import { organization, project } from "./tenancy.ts";
import { user } from "./identity.ts";
import { createdAt, idText, moment, prefixCheck, updatedAt } from "./columns.ts";

/**
 * A test is one authored specification: the situation to put an agent in, what
 * should happen, and which digital humans call about it. These tables hold
 * that and nothing else — the agent under test is named by a run, and who a
 * digital human is lives in their own tables.
 *
 * Two tables, the digital human's shape exactly, so that two different things
 * can be pointed at. A suite names the identity row — this test, whatever it
 * currently checks. A run pins a version row — this test, frozen as it was
 * when the simulation happened, so improving a test today never rewrites what
 * an old result meant. Renames touch the identity row only; the scenario and
 * the expected behaviors live in the version.
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
     * Circular with the version table on purpose; the constraint is deferred
     * so create can insert both rows in one transaction.
     */
    currentVersionId: idText("current_version_id")
      .notNull()
      .references((): AnyPgColumn => testVersion.id),
    deletedAt: moment("deleted_at"),
    createdBy: idText("created_by").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    prefixCheck("test_id_prefix", table.id, "tst"),
    // The pairing, not each column on its own: a test cannot name one
    // organization and another organization's project.
    foreignKey({
      name: "test_project_organization_fk",
      columns: [table.projectId, table.organizationId],
      foreignColumns: [project.id, project.organizationId],
    }).onDelete("cascade"),
    // Deliberately no unique index on (project_id, name): cloning a test
    // copies the name verbatim, so two tests in one project may share one.
    index("test_organization_id_project_id_idx")
      .on(table.organizationId, table.projectId)
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
     * Deliberately jsonb, for the reason the digital human's traits are: what
     * a test says is still settling, and a field promoted to a column later is
     * a cheap migration. Today: the scenario, and the expected behaviors.
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
  ],
);

/**
 * Which digital humans call about a version's scenario, and in which order.
 * Three digital humans on a version means executing it produces three
 * simulations, so the set is content and belongs to the version rather than to
 * the identity row.
 *
 * **By identity, never by version.** Editing a digital human must not mint a
 * false new version of every test that names them; a run resolves each one and
 * pins the version it actually met.
 */
export const testVersionDigitalHuman = pgTable(
  "test_version_digital_human",
  {
    testVersionId: idText("test_version_id")
      .notNull()
      .references(() => testVersion.id, { onDelete: "cascade" }),
    /**
     * No `on delete` clause on purpose. A version that named a digital human
     * goes on naming them for as long as any run that pinned it is kept, so
     * removing the row outright is refused rather than quietly emptying a
     * version.
     */
    digitalHumanId: idText("digital_human_id")
      .notNull()
      .references(() => digitalHuman.id),
    /** Where in the authored order this digital human sits, counting from one. */
    position: integer("position").notNull(),
  },
  (table) => [
    primaryKey({
      name: "test_version_digital_human_pk",
      columns: [table.testVersionId, table.digitalHumanId],
    }),
    prefixCheck(
      "test_version_digital_human_test_version_id_prefix",
      table.testVersionId,
      "tstv",
    ),
    // Authored order is a fact about the version, so two digital humans on one
    // version can never claim the same place in it.
    unique("test_version_digital_human_version_id_position_unique").on(
      table.testVersionId,
      table.position,
    ),
    // Nothing reads this way yet; it is what answers "which tests name this
    // digital human" when deleting one has to say.
    index("test_version_digital_human_digital_human_id_idx").on(
      table.digitalHumanId,
    ),
  ],
);
