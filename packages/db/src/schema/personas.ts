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
import { createdAt, idText, moment, prefixCheck, updatedAt } from "./columns.ts";
import { newRevision } from "../revisions.ts";

/**
 * A persona is the person an agent gets tested against: synthetic, and
 * reusable across any number of tests. These tables hold who they are —
 * nothing about what they want on a given occasion (the test's business) and
 * nothing about how the agent under test is reached.
 *
 * Two tables so that two different things can be pointed at. A test names the
 * identity row — this persona, however they currently behave. A run
 * pins a version row — this persona, frozen exactly as they were when
 * the simulation happened, so editing today never rewrites what an old result
 * meant. Renames touch the identity row only; behavior lives in the version.
 *
 * **A project-owned persona is archived, never deleted.** Archive takes it out
 * of the lists somebody authors from and leaves every historical row exactly
 * where it was. Egma's predefined personas have null tenancy, stay active and
 * read-only, and can be forked into a project-owned persona for customization.
 * Permanent removal is a compliance workflow and is not this table's business.
 */

export const persona = pgTable(
  "persona",
  {
    id: idText("id").primaryKey(),
    /** Null together with projectId when Egma owns this predefined persona. */
    organizationId: idText("organization_id").references(
      () => organization.id,
      { onDelete: "cascade" },
    ),
    /** Null together with organizationId when Egma owns this persona. */
    projectId: idText("project_id"),
    name: text("name").notNull(),
    description: text("description"),
    /**
     * Circular with the version table on purpose; the constraint is deferred
     * so create can insert both rows in one transaction.
     */
    currentVersionId: idText("current_version_id")
      .notNull()
      .references((): AnyPgColumn => personaVersion.id),
    /**
     * The opaque token an edit, an Archive or a Restore has to name to be
     * allowed to land — see `revisions.ts`. Defaulted here rather than at each
     * call site so that catalog seeding and the project-owned factory cannot
     * come to disagree about filling it.
     */
    revision: text("revision").notNull().$defaultFn(newRevision),
    archivedAt: moment("archived_at"),
    createdBy: idText("created_by").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    prefixCheck("persona_id_prefix", table.id, "prs"),
    check(
      "persona_tenancy_is_whole_or_egmas",
      sql`(${table.organizationId} is null) = (${table.projectId} is null)`,
    ),
    check(
      "persona_predefined_is_active",
      sql`${table.organizationId} is not null or ${table.archivedAt} is null`,
    ),
    // The pairing, not each column on its own: a persona cannot name
    // one organization and another organization's project.
    foreignKey({
      name: "persona_project_organization_fk",
      columns: [table.projectId, table.organizationId],
      foreignColumns: [project.id, project.organizationId],
    }).onDelete("cascade"),
    // A predefined name resolves to one catalog identity. Project-owned names
    // may still repeat because callers can select them by stable id.
    uniqueIndex("persona_predefined_name_unique")
      .on(table.name)
      .where(sql`${table.organizationId} is null`),
    index("persona_organization_id_project_id_idx")
      .on(table.organizationId, table.projectId)
      .where(sql`${table.archivedAt} is null`),
  ],
);

export const personaVersion = pgTable(
  "persona_version",
  {
    id: idText("id").primaryKey(),
    personaId: idText("persona_id")
      .notNull()
      .references(() => persona.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    /**
     * Deliberately jsonb: what a persona is made of is still settling,
     * and a field promoted to a column later is a cheap migration. Today:
     * personality, language, and the concrete voice.
     */
    traits: jsonb("traits").notNull(),
    createdBy: idText("created_by").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
  },
  (table) => [
    prefixCheck("persona_version_id_prefix", table.id, "prsv"),
    unique("persona_version_persona_id_version_unique").on(
      table.personaId,
      table.version,
    ),
    // The composite-foreign-key target that lets a simulation prove the
    // version it pins really is a version of the persona it names.
    unique("persona_version_id_persona_id_unique").on(
      table.id,
      table.personaId,
    ),
  ],
);
