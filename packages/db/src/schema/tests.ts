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

import { grader } from "./graders.ts";
import { persona } from "./personas.ts";
import { organization, project } from "./tenancy.ts";
import { user } from "./identity.ts";
import { createdAt, idText, moment, prefixCheck, updatedAt } from "./columns.ts";

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
    // Deliberately no unique index on (project_id, name): cloning a test copies
    // the name verbatim, so two tests in one project may share one.
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

/**
 * The graders this version's scenario asks for on top of the project's, and in
 * which order. Every grader in the project already judges every test, so these
 * rows are the scenario-specific additions: "the refund tool must fire" judges
 * the refund test and nothing else.
 *
 * Which graders judge a version is part of what the version checks, so the
 * array is content and belongs here rather than on the identity row — editing
 * it mints a version exactly as editing the caller set does.
 *
 * The persona junction's shape, verb for verb, because the two ask the same
 * question of the same version and answering them two ways would be two things
 * to learn. **By identity, never by version**, for the same reason: sharpening a
 * rubric must not mint a false new version of every test that names the grader,
 * and a run resolves each one and pins the version it actually met.
 */
export const testGrader = pgTable(
  "test_grader",
  {
    testVersionId: idText("test_version_id")
      .notNull()
      .references(() => testVersion.id, { onDelete: "cascade" }),
    /**
     * No `on delete` clause on purpose, exactly as the persona junction has
     * none. A version that named a grader goes on naming it for as long as any
     * run that pinned the version is kept, so removing the row outright is
     * refused rather than quietly emptying a version of what judges it.
     */
    graderId: idText("grader_id")
      .notNull()
      .references(() => grader.id),
    /** Where in the authored order this grader sits, counting from one. */
    position: integer("position").notNull(),
  },
  (table) => [
    primaryKey({
      name: "test_grader_pk",
      columns: [table.testVersionId, table.graderId],
    }),
    prefixCheck(
      "test_grader_test_version_id_prefix",
      table.testVersionId,
      "tstv",
    ),
    // Authored order is a fact about the version, so two graders on one version
    // can never claim the same place in it.
    unique("test_grader_version_id_position_unique").on(
      table.testVersionId,
      table.position,
    ),
    // What answers "which tests name this grader" when deleting one has to say.
    index("test_grader_grader_id_idx").on(table.graderId),
  ],
);
