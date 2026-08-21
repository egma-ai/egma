import { newId } from "@egma/ids";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";

import { db, type Queryable } from "../client.ts";
import { grader, type GraderScope } from "../schema/graders.ts";
import { persona } from "../schema/personas.ts";
import { gradingPlan, type GradingPlanState } from "../schema/plans.ts";
import { simulation } from "../schema/runs.ts";
import type { AuthContext } from "./context.ts";
import { RunWriteRefusedError, type RunWriteRefusal } from "./errors.ts";
import { getGraderVersion, type ExecutableGrader } from "./graders.ts";
import { personaAvailableToProject } from "./persona-availability.ts";
import { within } from "./within.ts";

export function refuseRun(reason: RunWriteRefusal, message: string): never {
  throw new RunWriteRefusedError(reason, message);
}

/** Pin each named persona at its current immutable version. */
export async function resolvePersonaVersions(
  on: Queryable,
  auth: AuthContext,
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
          personaAvailableToProject(
            auth,
            projectId,
            inArray(persona.id, unique),
          ),
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

export type PlanItem = {
  readonly kind: "authored";
  readonly graderId: string;
  readonly graderVersionId: string;
  readonly graderName: string;
  readonly libraryId: string;
  readonly required: boolean;
  readonly scope: GraderScope;
};

export type PlanGroup = {
  readonly tag: "suite";
  readonly items: readonly PlanItem[];
};

export type GradingPlan = {
  readonly runId: string;
  readonly state: GradingPlanState;
  readonly capturedAt: Date;
  readonly groups: readonly PlanGroup[];
};

type ApplicableGrader = {
  readonly id: string;
  readonly name: string;
  readonly currentVersionId: string;
  readonly libraryId: string;
  readonly required: boolean;
  readonly scope: GraderScope;
};

export async function applicableGraders(
  on: Queryable,
  auth: AuthContext,
  projectId: string,
): Promise<ReadonlyMap<string, ApplicableGrader>> {
  const rows = await on
    .select({
      id: grader.id,
      name: grader.name,
      libraryId: grader.libraryId,
      required: grader.required,
      scope: grader.scope,
      currentVersionId: grader.currentVersionId,
    })
    .from(grader)
    .where(
      within(
        auth,
        grader,
        and(eq(grader.projectId, projectId), isNull(grader.deletedAt)),
      ),
    )
    .orderBy(asc(grader.id));
  return new Map(
    rows.map((row) => [row.id, { ...row, scope: row.scope as GraderScope }] as const),
  );
}

export function planGroupsFor(
  graders: ReadonlyMap<string, ApplicableGrader>,
): readonly PlanGroup[] {
  const applying = [...graders.values()].filter(
    (one) => one.scope === "simulations" || one.scope === "both",
  );
  return [{
    tag: "suite" as const,
    items: applying.map((one) => ({
      kind: "authored" as const,
      graderId: one.id,
      graderVersionId: one.currentVersionId,
      graderName: one.name,
      libraryId: one.libraryId,
      required: one.required,
      scope: one.scope,
    })),
  }];
}

export async function writeGradingPlan(
  on: Queryable,
  input: {
    readonly runId: string;
    readonly organizationId: string;
    readonly projectId: string;
    readonly groups: readonly PlanGroup[];
    readonly capturedAt: Date;
  },
): Promise<void> {
  await on.insert(gradingPlan).values({
    id: newId("gpl"),
    runId: input.runId,
    organizationId: input.organizationId,
    projectId: input.projectId,
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

/** Resolve the exact grader versions frozen for one simulation. */
export async function pinnedSimulationGraders(
  auth: AuthContext,
  simulationId: string,
): Promise<readonly ExecutableGrader[] | undefined> {
  const [row] = await db()
    .select({ groups: gradingPlan.groups })
    .from(simulation)
    .innerJoin(gradingPlan, eq(gradingPlan.runId, simulation.runId))
    .where(within(auth, simulation, eq(simulation.id, simulationId)))
    .limit(1);
  if (row === undefined) return undefined;

  const groups = row.groups as readonly PlanGroup[];
  const group = groups.length === 1 && groups[0]?.tag === "suite" ? groups[0] : undefined;
  if (group === undefined) throw new Error(`simulation ${simulationId} has a malformed Suite grading plan`);
  return Promise.all(
    group.items.map(async (item) => {
      const version = await getGraderVersion(auth, item.graderVersionId);
      if (version === undefined || version.graderId !== item.graderId) {
        throw new Error(
          `grading plan for simulation ${simulationId} names unreadable grader version ${item.graderVersionId}`,
        );
      }
      return {
        id: version.graderId,
        versionId: version.id,
        config: version.config,
        judgeModel: version.judgeModel,
        definition: version.definition,
      };
    }),
  );
}
