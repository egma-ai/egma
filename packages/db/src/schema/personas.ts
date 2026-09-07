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
 * **Two names, and they answer different questions.** `name` on the identity
 * row is the team's word for this persona — what a list, a picker and a sheet
 * header show, and what nobody ever hears. `identity_name` on the version row
 * is the human name the persona gives the agent on the call, so the same test
 * hears the same person every time it runs. One is a label a team may relabel
 * at will; the other is authored behavior and versions like any other.
 *
 * **A Custom persona is stamped, never deleted.** The product word is Delete
 * and it is permanent as far as anybody using egma is concerned; underneath,
 * `archived_at` is set and every row stays exactly where it was, so a run that
 * pinned one of these versions still reads true forever. The column keeps the
 * archive word on purpose — the product word and the storage word differ here,
 * and that split is a recorded decision rather than something to tidy up.
 * Egma-provided personas have null tenancy, stay active and read-only, and can
 * be forked into a Custom persona for customization.
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
 * One frozen version: who this persona is, and how they execute.
 *
 * **Typed columns, and plainly checked.** Behavior was two jsonb bags held
 * shut by eighty-odd lines of jsonpath, which bought flexibility and then
 * forbade it. Every field a version can carry is now a column Postgres knows
 * the type of, and every rule about one is a check a reader can read. A trait
 * that returns comes back as a column, together with the runtime that consumes
 * it, in one change.
 *
 * The provider catalog, not Postgres, decides which provider, model and
 * adapter combinations this release can execute; these checks protect the
 * stored shape only. Credentials are resolved for each claimed work item and
 * never belong in this immutable authored value.
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
    language: text("language").notNull(),
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
    nonEmpty("persona_version_language_stated", table.language),
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
export const projectPersona = pgTable("project_persona", {
  id: idText("id").primaryKey(),
  organizationId: idText("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  projectId: idText("project_id").notNull(),
  personaDefinitionId: idText("persona_definition_id").notNull().references(() => persona.id),
  parameterValues: jsonb("parameter_values").$type<PersonaParameterValues>().notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (table) => [
  prefixCheck("project_persona_id_prefix", table.id, "ppr"),
  foreignKey({ name: "project_persona_project_organization_fk", columns: [table.projectId, table.organizationId], foreignColumns: [project.id, project.organizationId] }).onDelete("cascade"),
  unique("project_persona_project_definition_unique").on(table.projectId, table.personaDefinitionId),
  check("project_persona_parameters_are_object", sql`jsonb_typeof(${table.parameterValues}) = 'object'`),
]);
