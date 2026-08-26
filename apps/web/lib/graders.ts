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
export type GraderRequiredEvidence =
  GraderLibraryEntry["requiredEvidence"][number];

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

/**
 * There is no `graderTypeLabel`, and that is a decision rather than an
 * omission.
 *
 * "LLM judge" and "Code" were product words for `llm_as_judge` and `code`, and
 * the two never agreed: the API's word is what a person reads in a request, in
 * a webhook and in the library's own contract. **The type now reads as the
 * identifier it is** — the raw value, in the monospace stack, in a chip
 * (developer decision, 2026-08-25). A screen that wants it only has to draw
 * `grader.type`, so a helper that renamed it would be a second name to keep in
 * step with nothing.
 */

/** One modality, as the word a person reads on a chip. */
export function graderModalityLabel(modality: GraderModality): string {
  return modality === "chat" ? "Chat" : "Voice";
}

/**
 * What a grader grading nothing says, in either scope column.
 *
 * It is named because the columns draw it in the faint colour: "Off" is the
 * absence of a scope rather than a scope, and a page deciding that by comparing
 * against a literal it wrote itself would drift the first time this word does.
 */
export const SCOPE_OFF = "Off";

/**
 * What the Simulations column says: `All`, the suites and tests counted, or
 * `Off`.
 *
 * The two evidence sources are two columns rather than one dot-joined
 * sentence, so each is scannable down its own lane (approved boards,
 * 2026-08-25). The pluralisation is the one the single summary used.
 */
export function simulationScopeSummary(scope: ProjectGraderScope): string {
  const all = scope.simulations.some((selector) => selector.kind === "all");
  if (all) return "All";
  const suites = scope.simulations.filter(
    (selector) => selector.kind === "test_suite",
  ).length;
  const tests = scope.simulations.filter(
    (selector) => selector.kind === "test",
  ).length;
  if (suites + tests === 0) return SCOPE_OFF;
  return [
    suites === 0 ? null : `${String(suites)} test suite${suites === 1 ? "" : "s"}`,
    tests === 0 ? null : `${String(tests)} test${tests === 1 ? "" : "s"}`,
  ]
    .filter((part): part is string => part !== null)
    .join(", ");
}

/** What the Production column says: the sampled share, or `Off`. */
export function productionScopeSummary(scope: ProjectGraderScope): string {
  return scope.production === null
    ? SCOPE_OFF
    : `${String(scope.production.samplePercent)}%`;
}

/**
 * One piece of evidence a grader reads, in words rather than in its stored key.
 *
 * The keys are the contract's — `test_expected_behaviors`, `tool_calls` — and
 * every one of them is an ordinary sentence with underscores in it, so the
 * words are the key with its separators and its capital restored.
 */
export function graderEvidenceLabel(evidence: GraderRequiredEvidence): string {
  const words = evidence.replaceAll("_", " ");
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

export const EMPTY_GRADER_SCOPE: ProjectGraderScope = {
  simulations: [],
  production: null,
};

export const ALL_SIMULATIONS_SCOPE: ProjectGraderScope = {
  simulations: [{ kind: "all" }],
  production: null,
};
