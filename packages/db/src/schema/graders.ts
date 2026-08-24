import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

import { organization, project } from "./tenancy.ts";
import type {
  GraderParameter,
  GraderParameterValues,
} from "../grader-library/parameters.ts";
import {
  createdAt,
  idText,
  moment,
  oneOf,
  prefixCheck,
  updatedAt,
} from "./columns.ts";

/** The execution mechanisms implemented by the grader service. */
export const GRADER_DEFINITION_TYPES = ["llm_as_judge", "code"] as const;
export type GraderDefinitionType = (typeof GRADER_DEFINITION_TYPES)[number];

/** A definition version states which evidence modality it can grade. */
export const GRADER_MODALITIES = ["chat", "voice"] as const;
export type GraderModality = (typeof GRADER_MODALITIES)[number];

/** The non-secret provider and model selected by an immutable LLM definition. */
export type GraderJudgeModel = {
  readonly provider: string;
  readonly model: string;
};

export type SimulationScopeSelector =
  | { readonly kind: "all" }
  | { readonly kind: "test_suite"; readonly id: string }
  | { readonly kind: "test"; readonly id: string };

/** One project's complete grader coverage policy. */
export type ProjectGraderScope = {
  readonly simulations: readonly SimulationScopeSelector[];
  readonly production: { readonly sample_percent: number } | null;
};

/** One immutable executable version of a grader definition. */
export const graderDefinitionVersion = pgTable(
  "grader_definition_version",
  {
    definitionId: idText("definition_id")
      .notNull()
      .references((): AnyPgColumn => graderDefinition.id, {
        onDelete: "cascade",
      }),
    version: integer("version").notNull(),
    type: text("type").notNull(),
    prompt: text("prompt"),
    parameterContract: jsonb("parameter_contract")
      .$type<readonly GraderParameter[]>()
      .notNull(),
    outputContract: jsonb("output_contract"),
    modalities: jsonb("modalities")
      .$type<readonly GraderModality[]>()
      .notNull(),
    judgeModel: jsonb("judge_model").$type<GraderJudgeModel | null>(),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({ columns: [table.definitionId, table.version] }),
    prefixCheck(
      "grader_definition_version_definition_id_prefix",
      table.definitionId,
      "grl",
    ),
    check(
      "grader_definition_version_version_is_positive",
      sql`${table.version} >= 1`,
    ),
    oneOf("grader_definition_version_type_allowed", table.type, [
      ...GRADER_DEFINITION_TYPES,
    ]),
    check(
      "grader_definition_version_modalities_allowed",
      sql`${table.modalities} in (
        '["chat"]'::jsonb,
        '["voice"]'::jsonb,
        '["chat", "voice"]'::jsonb,
        '["voice", "chat"]'::jsonb
      )`,
    ),
  ],
);

/**
 * A stable grader-library identity. Null tenancy means that Egma owns it.
 * `scope_editable` is catalog policy; actual scope is project policy below.
 */
export const graderDefinition = pgTable(
  "grader_definition",
  {
    id: idText("id").primaryKey(),
    organizationId: idText("organization_id").references(
      () => organization.id,
      { onDelete: "cascade" },
    ),
    name: text("name").notNull(),
    description: text("description"),
    scopeEditable: boolean("scope_editable").notNull(),
    currentDefinitionVersion: integer("current_definition_version")
      .notNull()
      .default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    prefixCheck("grader_definition_id_prefix", table.id, "grl"),
    foreignKey({
      name: "grader_definition_current_version_fk",
      columns: [table.id, table.currentDefinitionVersion],
      foreignColumns: [
        graderDefinitionVersion.definitionId,
        graderDefinitionVersion.version,
      ],
    }),
    uniqueIndex("grader_definition_predefined_name_unique")
      .on(table.name)
      .where(sql`${table.organizationId} is null`),
    index("grader_definition_organization_id_idx").on(table.organizationId),
  ],
);

/** One project's live policy for one shared grader definition. */
export const projectGrader = pgTable(
  "project_grader",
  {
    id: idText("id").primaryKey(),
    organizationId: idText("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    projectId: idText("project_id").notNull(),
    graderDefinitionId: idText("grader_definition_id")
      .notNull()
      .references(() => graderDefinition.id, { onDelete: "restrict" }),
    scope: jsonb("scope").$type<ProjectGraderScope>().notNull(),
    parameterValues: jsonb("parameter_values")
      .$type<GraderParameterValues>()
      .notNull(),
    passThreshold: doublePrecision("pass_threshold").notNull(),
    archivedAt: moment("archived_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    prefixCheck("project_grader_id_prefix", table.id, "grd"),
    foreignKey({
      name: "project_grader_project_organization_fk",
      columns: [table.projectId, table.organizationId],
      foreignColumns: [project.id, project.organizationId],
    }).onDelete("cascade"),
    check(
      "project_grader_scope_is_closed_object",
      sql`jsonb_typeof(${table.scope}) is not distinct from 'object'
        and (${table.scope} - array['simulations', 'production']::text[])
          is not distinct from '{}'::jsonb
        and ${table.scope} ?& array['simulations', 'production']::text[]
        and jsonb_typeof(${table.scope}->'simulations') is not distinct from 'array'
        and (
          ${table.scope}->'production' = 'null'::jsonb
          or jsonb_typeof(${table.scope}->'production') is not distinct from 'object'
        )`,
    ),
    check(
      "project_grader_pass_threshold_is_normalized",
      sql`${table.passThreshold} between 0 and 1`,
    ),
    uniqueIndex("project_grader_active_definition_unique")
      .on(table.projectId, table.graderDefinitionId)
      .where(sql`${table.archivedAt} is null`),
    index("project_grader_organization_id_project_id_idx")
      .on(table.organizationId, table.projectId)
      .where(sql`${table.archivedAt} is null`),
    index("project_grader_definition_id_idx").on(table.graderDefinitionId),
  ],
);
