import type {
  CreateTestResponse,
  ListTestsResponse,
  ListTestVersionsResponse,
} from "@egma/platform-api/client";

/** Test wire shapes after test suites become the permanent home. */
export type ExpectedBehavior = string;
export type ListedTest = CreateTestResponse;
export type TestPage = ListTestsResponse;
export type TestVersionPage = ListTestVersionsResponse;
export type TestVersionRow = TestVersionPage["versions"][number];
export type Named = ListedTest["personas"][number];
/** One override a test answers for itself, exactly as the platform returns it. */
export type TestMockTool = ListedTest["mockTools"][number];

export function testPagePath(projectId: string, testId: string): string {
  return `/projects/${encodeURIComponent(projectId)}/tests/${encodeURIComponent(testId)}`;
}

export function personaPagePath(projectId: string, personaId: string): string {
  return `/projects/${encodeURIComponent(projectId)}/personas/${encodeURIComponent(personaId)}`;
}

/**
 * How many personas a table cell names before it stops naming them.
 *
 * Three, because the cell is one line of a 52px row and a fourth name is what
 * makes it two. The rest are counted rather than dropped: the boards end such a
 * cell with a "+3" chip (`719-0`), which says there is more without pretending
 * the row is complete.
 */
const PERSONAS_IN_A_CELL = 3;

export function personaCell<Persona>(
  personas: readonly Persona[],
): { readonly shown: readonly Persona[]; readonly more: number } {
  return {
    shown: personas.slice(0, PERSONAS_IN_A_CELL),
    more: Math.max(0, personas.length - PERSONAS_IN_A_CELL),
  };
}

export const LIVE_FIELDS = ["name", "description"] as const;
export const VERSIONED_FIELDS = [
  "scenario",
  "personas",
  "expectedBehaviors",
  "mockTools",
] as const;

export type VersionedField = (typeof VERSIONED_FIELDS)[number];

export function isVersioned(field: string): field is VersionedField {
  return (VERSIONED_FIELDS as readonly string[]).includes(field);
}

export function behaviorsAreUsable(
  behaviors: readonly ExpectedBehavior[],
): boolean {
  return behaviors.some((one) => one.trim() !== "");
}

export function whyBehaviorsRefuse(
  behaviors: readonly ExpectedBehavior[],
): string | null {
  return behaviors.every((one) => one.trim() === "")
    ? "A test needs at least one expected behavior, because a test that cannot fail is not a test."
    : null;
}
