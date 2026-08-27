import { isDeepStrictEqual } from "node:util";

import { and, asc, eq, isNull, or, sql } from "drizzle-orm";

import { db, type Queryable } from "../client.ts";
import {
  GRADER_DEFINITION_CATALOG,
  type GraderOutputContract,
  type PredefinedGraderDefinition,
} from "../grader-library/catalog.ts";
import type { GraderParameter } from "../grader-library/parameters.ts";
import {
  snapshotGraderDefinition,
  type GraderDefinitionSnapshot,
} from "../grader-library/snapshot.ts";
import {
  graderDefinition,
  graderDefinitionVersion,
  projectGrader,
  type GraderDefinitionType,
  type GraderModality,
} from "../schema/graders.ts";
import type { AuthContext } from "./context.ts";
import { authorize, here } from "./permissions.ts";
import {
  backfillExpectedBehaviorsProjectGraders,
  type SeededProjectGrader,
} from "./seeded-graders.ts";

const RECONCILING_GRADER_CATALOG = "egma:reconcile-grader-catalog";

export type GraderLibraryEntry = {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly owner: "egma" | "organization";
  readonly scopeEditable: boolean;
  readonly currentDefinitionVersion: number;
  readonly definitionVersion: number;
  readonly type: GraderDefinitionType;
  readonly gradingInstructions: string | null;
  readonly parameterContract: readonly GraderParameter[];
  readonly outputContract: GraderOutputContract | null;
  readonly modalities: readonly GraderModality[];
  readonly activeProjectGraderId: string | null;
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
  name: graderDefinition.name,
  description: graderDefinition.description,
  scopeEditable: graderDefinition.scopeEditable,
  currentDefinitionVersion: graderDefinition.currentDefinitionVersion,
  createdAt: graderDefinition.createdAt,
  updatedAt: graderDefinition.updatedAt,
} as const;

const VERSION_COLUMNS = {
  definitionId: graderDefinitionVersion.definitionId,
  version: graderDefinitionVersion.version,
  type: graderDefinitionVersion.type,
  prompt: graderDefinitionVersion.prompt,
  parameterContract: graderDefinitionVersion.parameterContract,
  outputContract: graderDefinitionVersion.outputContract,
  modalities: graderDefinitionVersion.modalities,
  judgeModel: graderDefinitionVersion.judgeModel,
} as const;

const LIBRARY_COLUMNS = {
  ...DEFINITION_COLUMNS,
  ...VERSION_COLUMNS,
  activeProjectGraderId: projectGrader.id,
} as const;

function visibleDefinition(auth: AuthContext) {
  return or(
    isNull(graderDefinition.organizationId),
    eq(graderDefinition.organizationId, auth.organizationId),
  );
}

function activeInProject(auth: AuthContext) {
  return and(
    eq(projectGrader.graderDefinitionId, graderDefinition.id),
    eq(projectGrader.organizationId, auth.organizationId),
    auth.projectId === undefined
      ? sql`false`
      : eq(projectGrader.projectId, auth.projectId),
    isNull(projectGrader.archivedAt),
  );
}

function libraryEntryFromRow(row: {
  readonly id: string;
  readonly organizationId: string | null;
  readonly name: string;
  readonly description: string | null;
  readonly scopeEditable: boolean;
  readonly currentDefinitionVersion: number;
  readonly definitionId: string;
  readonly version: number;
  readonly type: string;
  readonly prompt: string | null;
  readonly parameterContract: unknown;
  readonly outputContract: unknown;
  readonly modalities: unknown;
  readonly judgeModel: unknown;
  readonly activeProjectGraderId: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}): GraderLibraryEntry {
  const version = snapshotGraderDefinition(row);
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    owner: row.organizationId === null ? "egma" : "organization",
    scopeEditable: row.scopeEditable,
    currentDefinitionVersion: row.currentDefinitionVersion,
    definitionVersion: version.definitionVersion,
    type: version.type,
    gradingInstructions: version.prompt,
    parameterContract: version.parameterContract,
    outputContract: version.outputContract,
    modalities: version.modalities,
    activeProjectGraderId: row.activeProjectGraderId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function libraryQuery(auth: AuthContext) {
  return db()
    .select(LIBRARY_COLUMNS)
    .from(graderDefinition)
    .innerJoin(
      graderDefinitionVersion,
      and(
        eq(graderDefinitionVersion.definitionId, graderDefinition.id),
        eq(
          graderDefinitionVersion.version,
          graderDefinition.currentDefinitionVersion,
        ),
      ),
    )
    .leftJoin(projectGrader, activeInProject(auth));
}

/** List the shared Egma library plus this organization's own definitions. */
export async function listGraderLibrary(
  auth: AuthContext,
): Promise<readonly GraderLibraryEntry[]> {
  authorize(auth, "read", here(auth));
  const rows = await libraryQuery(auth)
    .where(visibleDefinition(auth))
    .orderBy(asc(graderDefinition.name), asc(graderDefinition.id));
  return rows.map(libraryEntryFromRow);
}

/** Read one visible library definition at its current immutable version. */
export async function getGraderLibraryEntry(
  auth: AuthContext,
  definitionId: string,
): Promise<GraderLibraryEntry | undefined> {
  authorize(auth, "read", here(auth));
  const [row] = await libraryQuery(auth)
    .where(
      and(eq(graderDefinition.id, definitionId), visibleDefinition(auth)),
    )
    .limit(1);
  return row === undefined ? undefined : libraryEntryFromRow(row);
}

/** Read one exact immutable version for a visible definition. */
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
    type: entry.type,
    prompt: entry.prompt,
    parameterContract: entry.parameterContract,
    outputContract: entry.outputContract,
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
      .select({ ...DEFINITION_COLUMNS, ...VERSION_COLUMNS })
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
        name: entry.name,
        description: entry.description,
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

    if (installed.organizationId !== null) {
      throw new Error(`catalog identity ${entry.id} is organization-owned`);
    }
    if (installed.version === null) {
      throw new Error(
        `catalog definition ${entry.id} points at a missing definition version`,
      );
    }

    const held = {
      type: installed.type,
      prompt: installed.prompt,
      parameterContract: installed.parameterContract,
      outputContract: installed.outputContract,
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
