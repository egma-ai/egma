import type {
  ListGraderLibraryResponse,
  ListGradersResponse,
} from "@egma/platform-api/client";

/** API response aliases. Their fields stay owned by the generated client. */
export type GraderLibraryPage = ListGraderLibraryResponse;
export type ProjectGradersPage = ListGradersResponse;

/** True UI aliases for the generated response's nested resources. */
export type GraderLibraryEntry =
  GraderLibraryPage["graderLibraryEntries"][number];
export type ProjectGrader = ProjectGradersPage["graders"][number];
export type GraderType = ProjectGrader["type"];
export type GraderOwner = ProjectGrader["owner"];
export type GraderModality = ProjectGrader["modalities"][number];
export type ProjectGraderScope = ProjectGrader["scope"];
export type SimulationScopeSelector =
  ProjectGraderScope["simulations"][number];
export type GraderSettingDefinition =
  GraderLibraryEntry["settingDefinitions"][number];

/**
 * The one predefined definition whose stored key needs product copy.
 *
 * The id, not the name, proves that this is Egma's Expected behaviors grader.
 * An organization is allowed to give a custom grader the same name, and that
 * custom name must stay exactly as the organization wrote it.
 */
export const EXPECTED_BEHAVIORS_GRADER_DEFINITION_ID =
  "grl_01M01MH8KAE8ZB19B0YJ7Z7EYW";

export function graderDefinitionDisplayName(
  definitionId: string,
  name: string,
): string {
  return definitionId === EXPECTED_BEHAVIORS_GRADER_DEFINITION_ID
    ? "Expected behaviors"
    : name;
}

export function graderOwnerLabel(owner: GraderOwner): string {
  return owner === "egma" ? "Egma" : "Organization";
}

export function graderTypeLabel(type: GraderType): string {
  return type === "llm_as_judge" ? "LLM judge" : "Code";
}

export function graderModalitiesLabel(
  modalities: readonly GraderModality[],
): string {
  if (modalities.length === 2) return "Chat and voice";
  if (modalities[0] === "chat") return "Chat";
  if (modalities[0] === "voice") return "Voice";
  return "None";
}

/** Compact table copy. The nested selector list belongs in the detail sheet. */
export function scopeSummary(scope: ProjectGraderScope): string {
  const all = scope.simulations.some((selector) => selector.kind === "all");
  const suites = scope.simulations.filter(
    (selector) => selector.kind === "test_suite",
  ).length;
  const tests = scope.simulations.filter(
    (selector) => selector.kind === "test",
  ).length;
  const simulations = all
    ? "All simulations"
    : suites + tests === 0
      ? "Simulations off"
      : [
          suites === 0
            ? null
            : `${String(suites)} test suite${suites === 1 ? "" : "s"}`,
          tests === 0
            ? null
            : `${String(tests)} test${tests === 1 ? "" : "s"}`,
        ]
          .filter((part): part is string => part !== null)
          .join(", ");
  const production =
    scope.production === null
      ? "Production off"
      : `${String(scope.production.samplePercent)}% of production`;
  return `${simulations} · ${production}`;
}

/** Product copy kept for callers that show the two evidence sources separately. */
export function simulationScopeLabel(grader: ProjectGrader): string {
  const all = grader.scope.simulations.some(
    (selector) => selector.kind === "all",
  );
  return all
    ? "Grades all simulations"
    : grader.scope.simulations.length === 0
      ? "Does not grade simulations"
      : "Grades selected simulations";
}

export function productionScopeLabel(grader: ProjectGrader): string {
  return grader.scope.production === null
    ? "Production off"
    : `Grades ${String(grader.scope.production.samplePercent)}% of production`;
}

export const EMPTY_GRADER_SCOPE: ProjectGraderScope = {
  simulations: [],
  production: null,
};

export const ALL_SIMULATIONS_SCOPE: ProjectGraderScope = {
  simulations: [{ kind: "all" }],
  production: null,
};
