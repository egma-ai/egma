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

export function testsPagePath(projectId: string): string {
  return `/projects/${encodeURIComponent(projectId)}/tests`;
}

export function suitePagePath(projectId: string, suiteId: string): string {
  return `/projects/${encodeURIComponent(projectId)}/tests/suites/${encodeURIComponent(suiteId)}`;
}

export function newTestInSuitePath(projectId: string, suiteId: string): string {
  return `/projects/${encodeURIComponent(projectId)}/tests/new?suite=${encodeURIComponent(suiteId)}`;
}

/**
 * Where "Run suite" goes.
 *
 * The run builder is another ticket's screen, so this only carries the suite in
 * the address and never reaches into that form. A builder that reads the
 * parameter can preselect the suite; one that does not draws its ordinary empty
 * form, which is what this control reached before it carried anything at all.
 */
export function runSuitePath(projectId: string, suiteId: string): string {
  return `/projects/${encodeURIComponent(projectId)}/runs/new?suite=${encodeURIComponent(suiteId)}`;
}

/**
 * Whether a row survives what somebody typed in the search box.
 *
 * **The filter runs in the browser, and that is a gap rather than a design.**
 * Neither `listTestSuites` nor `listTests` takes a search, so this narrows the
 * page that is already on screen. It stays honest because the empty result says
 * which emptiness it is — "No test suites match …" is a different sentence from
 * "No test suites yet" — and it is why neither list pages through everything to
 * answer a search.
 */
export function matchesSearch(name: string, search: string): boolean {
  const wanted = search.trim().toLocaleLowerCase();
  return wanted === "" || name.toLocaleLowerCase().includes(wanted);
}
