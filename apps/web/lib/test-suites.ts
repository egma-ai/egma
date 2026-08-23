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

/**
 * The trail into a record, for a page whose `<h1>` is that record's own name.
 *
 * `PageHeader` draws the trail and the page title side by side in one 56px bar,
 * so a trail that ended with the record would say its name twice — "Tests /
 * Default   Default" — which is not what `9VT-0` and `B9M-0` draw. They draw
 * one line, and its last step is the heading. So the trail carries the
 * ancestors and stops, and the `<h1>` beside it is the current page: one name,
 * in the element that means "this page", with the separator still between it
 * and its parent.
 *
 * **This belongs in the shell rather than here**, and it is written here only
 * because `apps/web/ui/` is another ticket's during this effort. The one-line
 * fix is for `PageHeader` to stop drawing the trail's last step; when that
 * lands, every caller of this can pass its own trail again and this goes.
 */
export function trailInto(
  ...ancestors: readonly { readonly label: string; readonly href: string }[]
): readonly [
  { readonly label: string; readonly href: string },
  ...{ readonly label: string; readonly href: string }[],
  { readonly label: string; readonly href?: never },
] {
  const [first, ...rest] = ancestors;
  if (first === undefined) throw new Error("a trail needs at least one parent");
  return [first, ...rest, { label: "" }];
}
