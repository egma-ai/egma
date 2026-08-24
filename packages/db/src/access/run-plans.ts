import { newId } from "@egma/ids";
import { and, asc, eq, inArray, isNull, or } from "drizzle-orm";

import { db, type Queryable } from "../client.ts";
import { validateGraderParameterValues } from "../grader-library/parameters.ts";
import { snapshotGraderDefinition } from "../grader-library/snapshot.ts";
import {
  planGroupsFor,
  productionSampleSelected,
  type ExecutableProjectGrader,
  type PlanGroup,
  type ProjectGraderCandidate,
} from "../grading/plan.ts";
import type { GraderModality, ProjectGraderScope } from "../schema/graders.ts";
import {
  graderDefinition,
  graderDefinitionVersion,
  projectGrader,
} from "../schema/graders.ts";
import { persona } from "../schema/personas.ts";
import { gradingPlan, type GradingPlanState } from "../schema/plans.ts";
import { simulation } from "../schema/runs.ts";
import type { AuthContext } from "./context.ts";
import { RunWriteRefusedError, type RunWriteRefusal } from "./errors.ts";
import { getExecutableGraderDefinition } from "./graders.ts";
import { personaAvailableToProject } from "./persona-availability.ts";
import { within } from "./within.ts";

export function refuseRun(reason: RunWriteRefusal, message: string): never {
  throw new RunWriteRefusedError(reason, message);
}

/** Pin each named persona at its current immutable version. */
export async function resolvePersonaVersions(
  auth: AuthContext,
  on: Queryable,
  projectId: string,
  ids: readonly string[],
): Promise<readonly { personaId: string; personaVersionId: string }[]> {
  const unique = [...new Set(ids)];
  const found = new Map(
    (
      await on
        .select({
          id: persona.id,
          archivedAt: persona.archivedAt,
          currentVersionId: persona.currentVersionId,
        })
        .from(persona)
        .where(
          personaAvailableToProject(auth, projectId, inArray(persona.id, unique)),
        )
        .for("share")
    ).map((row) => [row.id, row] as const),
  );
  return ids.map((id) => {
    const row = found.get(id);
    if (row === undefined || row.archivedAt !== null) {
      refuseRun("not_admitted", `persona ${id} is not active in this project`);
    }
    return { personaId: id, personaVersionId: row.currentVersionId };
  });
}

export type GradingPlan = {
  readonly runId: string;
  readonly state: GradingPlanState;
  readonly capturedAt: Date;
  readonly groups: readonly PlanGroup[];
};

const CANDIDATE_COLUMNS = {
  projectGraderId: projectGrader.id,
  graderName: graderDefinition.name,
  passThreshold: projectGrader.passThreshold,
  parameterValues: projectGrader.parameterValues,
  scope: projectGrader.scope,
  definitionId: graderDefinitionVersion.definitionId,
  version: graderDefinitionVersion.version,
  type: graderDefinitionVersion.type,
  prompt: graderDefinitionVersion.prompt,
  parameterContract: graderDefinitionVersion.parameterContract,
  outputContract: graderDefinitionVersion.outputContract,
  modalities: graderDefinitionVersion.modalities,
  judgeModel: graderDefinitionVersion.judgeModel,
} as const;

/** Read the active project policy and its one current immutable definition. */
export async function applicableGraders(
  auth: AuthContext,
  on: Queryable,
  projectId: string,
): Promise<readonly ProjectGraderCandidate[]> {
  const rows = await on
    .select(CANDIDATE_COLUMNS)
    .from(projectGrader)
    .innerJoin(
      graderDefinition,
      eq(graderDefinition.id, projectGrader.graderDefinitionId),
    )
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
    .where(
      and(
        within(
          auth,
          projectGrader,
          and(
            eq(projectGrader.projectId, projectId),
            isNull(projectGrader.archivedAt),
          ),
        ),
        or(
          isNull(graderDefinition.organizationId),
          eq(graderDefinition.organizationId, auth.organizationId),
        ),
      ),
    )
    .orderBy(asc(projectGrader.id))
    .for("share", { of: projectGrader });

  return rows.map((row) => {
    const definition = snapshotGraderDefinition(row);
    return {
      projectGraderId: row.projectGraderId,
      graderName: row.graderName,
      passThreshold: row.passThreshold,
      parameterValues: validateGraderParameterValues(
        definition.parameterContract,
        row.parameterValues,
      ),
      scope: row.scope as ProjectGraderScope,
      definition,
    };
  });
}

/** Resolve and freeze the graders for one completed production trace. */
export async function resolveProductionGraders(
  auth: AuthContext,
  on: Queryable,
  input: {
    readonly projectId: string;
    readonly modality: GraderModality;
    readonly traceId: string;
  },
): Promise<readonly ExecutableProjectGrader[]> {
  const candidates = await applicableGraders(auth, on, input.projectId);
  return candidates
    .filter((candidate) => {
      const production = candidate.scope.production;
      return candidate.definition.modalities.includes(input.modality) &&
        production !== null &&
        productionSampleSelected(
          input.traceId,
          candidate.projectGraderId,
          production.sample_percent,
        );
    })
    .map(({ projectGraderId, passThreshold, parameterValues, definition }) => ({
      projectGraderId,
      passThreshold,
      parameterValues,
      definition,
    }));
}

export async function writeGradingPlan(
  auth: AuthContext,
  on: Queryable,
  input: {
    readonly runId: string;
    readonly groups: readonly PlanGroup[];
    readonly capturedAt: Date;
  },
): Promise<void> {
  if (auth.projectId === undefined) {
    throw new TypeError("writing a grading plan requires a project-scoped context");
  }
  await on.insert(gradingPlan).values({
    id: newId("gpl"),
    runId: input.runId,
    organizationId: auth.organizationId,
    projectId: auth.projectId,
    state: "run_start",
    capturedAt: input.capturedAt,
    groups: input.groups,
  });
}

export async function getGradingPlan(
  auth: AuthContext,
  runId: string,
): Promise<GradingPlan | undefined> {
  const [row] = await db()
    .select({
      runId: gradingPlan.runId,
      state: gradingPlan.state,
      capturedAt: gradingPlan.capturedAt,
      groups: gradingPlan.groups,
    })
    .from(gradingPlan)
    .where(within(auth, gradingPlan, eq(gradingPlan.runId, runId)))
    .limit(1);
  if (row === undefined) return undefined;
  return {
    runId: row.runId,
    state: row.state as GradingPlanState,
    capturedAt: row.capturedAt,
    groups: row.groups as readonly PlanGroup[],
  };
}

async function selectedSimulationPlanGroupOn(
  auth: AuthContext,
  on: Queryable,
  simulationId: string,
): Promise<PlanGroup | undefined> {
  const [row] = await on
    .select({
      testId: simulation.testId,
      testVersionId: simulation.testVersionId,
      groups: gradingPlan.groups,
    })
    .from(simulation)
    .innerJoin(gradingPlan, eq(gradingPlan.runId, simulation.runId))
    .where(within(auth, simulation, eq(simulation.id, simulationId)))
    .limit(1);
  if (row === undefined) return undefined;

  const group = (row.groups as readonly PlanGroup[]).find(
    (one) =>
      one.tag === "test" &&
      one.testId === row.testId &&
      one.testVersionId === row.testVersionId,
  );
  if (group === undefined) {
    throw new Error(`simulation ${simulationId} has no matching test grading plan`);
  }
  return group;
}

/** Whether this simulation's frozen run plan names any grading work. */
export async function simulationHasPlannedGradersOn(
  auth: AuthContext,
  on: Queryable,
  simulationId: string,
): Promise<boolean | undefined> {
  const group = await selectedSimulationPlanGroupOn(auth, on, simulationId);
  return group === undefined ? undefined : group.items.length > 0;
}

/** Resolve the exact grader versions frozen for one simulation. */
export async function pinnedSimulationGradersOn(
  auth: AuthContext,
  on: Queryable,
  simulationId: string,
): Promise<readonly ExecutableProjectGrader[] | undefined> {
  const group = await selectedSimulationPlanGroupOn(auth, on, simulationId);
  if (group === undefined) return undefined;

  return Promise.all(
    group.items.map(async (item) => {
      const definition = await getExecutableGraderDefinition(
        auth,
        on,
        item.graderDefinitionId,
        item.graderDefinitionVersion,
      );
      if (definition === undefined || definition.type !== item.type) {
        throw new Error(
          `grading plan for simulation ${simulationId} names an unreadable grader definition`,
        );
      }
      return {
        projectGraderId: item.projectGraderId,
        passThreshold: item.passThreshold,
        parameterValues: item.parameterValues,
        definition,
      };
    }),
  );
}

export function pinnedSimulationGraders(
  auth: AuthContext,
  simulationId: string,
): Promise<readonly ExecutableProjectGrader[] | undefined> {
  return pinnedSimulationGradersOn(auth, db(), simulationId);
}
