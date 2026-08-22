import type { ListGradersResponse } from "@egma/platform-api/client";

/** One project's policy for one shared grader definition. */
export type ProjectGrader = ListGradersResponse["graders"][number];

export type ProjectGradersPage = ListGradersResponse;

/** Product copy for the closed Expected behaviors scope. */
export function simulationScopeLabel(grader: ProjectGrader): string {
  return grader.scope.simulations.some((selector) => selector.kind === "all")
    ? "Grades all simulations"
    : "Grades selected simulations";
}

export function productionScopeLabel(grader: ProjectGrader): string {
  return grader.scope.production === null
    ? "Production off"
    : `Grades ${String(grader.scope.production.samplePercent)}% of production`;
}
