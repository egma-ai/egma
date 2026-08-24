import { newId } from "@egma/ids";
import { and, asc, eq, inArray, isNull, or } from "drizzle-orm";

import { db, type Queryable } from "../client.ts";
import {
  NORMALIZED_GRADE_OUTPUT_CONTRACT,
  PREDEFINED_GRADERS,
} from "../grader-library/catalog.ts";
import {
  validateGraderParameterValues,
  type GraderParameterValues,
} from "../grader-library/parameters.ts";
import {
  validatePassThreshold,
  validateProjectGraderScope,
} from "../grader-library/policy.ts";
import {
  snapshotGraderDefinition,
  type GraderDefinitionSnapshot,
} from "../grader-library/snapshot.ts";
import { RECOMMENDED_GRADER_MODEL } from "../models/selections.ts";
import {
  GRADER_MODALITIES,
  graderDefinition,
  graderDefinitionVersion,
  projectGrader,
  type GraderDefinitionType,
  type GraderModality,
  type ProjectGraderScope,
  type SimulationScopeSelector,
} from "../schema/graders.ts";
import { test, testSuite } from "../schema/tests.ts";
import type { AuthContext } from "./context.ts";
import { UnprocessableInputError } from "./errors.ts";
import {
  getGraderLibraryEntry,
  type GraderLibraryEntry,
} from "./grader-library.ts";
import { authorize, here } from "./permissions.ts";
import { inActingProject, within } from "./within.ts";

export type { GraderDefinitionSnapshot } from "../grader-library/snapshot.ts";

export type ProjectGrader = {
  readonly id: string;
  readonly projectId: string;
  readonly graderDefinitionId: string;
  readonly name: string;
  readonly description: string | null;
  readonly type: GraderDefinitionType;
  readonly owner: "egma" | "organization";
  readonly modalities: readonly GraderModality[];
  readonly scopeEditable: boolean;
  readonly scope: ProjectGraderScope;
  readonly parameterValues: GraderParameterValues;
  readonly passThreshold: number;
  readonly currentDefinitionVersion: number;
  readonly archivedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

export type ProjectGraderChanges = {
  readonly scope?: unknown;
  readonly parameterValues?: unknown;
  readonly passThreshold?: number;
};

export type UseGraderInProjectInput = {
  readonly scope: unknown;
  readonly parameterValues: unknown;
  readonly passThreshold: number;
};

export type CreateCustomLlmGraderInput = {
  readonly name: string;
  readonly description?: string | null | undefined;
  readonly gradingInstructions: string;
  readonly modalities: unknown;
  readonly scope: unknown;
  readonly passThreshold: number;
};

const COLUMNS = {
  id: projectGrader.id,
  projectId: projectGrader.projectId,
  graderDefinitionId: projectGrader.graderDefinitionId,
  name: graderDefinition.name,
  description: graderDefinition.description,
  organizationOwnerId: graderDefinition.organizationId,
  type: graderDefinitionVersion.type,
  modalities: graderDefinitionVersion.modalities,
  parameterContract: graderDefinitionVersion.parameterContract,
  scopeEditable: graderDefinition.scopeEditable,
  scope: projectGrader.scope,
  parameterValues: projectGrader.parameterValues,
  passThreshold: projectGrader.passThreshold,
  currentDefinitionVersion: graderDefinition.currentDefinitionVersion,
  archivedAt: projectGrader.archivedAt,
  createdAt: projectGrader.createdAt,
  updatedAt: projectGrader.updatedAt,
} as const;

type ProjectGraderRow = {
  readonly id: string;
  readonly projectId: string;
  readonly graderDefinitionId: string;
  readonly name: string;
  readonly description: string | null;
  readonly organizationOwnerId: string | null;
  readonly type: string;
  readonly modalities: readonly GraderModality[];
  readonly parameterContract: unknown;
  readonly scopeEditable: boolean;
  readonly scope: unknown;
  readonly parameterValues: unknown;
  readonly passThreshold: number;
  readonly currentDefinitionVersion: number;
  readonly archivedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

function fromRow(row: ProjectGraderRow): ProjectGrader {
  const {
    organizationOwnerId,
    parameterContract,
    ...visible
  } = row;
  return {
    ...visible,
    type: row.type as GraderDefinitionType,
    owner: organizationOwnerId === null ? "egma" : "organization",
    scope: validateProjectGraderScope(row.scope),
    parameterValues: validateGraderParameterValues(
      parameterContract,
      row.parameterValues,
    ),
  };
}

function currentVersionJoin() {
  return and(
    eq(graderDefinitionVersion.definitionId, graderDefinition.id),
    eq(
      graderDefinitionVersion.version,
      graderDefinition.currentDefinitionVersion,
    ),
  );
}

function projectIdOf(auth: AuthContext): string {
  if (auth.projectId === undefined || auth.projectId === "") {
    throw new TypeError("project grader changes require a project-scoped context");
  }
  return auth.projectId;
}

function visibleDefinition(auth: AuthContext) {
  return or(
    isNull(graderDefinition.organizationId),
    eq(graderDefinition.organizationId, auth.organizationId),
  );
}

async function validateScopeReferences(
  on: Queryable,
  auth: AuthContext,
  projectId: string,
  scope: ProjectGraderScope,
): Promise<void> {
  const suiteIds = scope.simulations
    .filter((one): one is Extract<SimulationScopeSelector, { kind: "test_suite" }> =>
      one.kind === "test_suite"
    )
    .map((one) => one.id);
  const testIds = scope.simulations
    .filter((one): one is Extract<SimulationScopeSelector, { kind: "test" }> =>
      one.kind === "test"
    )
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

function validateModalities(value: unknown): readonly GraderModality[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    new Set(value).size !== value.length ||
    value.some(
      (modality) =>
        typeof modality !== "string" ||
        !(GRADER_MODALITIES as readonly string[]).includes(modality),
    )
  ) {
    throw new UnprocessableInputError(
      "compatible modalities must contain chat, voice, or both once",
    );
  }
  return value as readonly GraderModality[];
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
    .innerJoin(graderDefinitionVersion, currentVersionJoin())
    .where(
      and(
        within(
          auth,
          projectGrader,
          and(
            isNull(projectGrader.archivedAt),
            inActingProject(auth, projectGrader),
          ),
        ),
        visibleDefinition(auth),
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
    .innerJoin(graderDefinitionVersion, currentVersionJoin())
    .where(
      and(
        within(
          auth,
          projectGrader,
          and(
            eq(projectGrader.id, id),
            isNull(projectGrader.archivedAt),
            inActingProject(auth, projectGrader),
          ),
        ),
        visibleDefinition(auth),
      ),
    )
    .limit(1);
  return row === undefined ? undefined : fromRow(row);
}

/** Activate one visible library definition for the current project. */
export async function useGraderInProject(
  auth: AuthContext,
  definitionId: string,
  input: UseGraderInProjectInput,
): Promise<ProjectGrader | undefined> {
  authorize(auth, "author_definitions", here(auth));
  const projectId = projectIdOf(auth);
  const scope = validateProjectGraderScope(input.scope);
  const passThreshold = validatePassThreshold(input.passThreshold);

  const id = await db().transaction(async (tx) => {
    const [definition] = await tx
      .select({
        parameterContract: graderDefinitionVersion.parameterContract,
      })
      .from(graderDefinition)
      .innerJoin(graderDefinitionVersion, currentVersionJoin())
      .where(
        and(eq(graderDefinition.id, definitionId), visibleDefinition(auth)),
      )
      .limit(1)
      .for("update", { of: graderDefinition });
    if (definition === undefined) return undefined;

    const [active] = await tx
      .select({ id: projectGrader.id })
      .from(projectGrader)
      .where(
        within(
          auth,
          projectGrader,
          and(
            eq(projectGrader.projectId, projectId),
            eq(projectGrader.graderDefinitionId, definitionId),
            isNull(projectGrader.archivedAt),
          ),
        ),
      )
      .limit(1);
    if (active !== undefined) {
      throw new UnprocessableInputError(
        "this grader is already active in the project",
      );
    }

    await validateScopeReferences(tx, auth, projectId, scope);
    const parameterValues = validateGraderParameterValues(
      definition.parameterContract,
      input.parameterValues,
    );
    const projectGraderId = newId("grd");
    await tx.insert(projectGrader).values({
      id: projectGraderId,
      organizationId: auth.organizationId,
      projectId,
      graderDefinitionId: definitionId,
      scope,
      parameterValues,
      passThreshold,
    });
    return projectGraderId;
  });
  return id === undefined ? undefined : getProjectGrader(auth, id);
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
      .innerJoin(graderDefinitionVersion, currentVersionJoin())
      .where(
        and(
          within(
            auth,
            projectGrader,
            and(
              eq(projectGrader.id, id),
              isNull(projectGrader.archivedAt),
              inActingProject(auth, projectGrader),
            ),
          ),
          visibleDefinition(auth),
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
    const parameterValues = changes.parameterValues === undefined
      ? validateGraderParameterValues(
          held.parameterContract,
          held.parameterValues,
        )
      : validateGraderParameterValues(
          held.parameterContract,
          changes.parameterValues,
        );
    const passThreshold = changes.passThreshold === undefined
      ? held.passThreshold
      : validatePassThreshold(changes.passThreshold);

    const [updated] = await tx
      .update(projectGrader)
      .set({
        scope,
        parameterValues,
        passThreshold,
        updatedAt: new Date(),
      })
      .where(eq(projectGrader.id, id))
      .returning({ updatedAt: projectGrader.updatedAt });
    if (updated === undefined) return undefined;
    return fromRow({
      ...held,
      scope,
      parameterValues,
      passThreshold,
      updatedAt: updated.updatedAt,
    });
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
      throw new UnprocessableInputError(
        "Expected behaviors cannot be removed from a project",
      );
    }
    await tx
      .update(projectGrader)
      .set({ archivedAt: new Date(), updatedAt: new Date() })
      .where(eq(projectGrader.id, id));
    return true;
  });
}

/** Create one organization LLM definition and activate it in this project. */
export async function createCustomLlmGrader(
  auth: AuthContext,
  input: CreateCustomLlmGraderInput,
): Promise<{
  readonly definition: GraderLibraryEntry;
  readonly projectGrader: ProjectGrader;
}> {
  authorize(auth, "author_definitions", here(auth));
  const projectId = projectIdOf(auth);
  const name = input.name.trim();
  const gradingInstructions = input.gradingInstructions.trim();
  if (name === "") {
    throw new UnprocessableInputError("a custom grader needs a name");
  }
  if (gradingInstructions === "") {
    throw new UnprocessableInputError(
      "a custom grader needs grading instructions",
    );
  }
  const description = input.description?.trim() || null;
  const modalities = validateModalities(input.modalities);
  const scope = validateProjectGraderScope(input.scope);
  const passThreshold = validatePassThreshold(input.passThreshold);

  const ids = await db().transaction(async (tx) => {
    await validateScopeReferences(tx, auth, projectId, scope);
    const definitionId = newId("grl");
    const projectGraderId = newId("grd");
    await tx.insert(graderDefinition).values({
      id: definitionId,
      organizationId: auth.organizationId,
      name,
      description,
      scopeEditable: true,
      currentDefinitionVersion: 1,
    });
    await tx.insert(graderDefinitionVersion).values({
      definitionId,
      version: 1,
      type: "llm_as_judge",
      prompt: gradingInstructions,
      parameterContract: [],
      outputContract: NORMALIZED_GRADE_OUTPUT_CONTRACT,
      modalities,
      judgeModel: RECOMMENDED_GRADER_MODEL,
    });
    await tx.insert(projectGrader).values({
      id: projectGraderId,
      organizationId: auth.organizationId,
      projectId,
      graderDefinitionId: definitionId,
      scope,
      parameterValues: {},
      passThreshold,
    });
    return { definitionId, projectGraderId };
  });

  const [definition, active] = await Promise.all([
    getGraderLibraryEntry(auth, ids.definitionId),
    getProjectGrader(auth, ids.projectGraderId),
  ]);
  if (definition === undefined || active === undefined) {
    throw new Error("new custom grader was not readable after creation");
  }
  return { definition, projectGrader: active };
}

const EXECUTABLE_COLUMNS = {
  definitionId: graderDefinitionVersion.definitionId,
  version: graderDefinitionVersion.version,
  type: graderDefinitionVersion.type,
  prompt: graderDefinitionVersion.prompt,
  parameterContract: graderDefinitionVersion.parameterContract,
  outputContract: graderDefinitionVersion.outputContract,
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
        visibleDefinition(auth),
      ),
    )
    .limit(1);
  return row === undefined ? undefined : snapshotGraderDefinition(row);
}
