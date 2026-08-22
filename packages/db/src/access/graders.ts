import { and, asc, eq, inArray, isNull, or } from "drizzle-orm";

import { db, type Queryable } from "../client.ts";
import { PREDEFINED_GRADERS } from "../grader-library/catalog.ts";
import {
  snapshotGraderDefinition,
  type GraderDefinitionSnapshot,
} from "../grader-library/snapshot.ts";
import {
  validatePassThreshold,
  validateProjectGraderScope,
} from "../grader-library/policy.ts";
import {
  graderDefinition,
  graderDefinitionVersion,
  projectGrader,
  type GraderDefinitionType,
  type ProjectGraderScope,
  type SimulationScopeSelector,
} from "../schema/graders.ts";
import { test, testSuite } from "../schema/tests.ts";
import type { AuthContext } from "./context.ts";
import { UnprocessableInputError } from "./errors.ts";
import { authorize, here } from "./permissions.ts";
import { inActingProject, within } from "./within.ts";

export type { GraderDefinitionSnapshot } from "../grader-library/snapshot.ts";

export type ProjectGrader = {
  readonly id: string;
  readonly projectId: string;
  readonly graderDefinitionId: string;
  readonly name: string;
  readonly description: string | null;
  readonly graderType: GraderDefinitionType;
  readonly scopeEditable: boolean;
  readonly scope: ProjectGraderScope;
  readonly passThreshold: number;
  readonly currentDefinitionVersion: number;
  readonly archivedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

export type ProjectGraderChanges = {
  readonly scope?: unknown;
  readonly passThreshold?: number;
};

const COLUMNS = {
  id: projectGrader.id,
  projectId: projectGrader.projectId,
  graderDefinitionId: projectGrader.graderDefinitionId,
  name: graderDefinition.name,
  description: graderDefinition.description,
  graderType: graderDefinition.type,
  scopeEditable: graderDefinition.scopeEditable,
  scope: projectGrader.scope,
  passThreshold: projectGrader.passThreshold,
  currentDefinitionVersion: graderDefinition.currentDefinitionVersion,
  archivedAt: projectGrader.archivedAt,
  createdAt: projectGrader.createdAt,
  updatedAt: projectGrader.updatedAt,
} as const;

function fromRow(row: {
  readonly id: string;
  readonly projectId: string;
  readonly graderDefinitionId: string;
  readonly name: string;
  readonly description: string | null;
  readonly graderType: string;
  readonly scopeEditable: boolean;
  readonly scope: unknown;
  readonly passThreshold: number;
  readonly currentDefinitionVersion: number;
  readonly archivedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}): ProjectGrader {
  return {
    ...row,
    graderType: row.graderType as GraderDefinitionType,
    scope: validateProjectGraderScope(row.scope),
  };
}

async function validateScopeReferences(
  on: Queryable,
  auth: AuthContext,
  projectId: string,
  scope: ProjectGraderScope,
): Promise<void> {
  const suiteIds = scope.simulations
    .filter((one): one is Extract<SimulationScopeSelector, { kind: "test_suite" }> => one.kind === "test_suite")
    .map((one) => one.id);
  const testIds = scope.simulations
    .filter((one): one is Extract<SimulationScopeSelector, { kind: "test" }> => one.kind === "test")
    .map((one) => one.id);

  if (suiteIds.length > 0) {
    const found = await on
      .select({ id: testSuite.id })
      .from(testSuite)
      .where(
        within(
          auth,
          testSuite,
          and(
            eq(testSuite.projectId, projectId),
            inArray(testSuite.id, suiteIds),
            isNull(testSuite.deletedAt),
          ),
        ),
      );
    if (found.length !== suiteIds.length) {
      throw new UnprocessableInputError(
        "grader scope names a test suite that is not active in this project",
      );
    }
  }

  if (testIds.length > 0) {
    const found = await on
      .select({ id: test.id })
      .from(test)
      .innerJoin(
        testSuite,
        and(eq(testSuite.id, test.suiteId), isNull(testSuite.deletedAt)),
      )
      .where(
        within(
          auth,
          test,
          and(
            eq(test.projectId, projectId),
            inArray(test.id, testIds),
            isNull(test.deletedAt),
          ),
        ),
      );
    if (found.length !== testIds.length) {
      throw new UnprocessableInputError(
        "grader scope names a test that is not active in this project",
      );
    }
  }
}

export async function listProjectGraders(
  auth: AuthContext,
): Promise<readonly ProjectGrader[]> {
  authorize(auth, "read", here(auth));
  const rows = await db()
    .select(COLUMNS)
    .from(projectGrader)
    .innerJoin(
      graderDefinition,
      eq(graderDefinition.id, projectGrader.graderDefinitionId),
    )
    .where(
      within(
        auth,
        projectGrader,
        and(isNull(projectGrader.archivedAt), inActingProject(auth, projectGrader)),
      ),
    )
    .orderBy(asc(graderDefinition.name), asc(projectGrader.id));
  return rows.map(fromRow);
}

export async function getProjectGrader(
  auth: AuthContext,
  id: string,
): Promise<ProjectGrader | undefined> {
  authorize(auth, "read", here(auth));
  const [row] = await db()
    .select(COLUMNS)
    .from(projectGrader)
    .innerJoin(
      graderDefinition,
      eq(graderDefinition.id, projectGrader.graderDefinitionId),
    )
    .where(
      within(
        auth,
        projectGrader,
        and(
          eq(projectGrader.id, id),
          isNull(projectGrader.archivedAt),
          inActingProject(auth, projectGrader),
        ),
      ),
    )
    .limit(1);
  return row === undefined ? undefined : fromRow(row);
}

export async function editProjectGrader(
  auth: AuthContext,
  id: string,
  changes: ProjectGraderChanges,
): Promise<ProjectGrader | undefined> {
  authorize(auth, "author_definitions", here(auth));
  return db().transaction(async (tx) => {
    const [held] = await tx
      .select(COLUMNS)
      .from(projectGrader)
      .innerJoin(
        graderDefinition,
        eq(graderDefinition.id, projectGrader.graderDefinitionId),
      )
      .where(
        within(
          auth,
          projectGrader,
          and(
            eq(projectGrader.id, id),
            isNull(projectGrader.archivedAt),
            inActingProject(auth, projectGrader),
          ),
        ),
      )
      .limit(1)
      .for("update", { of: projectGrader });
    if (held === undefined) return undefined;

    const scope = changes.scope === undefined
      ? validateProjectGraderScope(held.scope)
      : validateProjectGraderScope(changes.scope);
    if (changes.scope !== undefined && !held.scopeEditable) {
      throw new UnprocessableInputError(
        `the scope of ${held.name} is managed by Egma and cannot be changed`,
      );
    }
    if (changes.scope !== undefined) {
      await validateScopeReferences(tx, auth, held.projectId, scope);
    }
    const passThreshold = changes.passThreshold === undefined
      ? held.passThreshold
      : validatePassThreshold(changes.passThreshold);

    const [updated] = await tx
      .update(projectGrader)
      .set({ scope, passThreshold, updatedAt: new Date() })
      .where(eq(projectGrader.id, id))
      .returning({ updatedAt: projectGrader.updatedAt });
    if (updated === undefined) return undefined;
    return fromRow({ ...held, scope, passThreshold, updatedAt: updated.updatedAt });
  });
}

/** Archive an optional project grader. Expected behaviors cannot be removed. */
export async function archiveProjectGrader(
  auth: AuthContext,
  id: string,
): Promise<boolean> {
  authorize(auth, "author_definitions", here(auth));
  return db().transaction(async (tx) => {
    const [held] = await tx
      .select({ definitionId: projectGrader.graderDefinitionId })
      .from(projectGrader)
      .where(
        within(
          auth,
          projectGrader,
          and(
            eq(projectGrader.id, id),
            isNull(projectGrader.archivedAt),
            inActingProject(auth, projectGrader),
          ),
        ),
      )
      .limit(1)
      .for("update");
    if (held === undefined) return false;
    if (held.definitionId === PREDEFINED_GRADERS.expectedBehaviors) {
      throw new UnprocessableInputError("Expected behaviors cannot be removed from a project");
    }
    await tx
      .update(projectGrader)
      .set({ archivedAt: new Date(), updatedAt: new Date() })
      .where(eq(projectGrader.id, id));
    return true;
  });
}

const EXECUTABLE_COLUMNS = {
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

/** Read one exact immutable definition version for execution. */
export async function getExecutableGraderDefinition(
  auth: AuthContext,
  on: Queryable,
  definitionId: string,
  version: number,
): Promise<GraderDefinitionSnapshot | undefined> {
  authorize(auth, "read", here(auth));
  const [row] = await on
    .select(EXECUTABLE_COLUMNS)
    .from(graderDefinitionVersion)
    .innerJoin(
      graderDefinition,
      eq(graderDefinition.id, graderDefinitionVersion.definitionId),
    )
    .where(
      and(
        eq(graderDefinitionVersion.definitionId, definitionId),
        eq(graderDefinitionVersion.version, version),
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
      ),
    )
    .limit(1);
  return row === undefined ? undefined : snapshotGraderDefinition(row);
}
