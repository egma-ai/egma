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

import type { GraderParameter } from "../grader-library/parameters.ts";
import type { PersonaParameterValues } from "../persona-library/parameters.ts";

import { organization, project } from "./tenancy.ts";
import { user } from "./identity.ts";
import {
  createdAt,
  idText,
  moment,
  nonEmpty,
  prefixCheck,
  updatedAt,
} from "./columns.ts";

/**
 * Reusable persona identity and immutable behavior versions. Tests select identities;
 * simulations pin versions so later edits do not change past results.
 * name is the team's label; identity_name is the name given to the agent under test.
 * Deleting a Custom persona archives it while preserving versions. Shared
 * Egma-provided personas have null tenancy and read-only core behavior; fork one
 * for a Custom persona.
 */

export const persona = pgTable(
  "persona_definition",
  {
    id: idText("id").primaryKey(),
    /** Null together with projectId when this is an Egma-provided persona. */
    organizationId: idText("organization_id").references(
      () => organization.id,
      { onDelete: "cascade" },
    ),
    /** Null together with organizationId for an Egma-provided persona. */
    projectId: idText("project_id"),
    /** The team's word for this persona. Never spoken to an agent. */
    name: text("name").notNull(),
    description: text("description"),
    /**
     * Circular with the version table on purpose; the constraint is deferred
     * so create can insert both rows in one transaction.
     */
    currentVersionId: idText("current_version_id")
      .notNull()
      .references((): AnyPgColumn => personaVersion.id),
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
    // The one check that makes an Egma-provided persona undeletable: Delete
    // stamps `archived_at`, and this refuses that stamp on a row egma owns.
    check(
      "persona_egma_provided_is_active",
      sql`${table.organizationId} is not null or ${table.archivedAt} is null`,
    ),
    // The pairing, not each column on its own: a persona cannot name
    // one organization and another organization's project.
    foreignKey({
      name: "persona_project_organization_fk",
      columns: [table.projectId, table.organizationId],
      foreignColumns: [project.id, project.organizationId],
    }).onDelete("cascade"),
    // An Egma-provided name resolves to one catalog identity. Custom names
    // may still repeat because callers can select them by stable id.
    uniqueIndex("persona_egma_provided_name_unique")
      .on(table.name)
      .where(sql`${table.organizationId} is null`),
    index("persona_organization_id_project_id_idx")
      .on(table.organizationId, table.projectId)
      .where(sql`${table.archivedAt} is null`),
  ],
);

/**
 * Immutable persona core and parameter contract. Project settings live on
 * project_persona and simulations pin them separately. Catalog validation decides
 * which model combinations execute; credentials are resolved at claim time.
 */
export const personaVersion = pgTable(
  "persona_definition_version",
  {
    id: idText("id").primaryKey(),
    personaId: idText("persona_id")
      .notNull()
      .references(() => persona.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    /**
     * The human name this persona gives the agent. Authored, never invented:
     * the work order carries it and the prompt frame states it, so the same
     * test hears the same person on every run.
     */
    identityName: text("identity_name").notNull(),
    personality: text("personality").notNull(),
    /** Historical core language. New contracts carry language in parameters. */
    language: text("language"),
    parameterContract: jsonb("parameter_contract")
      .$type<readonly GraderParameter[]>()
      .notNull(),
    createdBy: idText("created_by").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
  },
  (table) => [
    prefixCheck("persona_version_id_prefix", table.id, "prsv"),
    nonEmpty("persona_version_identity_name_stated", table.identityName),
    nonEmpty("persona_version_personality_stated", table.personality),
    check(
      "persona_version_language_matches_contract",
      sql`(
        (${table.language} is not null and btrim(${table.language}) <> '' and not jsonb_path_exists(
          ${table.parameterContract}, '$[*] ? (@.key == "language")'
        ))
        or (${table.language} is null and jsonb_path_exists(
          ${table.parameterContract}, '$[*] ? (@.key == "language")'
        ))
      )`,
    ),
    check("persona_definition_version_parameter_contract_is_array", sql`jsonb_typeof(${table.parameterContract}) = 'array'`),
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

/** One project's complete settings for a shared or project-owned persona. */
export const projectPersona = pgTable(
  "project_persona",
  {
    id: idText("id").primaryKey(),
    organizationId: idText("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    projectId: idText("project_id").notNull(),
    personaDefinitionId: idText("persona_definition_id")
      .notNull()
      .references(() => persona.id),
    parameterValues: jsonb("parameter_values")
      .$type<PersonaParameterValues>()
      .notNull(),
    parameterContract: jsonb("parameter_contract")
      .$type<readonly GraderParameter[]>()
      .notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    prefixCheck("project_persona_id_prefix", table.id, "ppr"),
    foreignKey({
      name: "project_persona_project_organization_fk",
      columns: [table.projectId, table.organizationId],
      foreignColumns: [project.id, project.organizationId],
    }).onDelete("cascade"),
    unique("project_persona_project_definition_unique").on(
      table.projectId,
      table.personaDefinitionId,
    ),
    check(
      "project_persona_parameters_are_object",
      sql`jsonb_typeof(${table.parameterValues}) = 'object'`,
    ),
  ],
);
