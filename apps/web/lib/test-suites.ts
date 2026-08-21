import type {
  CreateTestSuiteResponse,
  ListTestSuitesResponse,
} from "@egma/platform-api/client";

/** Test-suite wire shapes from the generated platform contract. */
export type TestSuite = CreateTestSuiteResponse;
export type TestSuitePage = ListTestSuitesResponse;

/** A compact stable identity for places where duplicate suite names meet. */
export function shortSuiteId(suiteId: string): string {
  return suiteId.length <= 12
    ? suiteId
    : `${suiteId.slice(0, 4)}…${suiteId.slice(-5)}`;
}

export function suitePagePath(projectId: string, suiteId: string): string {
  return `/projects/${encodeURIComponent(projectId)}/tests/suites/${encodeURIComponent(suiteId)}`;
}

export function newTestInSuitePath(projectId: string, suiteId: string): string {
  return `/projects/${encodeURIComponent(projectId)}/tests/new?suite=${encodeURIComponent(suiteId)}`;
}
