import { sql } from "drizzle-orm";
import {
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

import { organization, project } from "./tenancy.ts";
import { user } from "./identity.ts";
import { createdAt, idText, moment, prefixCheck, updatedAt } from "./columns.ts";

/**
 * A digital human is the person an agent gets tested against: synthetic, and
 * reusable across any number of tests. These tables hold who they are —
 * nothing about what they want on a given occasion (the test's business) and
 * nothing about how the agent under test is reached.
 *
 * Two tables so that two different things can be pointed at. A test names the
 * identity row — this digital human, however they currently behave. A run
 * pins a version row — this digital human, frozen exactly as they were when
 * the simulation happened, so editing today never rewrites what an old result
 * meant. Renames touch the identity row only; behavior lives in the version.
 */

export const digitalHuman = pgTable(
  "digital_human",
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
      .references((): AnyPgColumn => digitalHumanVersion.id),
    deletedAt: moment("deleted_at"),
    createdBy: idText("created_by").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    prefixCheck("digital_human_id_prefix", table.id, "dh"),
    // The pairing, not each column on its own: a digital human cannot name
    // one organization and another organization's project.
    foreignKey({
      name: "digital_human_project_organization_fk",
      columns: [table.projectId, table.organizationId],
      foreignColumns: [project.id, project.organizationId],
    }).onDelete("cascade"),
    index("digital_human_organization_id_project_id_idx")
      .on(table.organizationId, table.projectId)
      .where(sql`${table.deletedAt} is null`),
  ],
);

export const digitalHumanVersion = pgTable(
  "digital_human_version",
  {
    id: idText("id").primaryKey(),
    digitalHumanId: idText("digital_human_id")
      .notNull()
      .references(() => digitalHuman.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    /**
     * Deliberately jsonb: what a digital human is made of is still settling,
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
    prefixCheck("digital_human_version_id_prefix", table.id, "dhv"),
    unique("digital_human_version_digital_human_id_version_unique").on(
      table.digitalHumanId,
      table.version,
    ),
  ],
);
