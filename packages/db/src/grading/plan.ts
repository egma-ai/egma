import { createHash } from "node:crypto";

import type { GraderDefinitionSnapshot } from "../grader-library/snapshot.ts";
import type {
  GraderModality,
  ProjectGraderScope,
} from "../schema/graders.ts";

export type ExecutableProjectGrader = {
  readonly projectGraderId: string;
  readonly passThreshold: number;
  readonly definition: GraderDefinitionSnapshot;
};

export type PlanItem = {
  readonly kind: "project_grader";
  readonly projectGraderId: string;
  readonly graderDefinitionId: string;
  readonly graderDefinitionVersion: number;
  readonly graderName: string;
  readonly graderType: string;
  readonly passThreshold: number;
};

export type PlanGroup = {
  readonly tag: "test";
  readonly testId: string;
  readonly testVersionId: string;
  readonly items: readonly PlanItem[];
};

export type ProjectGraderCandidate = ExecutableProjectGrader & {
  readonly graderName: string;
  readonly scope: ProjectGraderScope;
};

function compatible(
  candidate: ProjectGraderCandidate,
  modality: GraderModality,
): boolean {
  return candidate.definition.modalities.includes(modality);
}

function matchesSimulation(
  scope: ProjectGraderScope,
  input: { readonly suiteId: string; readonly testId: string },
): boolean {
  return scope.simulations.some((selector) => {
    if (selector.kind === "all") return true;
    if (selector.kind === "test_suite") return selector.id === input.suiteId;
    return selector.id === input.testId;
  });
}

/** Resolve one test. Overlapping selectors still create one item. */
export function resolveSimulationGraders(
  candidates: readonly ProjectGraderCandidate[],
  input: {
    readonly suiteId: string;
    readonly testId: string;
    readonly modality: GraderModality;
  },
): readonly ProjectGraderCandidate[] {
  return candidates.filter(
    (candidate) =>
      compatible(candidate, input.modality) &&
      matchesSimulation(candidate.scope, input),
  );
}

function itemFrom(candidate: ProjectGraderCandidate): PlanItem {
  return {
    kind: "project_grader",
    projectGraderId: candidate.projectGraderId,
    graderDefinitionId: candidate.definition.definitionId,
    graderDefinitionVersion: candidate.definition.definitionVersion,
    graderName: candidate.graderName,
    graderType: candidate.definition.type,
    passThreshold: candidate.passThreshold,
  };
}

/** Build one frozen plan group for each test in the run. */
export function planGroupsFor(
  candidates: readonly ProjectGraderCandidate[],
  tests: readonly {
    readonly suiteId: string;
    readonly testId: string;
    readonly testVersionId: string;
    readonly modality: GraderModality;
  }[],
): readonly PlanGroup[] {
  return tests.map((one) => ({
    tag: "test",
    testId: one.testId,
    testVersionId: one.testVersionId,
    items: resolveSimulationGraders(candidates, one).map(itemFrom),
  }));
}

/** A stable sample decision for one trace and one project grader. */
export function productionSampleSelected(
  traceId: string,
  projectGraderId: string,
  samplePercent: number,
): boolean {
  if (samplePercent <= 0) return false;
  if (samplePercent >= 100) return true;
  const digest = createHash("sha256")
    .update(traceId)
    .update("\0")
    .update(projectGraderId)
    .digest();
  const bucket = digest.readUIntBE(0, 6) / 2 ** 48;
  return bucket < samplePercent / 100;
}
