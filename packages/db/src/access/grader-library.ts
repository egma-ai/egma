import { isDeepStrictEqual } from "node:util";

import { and, asc, eq, isNull, or, sql } from "drizzle-orm";

import { db, type Queryable } from "../client.ts";
import {
  GRADER_DEFINITION_CATALOG,
  type PredefinedGraderDefinition,
} from "../grader-library/catalog.ts";
import {
  snapshotGraderDefinition,
  type GraderDefinitionSnapshot,
} from "../grader-library/snapshot.ts";
import {
  graderDefinition,
  graderDefinitionVersion,
  type GraderDefinitionType,
} from "../schema/graders.ts";
import type { AuthContext } from "./context.ts";
import { authorize, here } from "./permissions.ts";
import {
  backfillExpectedBehaviorsProjectGraders,
  type SeededProjectGrader,
} from "./seeded-graders.ts";

const RECONCILING_GRADER_CATALOG = "egma:reconcile-grader-catalog";

export type GraderDefinition = {
  readonly id: string;
  readonly projectId: string | null;
  readonly name: string;
  readonly description: string | null;
  readonly type: GraderDefinitionType;
  readonly scopeEditable: boolean;
  readonly currentDefinitionVersion: number;
  readonly owner: "egma" | "customer";
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

export type ReconciledGraderDefinition = {
  readonly id: string;
  readonly name: string;
  readonly version: number;
};

export type ReconciledGraderCatalog = {
  readonly definitions: readonly ReconciledGraderDefinition[];
  readonly projectGraders: readonly SeededProjectGrader[];
};

const DEFINITION_COLUMNS = {
  id: graderDefinition.id,
  organizationId: graderDefinition.organizationId,
  projectId: graderDefinition.projectId,
  name: graderDefinition.name,
  description: graderDefinition.description,
  type: graderDefinition.type,
  scopeEditable: graderDefinition.scopeEditable,
  currentDefinitionVersion: graderDefinition.currentDefinitionVersion,
  createdAt: graderDefinition.createdAt,
  updatedAt: graderDefinition.updatedAt,
} as const;

function definitionFromRow(
  row: typeof graderDefinition.$inferSelect,
): GraderDefinition {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    description: row.description,
    type: row.type as GraderDefinitionType,
    scopeEditable: row.scopeEditable,
    currentDefinitionVersion: row.currentDefinitionVersion,
    owner: row.organizationId === null ? "egma" : "customer",
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function visibleDefinition(auth: AuthContext) {
  return and(
    or(
      isNull(graderDefinition.organizationId),
      eq(graderDefinition.organizationId, auth.organizationId),
    ),
    auth.projectId === undefined
      ? undefined
      : or(
          isNull(graderDefinition.projectId),
          eq(graderDefinition.projectId, auth.projectId),
        ),
  );
}

export async function listGraderDefinitions(
  auth: AuthContext,
): Promise<readonly GraderDefinition[]> {
  authorize(auth, "read", here(auth));
  const rows = await db()
    .select(DEFINITION_COLUMNS)
    .from(graderDefinition)
    .where(visibleDefinition(auth))
    .orderBy(asc(graderDefinition.name), asc(graderDefinition.id));
  return rows.map((row) => definitionFromRow(row));
}

export async function getGraderDefinition(
  auth: AuthContext,
  id: string,
): Promise<GraderDefinition | undefined> {
  authorize(auth, "read", here(auth));
  const [row] = await db()
    .select(DEFINITION_COLUMNS)
    .from(graderDefinition)
    .where(and(eq(graderDefinition.id, id), visibleDefinition(auth)))
    .limit(1);
  return row === undefined ? undefined : definitionFromRow(row);
}

const VERSION_COLUMNS = {
  definitionId: graderDefinitionVersion.definitionId,
  version: graderDefinitionVersion.version,
  type: graderDefinition.type,
  prompt: graderDefinitionVersion.prompt,
  parameterContract: graderDefinitionVersion.parameterContract,
  outputContract: graderDefinitionVersion.outputContract,
  sourceCode: graderDefinitionVersion.sourceCode,
  sourceCodeLanguage: graderDefinitionVersion.sourceCodeLanguage,
  modalities: graderDefinitionVersion.modalities,
  judgeModel: graderDefinitionVersion.judgeModel,
} as const;

export async function getGraderDefinitionVersion(
  auth: AuthContext,
  definitionId: string,
  version: number,
): Promise<GraderDefinitionSnapshot | undefined> {
  authorize(auth, "read", here(auth));
  const [row] = await db()
    .select(VERSION_COLUMNS)
    .from(graderDefinitionVersion)
    .innerJoin(
      graderDefinition,
      eq(graderDefinition.id, graderDefinitionVersion.definitionId),
    )
    .where(
      and(
        eq(graderDefinitionVersion.definitionId, definitionId),
        eq(graderDefinitionVersion.version, version),
        visibleDefinition(auth),
      ),
    )
    .limit(1);
  return row === undefined ? undefined : snapshotGraderDefinition(row);
}

function catalogVersion(entry: PredefinedGraderDefinition) {
  return {
    prompt: entry.prompt,
    parameterContract: entry.parameterContract,
    outputContract: entry.outputContract,
    sourceCode: entry.sourceCode,
    sourceCodeLanguage: entry.sourceCodeLanguage,
    modalities: entry.modalities,
    judgeModel: entry.judgeModel,
  };
}

async function reconcileDefinitions(
  on: Queryable,
  catalog: readonly PredefinedGraderDefinition[],
): Promise<readonly ReconciledGraderDefinition[]> {
  const written: ReconciledGraderDefinition[] = [];

  for (const entry of catalog) {
    const [installed] = await on
      .select({
        ...DEFINITION_COLUMNS,
        ...VERSION_COLUMNS,
      })
      .from(graderDefinition)
      .leftJoin(
        graderDefinitionVersion,
        and(
          eq(graderDefinitionVersion.definitionId, graderDefinition.id),
          eq(
            graderDefinitionVersion.version,
            graderDefinition.currentDefinitionVersion,
          ),
        ),
      )
      .where(eq(graderDefinition.id, entry.id))
      .limit(1)
      .for("update", { of: graderDefinition });

    const wanted = catalogVersion(entry);
    if (installed === undefined) {
      await on.insert(graderDefinition).values({
        id: entry.id,
        organizationId: null,
        projectId: null,
        name: entry.name,
        description: entry.description,
        type: entry.type,
        scopeEditable: entry.scopeEditable,
        currentDefinitionVersion: 1,
        createdAt: entry.createdAt,
        updatedAt: entry.createdAt,
      });
      await on.insert(graderDefinitionVersion).values({
        definitionId: entry.id,
        version: 1,
        ...wanted,
        createdAt: entry.createdAt,
      });
      written.push({ id: entry.id, name: entry.name, version: 1 });
      continue;
    }

    if (installed.organizationId !== null || installed.projectId !== null) {
      throw new Error(`catalog identity ${entry.id} is customer-owned`);
    }
    if (installed.type !== entry.type) {
      throw new Error(
        `catalog definition ${entry.id} cannot change type; use a new definition identity`,
      );
    }
    if (installed.version === null) {
      throw new Error(
        `catalog definition ${entry.id} points at a missing definition version`,
      );
    }

    const held = {
      prompt: installed.prompt,
      parameterContract: installed.parameterContract,
      outputContract: installed.outputContract,
      sourceCode: installed.sourceCode,
      sourceCodeLanguage: installed.sourceCodeLanguage,
      modalities: installed.modalities,
      judgeModel: installed.judgeModel,
    };
    let version = installed.version;
    if (!isDeepStrictEqual(held, wanted)) {
      version += 1;
      await on.insert(graderDefinitionVersion).values({
        definitionId: entry.id,
        version,
        ...wanted,
      });
    }

    const identityMoved =
      installed.name !== entry.name ||
      installed.description !== entry.description ||
      installed.scopeEditable !== entry.scopeEditable;
    if (version === installed.version && !identityMoved) continue;

    await on
      .update(graderDefinition)
      .set({
        name: entry.name,
        description: entry.description,
        scopeEditable: entry.scopeEditable,
        currentDefinitionVersion: version,
        updatedAt: new Date(),
      })
      .where(eq(graderDefinition.id, entry.id));
    written.push({ id: entry.id, name: entry.name, version });
  }

  return written;
}

/** Install shared definitions and repair Expected behaviors in one boot door. */
export async function reconcileGraderCatalog(
  catalog: readonly PredefinedGraderDefinition[] = GRADER_DEFINITION_CATALOG,
): Promise<ReconciledGraderCatalog> {
  return db().transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${RECONCILING_GRADER_CATALOG}::text, 0))`,
    );
    const definitions = await reconcileDefinitions(tx, catalog);
    const projectGraders = await backfillExpectedBehaviorsProjectGraders(tx);
    return { definitions, projectGraders };
  });
}
