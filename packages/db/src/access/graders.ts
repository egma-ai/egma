import { newId } from "@egma/ids";
import { and, asc, desc, eq, inArray, isNull, or } from "drizzle-orm";

import { db, type Queryable } from "../client.ts";
import { PREDEFINED_GRADERS } from "../grader-library/catalog.ts";
import {
  defaultGraderParameterValues,
  LLM_GRADER_PARAMETER_CONTRACT,
  validateExecutableGraderParameters,
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
import {
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
import { IdentityConflictError, UnprocessableInputError } from "./errors.ts";
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
  readonly owner: "egma" | "project";
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
  readonly parameterValues?: unknown;
  readonly passThreshold: number;
};

export type CreateCustomLlmGraderInput = {
  readonly name: string;
  readonly description?: string | null | undefined;
  /** What the judge decides. */
  readonly gradingInstructions: string;
  /** What scores 1. */
  readonly passesWhen: string;
  /** What scores 0. */
  readonly failsWhen: string;
  readonly scope: unknown;
  readonly passThreshold: number;
  readonly parameterValues?: unknown;
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
    owner: organizationOwnerId === null ? "egma" : "project",
    scope: validateProjectGraderScope(row.scope),
    parameterValues: validateExecutableGraderParameters(
      row.type,
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
    and(isNull(graderDefinition.organizationId), isNull(graderDefinition.projectId)),
    and(
      eq(graderDefinition.organizationId, auth.organizationId),
      eq(graderDefinition.projectId, auth.projectId ?? ""),
    ),
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

/**
 * The one prompt an authored boundary compiles to.
 *
 * A binary judge answers met or not met against a criterion, so the sheet asks
 * for the criterion and the two sides of the line, and the server writes the
 * one immutable prompt. Every client that sends the three parts therefore
 * produces the same judged behavior. The parts are not stored beside the
 * prompt: a definition version is immutable, and an edit mints a new one.
 */
function compileGraderBoundary(boundary: {
  readonly gradingInstructions: string;
  readonly passesWhen: string;
  readonly failsWhen: string;
}): string {
  return (
    `Decide whether: ${boundary.gradingInstructions}. ` +
    `Answer met when: ${boundary.passesWhen}. ` +
    `Answer not_met when: ${boundary.failsWhen}.`
  );
}

/**
 * What a custom definition stamps for modalities, now that nobody is asked.
 *
 * Both, because the stamp is immutable per version and the judge's evidence is
 * text: a voice-only stamp would silently leave every later chat simulation
 * ungraded, with no grade row and no warning to say so.
 */
const CUSTOM_GRADER_MODALITIES: readonly GraderModality[] = ["chat", "voice"];

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
    const [identity] = await tx.select().from(graderDefinition)
      .where(and(eq(graderDefinition.id, definitionId), visibleDefinition(auth)))
      .for("update");
    if (identity === undefined) return undefined;
    const [definition] = await tx
      .select({
        parameterContract: graderDefinitionVersion.parameterContract,
        type: graderDefinitionVersion.type,
      })
      .from(graderDefinition)
      .innerJoin(graderDefinitionVersion, currentVersionJoin())
      .where(
        and(eq(graderDefinition.id, definitionId), visibleDefinition(auth)),
      )
      .limit(1);
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
      return active.id;
    }

    const [previous] = await tx.select({ parameterValues: projectGrader.parameterValues })
      .from(projectGrader)
      .where(and(inActingProject(auth, projectGrader), eq(projectGrader.graderDefinitionId, definitionId)))
      .orderBy(desc(projectGrader.updatedAt))
      .limit(1);
    await validateScopeReferences(tx, auth, projectId, scope);
    const parameterValues = validateExecutableGraderParameters(
      definition.type,
      definition.parameterContract,
      input.parameterValues ?? previous?.parameterValues ?? defaultGraderParameterValues(definition.parameterContract),
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
    const [association] = await tx.select({ definitionId: projectGrader.graderDefinitionId })
      .from(projectGrader).where(within(auth, projectGrader, and(
        eq(projectGrader.id, id), isNull(projectGrader.archivedAt), inActingProject(auth, projectGrader),
      )));
    if (association === undefined) return undefined;
    const [definition] = await tx.select({ id: graderDefinition.id }).from(graderDefinition)
      .where(and(eq(graderDefinition.id, association.definitionId), visibleDefinition(auth))).for("update");
    if (definition === undefined) return undefined;
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
      ? validateExecutableGraderParameters(
          held.type,
          held.parameterContract,
          held.parameterValues,
        )
      : validateExecutableGraderParameters(
          held.type,
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

/** Create one project LLM definition and its complete project settings. */
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
  const passesWhen = input.passesWhen.trim();
  const failsWhen = input.failsWhen.trim();
  if (name === "") {
    throw new UnprocessableInputError("a custom grader needs a name");
  }
  if (gradingInstructions === "") {
    throw new UnprocessableInputError(
      "a custom grader needs grading instructions",
    );
  }
  if (passesWhen === "") {
    throw new UnprocessableInputError(
      "a custom grader needs the text for Passes when",
    );
  }
  if (failsWhen === "") {
    throw new UnprocessableInputError(
      "a custom grader needs the text for Fails when",
    );
  }
  const prompt = compileGraderBoundary({
    gradingInstructions,
    passesWhen,
    failsWhen,
  });
  const description = input.description?.trim() || null;
  const scope = validateProjectGraderScope(input.scope);
  const passThreshold = validatePassThreshold(input.passThreshold);
  const parameterValues = validateExecutableGraderParameters(
    "llm_as_judge",
    LLM_GRADER_PARAMETER_CONTRACT,
    input.parameterValues ?? defaultGraderParameterValues(LLM_GRADER_PARAMETER_CONTRACT),
  );

  const ids = await db().transaction(async (tx) => {
    await validateScopeReferences(tx, auth, projectId, scope);
    const definitionId = newId("grl");
    const projectGraderId = newId("grd");
    await tx.insert(graderDefinition).values({
      id: definitionId,
      organizationId: auth.organizationId,
      projectId,
      name,
      description,
      scopeEditable: true,
      currentDefinitionVersion: 1,
    });
    await tx.insert(graderDefinitionVersion).values({
      definitionId,
      version: 1,
      type: "llm_as_judge",
      prompt,
      parameterContract: LLM_GRADER_PARAMETER_CONTRACT,
      modalities: CUSTOM_GRADER_MODALITIES,
    });
    await tx.insert(projectGrader).values({
      id: projectGraderId,
      organizationId: auth.organizationId,
      projectId,
      graderDefinitionId: definitionId,
      scope,
      parameterValues,
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
  modalities: graderDefinitionVersion.modalities,
} as const;

/** Clone the current LLM core and this project's effective settings atomically. */
export async function cloneGraderInProject(
  auth: AuthContext,
  definitionId: string,
  input: { readonly name: string; readonly description?: string | null },
): Promise<{ readonly definition: GraderLibraryEntry; readonly projectGrader: ProjectGrader } | undefined> {
  authorize(auth, "author_definitions", here(auth));
  const projectId = projectIdOf(auth);
  const name = input.name.trim();
  if (name === "") throw new UnprocessableInputError("a cloned grader needs a name");
  const ids = await db().transaction(async (tx) => {
    const [source] = await tx.select().from(graderDefinition)
      .where(and(eq(graderDefinition.id, definitionId), visibleDefinition(auth)))
      .for("update");
    if (source === undefined) return undefined;
    const core = await getExecutableGraderDefinition(auth, tx, source.id, source.currentDefinitionVersion);
    if (core?.type !== "llm_as_judge") {
      throw new UnprocessableInputError("only LLM graders can be cloned");
    }
    const [settings] = await tx.select().from(projectGrader)
      .where(within(auth, projectGrader, and(
        eq(projectGrader.projectId, projectId), eq(projectGrader.graderDefinitionId, definitionId),
      )))
      .orderBy(desc(projectGrader.updatedAt)).limit(1);
    const parameterValues = validateExecutableGraderParameters(core.type, core.parameterContract,
      settings?.parameterValues ?? defaultGraderParameterValues(core.parameterContract));
    const clonedId = newId("grl");
    const projectGraderId = newId("grd");
    await tx.insert(graderDefinition).values({
      id: clonedId, organizationId: auth.organizationId, projectId, name,
      description: input.description === undefined ? source.description : input.description?.trim() || null,
      scopeEditable: true, currentDefinitionVersion: 1,
    });
    await tx.insert(graderDefinitionVersion).values({
      definitionId: clonedId, version: 1, type: core.type, prompt: core.prompt,
      parameterContract: core.parameterContract, modalities: core.modalities,
    });
    await tx.insert(projectGrader).values({
      id: projectGraderId, organizationId: auth.organizationId, projectId,
      graderDefinitionId: clonedId, parameterValues,
      scope: settings?.scope ?? { simulations: [{ kind: "all" }], production: null },
      passThreshold: settings?.passThreshold ?? 1,
    });
    return { definitionId: clonedId, projectGraderId };
  });
  if (ids === undefined) return undefined;
  const [definition, active] = await Promise.all([
    getGraderLibraryEntry(auth, ids.definitionId), getProjectGrader(auth, ids.projectGraderId),
  ]);
  if (definition === undefined || active === undefined) throw new Error("the cloned grader is not readable");
  return { definition, projectGrader: active };
}

/** Only the current custom core can be the base for a new immutable version. */
export async function editGraderDefinition(
  auth: AuthContext,
  definitionId: string,
  input: {
    readonly baseDefinitionVersion: number;
    readonly gradingInstructions?: string;
    readonly name?: string;
    readonly description?: string | null;
  },
): Promise<GraderLibraryEntry | undefined> {
  authorize(auth, "author_definitions", here(auth));
  projectIdOf(auth);
  const changed = await db().transaction(async (tx) => {
    const [held] = await tx.select().from(graderDefinition)
      .where(and(eq(graderDefinition.id, definitionId), visibleDefinition(auth))).for("update");
    if (held === undefined) return false;
    if (held.organizationId === null) {
      throw new UnprocessableInputError("Egma grader cores are read-only; clone this grader to edit its instructions");
    }
    if (input.baseDefinitionVersion !== held.currentDefinitionVersion) {
      throw new IdentityConflictError("grader", definitionId, {
        expected: String(input.baseDefinitionVersion), current: String(held.currentDefinitionVersion),
      });
    }
    const core = await getExecutableGraderDefinition(auth, tx, definitionId, held.currentDefinitionVersion);
    if (core?.type !== "llm_as_judge") throw new UnprocessableInputError("only custom LLM cores can be edited");
    const name = input.name === undefined ? held.name : input.name.trim();
    const prompt = input.gradingInstructions === undefined ? core.prompt : input.gradingInstructions.trim();
    if (name === "" || !prompt) throw new UnprocessableInputError("a grader needs a name and grading instructions");
    let version = held.currentDefinitionVersion;
    if (prompt !== core.prompt) {
      version += 1;
      await tx.insert(graderDefinitionVersion).values({
        definitionId, version, type: core.type, prompt,
        parameterContract: core.parameterContract, modalities: core.modalities,
      });
    }
    await tx.update(graderDefinition).set({
      name, description: input.description === undefined ? held.description : input.description?.trim() || null,
      currentDefinitionVersion: version, updatedAt: new Date(),
    }).where(eq(graderDefinition.id, definitionId));
    return true;
  });
  return changed ? getGraderLibraryEntry(auth, definitionId) : undefined;
}

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
