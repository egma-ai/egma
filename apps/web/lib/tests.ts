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
