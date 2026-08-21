/** Current suite-owned test and atomic repository fixture contract. */

import { given, newId, NOT_AUTHENTICATED, refuse, text, textList } from "./reading.ts";
import type { FixtureAnswer, FixtureRequest, RouteGroup } from "./server.ts";
import type { SeededSuite } from "./suites.ts";

export type SeedBehavior = string;

export type SeedTest = {
  readonly suiteId?: string;
  readonly name: string;
  readonly description?: string | null;
  readonly scenario: string;
  readonly expectedBehaviors: readonly SeedBehavior[];
  readonly personas?: readonly string[];
  readonly mockTools?: readonly Record<string, unknown>[];
};

export type SeededTest = {
  readonly id: string;
  readonly suiteId: string;
  readonly name: string;
  readonly versionId: string;
  readonly version: number;
  readonly revision: string;
};

export type FixtureTestVersion = {
  readonly id: string;
  readonly testId: string;
  readonly suiteId: string;
  readonly testName: string;
  readonly version: number;
  readonly scenario: string;
  readonly expectedBehaviors: readonly string[];
  readonly personas: readonly { readonly id: string; readonly name: string }[];
  readonly mockTools: readonly Record<string, unknown>[];
};

type StoredTest = {
  readonly id: string;
  readonly suiteId: string;
  name: string;
  description: string;
  revision: string;
  readonly versions: FixtureTestVersion[];
  currentVersionId: string;
};

export type TestControls = {
  add(seed: SeedTest): SeededTest;
  editInDashboard(name: string, changes: Partial<SeedTest>): SeededTest;
  renameInDashboard(
    name: string,
    changes: { readonly name?: string; readonly description?: string | null },
  ): SeededTest;
  addPersona(name: string): string;
  addSecondPersonaCalled(name: string): string;
  readonly tests: readonly SeededTest[];
  versionsOf(name: string): number;
  seeded(name: string): SeededTest;
};

export type TestRouteGroup = {
  readonly group: RouteGroup;
  readonly controls: TestControls;
  readonly versionById: (id: string) => FixtureTestVersion | null;
  readonly testsInSuite: (suiteId: string) => readonly FixtureTestVersion[];
};

function bearer(request: FixtureRequest): string {
  const value = request.headers.authorization ?? "";
  return value.startsWith("Bearer ") ? value.slice(7) : "";
}

function records(value: unknown): readonly Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter(
        (entry): entry is Record<string, unknown> =>
          typeof entry === "object" && entry !== null && !Array.isArray(entry),
      )
    : [];
}

export function testRoutes(options: {
  readonly holdsKey: (key: string) => boolean;
  readonly projectId: string;
  readonly suiteById: (id: string) => SeededSuite | null;
  readonly allSuites: () => readonly SeededSuite[];
  readonly createSuite: (name: string) => SeededSuite;
  readonly prepareMockTools: (
    entries: readonly Record<string, unknown>[],
  ) => { readonly apply: () => void } | { readonly refusal: FixtureAnswer };
}): TestRouteGroup {
  const tests: StoredTest[] = [];
  const personas: { readonly id: string; readonly name: string }[] = [];
  const behind = (request: FixtureRequest, action: () => FixtureAnswer): FixtureAnswer =>
    options.holdsKey(bearer(request)) ? action() : { status: 401, body: NOT_AUTHENTICATED };
  const current = (test: StoredTest): FixtureTestVersion =>
    test.versions.find((version) => version.id === test.currentVersionId)!;
  const persona = (value: string): { readonly id: string; readonly name: string } => {
    const held = personas.find((entry) => entry.id === value || entry.name === value);
    if (held !== undefined) return held;
    const created = { id: newId("prs"), name: value };
    personas.push(created);
    return created;
  };
  let controlSuiteId: string | null = null;
  const suiteForControl = (suiteId?: string): string => {
    if (suiteId !== undefined) return suiteId;
    controlSuiteId ??= options.createSuite("Fixture suite").id;
    return controlSuiteId;
  };
  const seedOf = (test: StoredTest): SeededTest => ({
    id: test.id,
    suiteId: test.suiteId,
    name: test.name,
    versionId: test.currentVersionId,
    version: current(test).version,
    revision: test.revision,
  });
  const contentFrom = (
    value: Record<string, unknown>,
    fallback?: FixtureTestVersion,
  ): Omit<FixtureTestVersion, "id" | "testId" | "suiteId" | "testName" | "version"> => ({
    scenario: "scenario" in value ? text(value.scenario) : (fallback?.scenario ?? ""),
    expectedBehaviors:
      "expectedBehaviors" in value
        ? textList(value.expectedBehaviors).filter(Boolean)
        : (fallback?.expectedBehaviors ?? []),
    personas:
      "personas" in value
        ? textList(value.personas).filter(Boolean).map(persona)
        : (fallback?.personas ?? []),
    mockTools:
      "mockTools" in value ? records(value.mockTools) : (fallback?.mockTools ?? []),
  });
  const writeVersion = (
    test: StoredTest,
    value: Record<string, unknown>,
  ): FixtureTestVersion => {
    const prior = current(test);
    const content = contentFrom(value, prior);
    const version: FixtureTestVersion = {
      id: newId("tstv"),
      testId: test.id,
      suiteId: test.suiteId,
      testName: test.name,
      version: prior.version + 1,
      ...content,
    };
    test.versions.push(version);
    test.currentVersionId = version.id;
    return version;
  };
  const create = (suiteId: string, value: Record<string, unknown>): StoredTest => {
    const suite = options.suiteById(suiteId);
    if (suite === null) throw new Error(`no suite ${suiteId}`);
    const id = newId("tst");
    const name = text(value.name);
    const version: FixtureTestVersion = {
      id: newId("tstv"),
      testId: id,
      suiteId,
      testName: name,
      version: 1,
      ...contentFrom(value),
    };
    const test: StoredTest = {
      id,
      suiteId,
      name,
      description: text(value.description),
      revision: newId("rev"),
      versions: [version],
      currentVersionId: version.id,
    };
    tests.push(test);
    return test;
  };
  const described = (test: StoredTest): Record<string, unknown> => {
    const version = current(test);
    return {
      id: test.id,
      projectId: options.projectId,
      suiteId: test.suiteId,
      name: test.name,
      description: test.description,
      versionId: version.id,
      version: version.version,
      revision: test.revision,
      scenario: version.scenario,
      expectedBehaviors: [...version.expectedBehaviors],
      personas: version.personas.map((one) => ({ ...one, archivedAt: null })),
      mockTools: [...version.mockTools],
      overrideCount: version.mockTools.length,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
  };
  const versionBody = (version: FixtureTestVersion): Record<string, unknown> => ({
    id: version.id,
    testId: version.testId,
    suiteId: version.suiteId,
    testName: version.testName,
    version: version.version,
    current: tests.find((test) => test.id === version.testId)?.currentVersionId === version.id,
    scenario: version.scenario,
    expectedBehaviors: [...version.expectedBehaviors],
    personas: version.personas.map((one) => ({ ...one, archivedAt: null })),
    mockTools: [...version.mockTools],
    overrideCount: version.mockTools.length,
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  const validateWrite = (value: Record<string, unknown>): FixtureAnswer | null => {
    if (text(value.name) === "") return refuse(422, "unprocessable", "a test name is required");
    if (text(value.scenario) === "") return refuse(422, "unprocessable", "a test scenario is required");
    if (textList(value.expectedBehaviors).filter(Boolean).length === 0) {
      return refuse(422, "unprocessable", "a test needs at least one expected behavior");
    }
    return null;
  };
  const sameContent = (
    first: ReturnType<typeof contentFrom>,
    second: ReturnType<typeof contentFrom>,
  ): boolean => JSON.stringify(first) === JSON.stringify(second);
  const apply = (test: StoredTest, value: Record<string, unknown>): StoredTest => {
    const prior = current(test);
    const nextContent = contentFrom(value, prior);
    const nextName = "name" in value ? text(value.name) : test.name;
    const nextDescription = "description" in value ? text(value.description) : test.description;
    if (nextName !== test.name || nextDescription !== test.description) {
      test.name = nextName;
      test.description = nextDescription;
      test.revision = newId("rev");
    }
    if (!sameContent(nextContent, contentFrom({}, prior))) writeVersion(test, value);
    return test;
  };

  const controls: TestControls = {
    add(seed) {
      const suiteId = suiteForControl(seed.suiteId);
      return seedOf(
        create(suiteId, {
          name: seed.name,
          description: seed.description ?? "",
          scenario: seed.scenario,
          expectedBehaviors: [...seed.expectedBehaviors],
          personas: [...(seed.personas ?? [])],
          mockTools: [...(seed.mockTools ?? [])],
        }),
      );
    },
    editInDashboard(name, changes) {
      const test = tests.find((one) => one.name === name);
      if (test === undefined) throw new Error(`no test ${name}`);
      return seedOf(
        apply(test, {
          name: changes.name ?? test.name,
          description: changes.description ?? test.description,
          scenario: changes.scenario ?? current(test).scenario,
          expectedBehaviors: changes.expectedBehaviors ?? current(test).expectedBehaviors,
          personas: changes.personas ?? current(test).personas.map((one) => one.id),
          mockTools: changes.mockTools ?? current(test).mockTools,
        }),
      );
    },
    renameInDashboard(name, changes) {
      const test = tests.find((one) => one.name === name);
      if (test === undefined) throw new Error(`no test ${name}`);
      test.name = changes.name ?? test.name;
      test.description = changes.description ?? test.description;
      test.revision = newId("rev");
      return seedOf(test);
    },
    addPersona(name) {
      return persona(name).id;
    },
    addSecondPersonaCalled(name) {
      const created = { id: newId("prs"), name };
      personas.push(created);
      return created.id;
    },
    get tests() {
      return tests.map(seedOf);
    },
    versionsOf(name) {
      return tests.find((one) => one.name === name)?.versions.length ?? 0;
    },
    seeded(name) {
      const test = tests.find((one) => one.name === name);
      if (test === undefined) throw new Error(`no test ${name}`);
      return seedOf(test);
    },
  };

  const group: RouteGroup = {
    name: "tests",
    routes: [
      {
        method: "GET",
        path: "/v1/tests",
        handle: (request) =>
          behind(request, () => {
            const projectId = given(request.url.searchParams.get("projectId"));
            if (projectId !== undefined && projectId !== options.projectId) {
              return refuse(403, "not_authorized", "this credential may not act in that project");
            }
            const suite = given(request.url.searchParams.get("suiteId"));
            if (suite === undefined) {
              return refuse(422, "unprocessable", "suite must be one ste_ test suite identifier");
            }
            if (options.suiteById(suite) === null) {
              return refuse(404, "not_found", `there is no active test suite with id ${suite}`);
            }
            return {
              status: 200,
              body: {
                tests: tests.filter((test) => test.suiteId === suite).map(described),
                nextPageToken: null,
              },
            };
          }),
      },
      {
        method: "GET",
        path: "/v1/tests/:testId",
        handle: (request) =>
          behind(request, () => {
            const test = tests.find((one) => one.id === request.params.testId);
            return test === undefined
              ? refuse(404, "not_found", "there is no active test with that id")
              : { status: 200, body: described(test) };
          }),
      },
      {
        method: "GET",
        path: "/v1/test-versions/:versionId",
        handle: (request) =>
          behind(request, () => {
            const version = tests.flatMap((test) => test.versions).find((one) => one.id === request.params.versionId);
            return version === undefined
              ? refuse(404, "not_found", "there is no test version with that id")
              : { status: 200, body: versionBody(version) };
          }),
      },
      {
        method: "POST",
        path: "/v1/tests",
        handle: (request) =>
          behind(request, () => {
            const said = request.body ?? {};
            const suiteId = text(said.suiteId);
            if (options.suiteById(suiteId) === null) return refuse(404, "not_found", "create the suite first");
            const problem = validateWrite(said);
            return problem ?? { status: 201, body: described(create(suiteId, said)) };
          }),
      },
      {
        method: "PATCH",
        path: "/v1/tests/:testId",
        handle: (request) =>
          behind(request, () => {
            const said = request.body ?? {};
            if ("suiteId" in said) {
              return refuse(422, "unprocessable", "a test cannot move between suites");
            }
            const test = tests.find((one) => one.id === request.params.testId);
            if (test === undefined) return refuse(404, "not_found", "there is no active test with that id");
            return { status: 200, body: described(apply(test, said)) };
          }),
      },
      {
        method: "DELETE",
        path: "/v1/tests/:testId",
        handle: (request) =>
          behind(request, () => {
            const at = tests.findIndex((one) => one.id === request.params.testId);
            if (at < 0) return refuse(404, "not_found", "there is no active test with that id");
            tests.splice(at, 1);
            return { status: 204 };
          }),
      },
      {
        method: "POST",
        path: "/v1/repository/change-set",
        handle: (request) =>
          behind(request, () => {
            const said = request.body ?? {};
            const projectId = given(request.url.searchParams.get("projectId"));
            if (projectId !== undefined && projectId !== options.projectId) {
              return refuse(403, "not_authorized", "this credential may not act in that project");
            }
            const suiteNames: { readonly suite: SeededSuite; readonly name: string }[] = [];
            const declaredSuiteIds = new Set<string>();
            for (const value of records(said.suites)) {
              const suite = options.suiteById(text(value.id));
              if (suite === null) return refuse(409, "repository_conflict", "a suite no longer exists");
              if (declaredSuiteIds.has(suite.id)) {
                return refuse(422, "unprocessable", `the repository names test suite ${suite.id} more than once`);
              }
              declaredSuiteIds.add(suite.id);
              const name = text(value.name);
              if (name === "") return refuse(422, "unprocessable", "a suite name is required");
              suiteNames.push({ suite, name });
            }
            const suiteNotInRepository = options.allSuites()
              .find((suite) => !declaredSuiteIds.has(suite.id));
            if (suiteNotInRepository !== undefined) {
              return refuse(
                422,
                "unprocessable",
                `the repository does not include active test suite ${suiteNotInRepository.id}; pull before pushing so no server suite is deleted by inference`,
              );
            }
            const planned: {
              readonly clientRef: string;
              readonly held: StoredTest | undefined;
              readonly suiteId: string;
              readonly value: Record<string, unknown>;
            }[] = [];
            const identities = new Set<string>();
            const clientRefs = new Set<string>();
            for (const value of records(said.tests)) {
              const suiteId = text(value.suiteId);
              if (options.suiteById(suiteId) === null) return refuse(409, "repository_conflict", "a suite no longer exists");
              const expected = text(value.expectedVersionId);
              const held = expected === ""
                ? undefined
                : tests.find((test) => test.versions.some((version) => version.id === expected));
              if (expected !== "" && held === undefined) {
                return refuse(409, "repository_conflict", "a test version no longer exists");
              }
              if (held !== undefined && held.suiteId !== suiteId) {
                return refuse(409, "repository_conflict", "a test cannot move between suites");
              }
              if (held !== undefined && held.currentVersionId !== expected) {
                return refuse(409, "repository_conflict", "a test has a newer version");
              }
              const revision = text(value.expectedRevision);
              if (held !== undefined && revision !== "" && held.revision !== revision) {
                return refuse(409, "repository_conflict", "a test identity has changed");
              }
              if (held !== undefined && identities.has(held.id)) {
                return refuse(409, "repository_conflict", "a test is present more than once");
              }
              if (held !== undefined) identities.add(held.id);
              const clientRef = text(value.clientRef);
              if (clientRef === "" || clientRefs.has(clientRef)) {
                return refuse(422, "unprocessable", "each repository test needs one unique client_ref");
              }
              clientRefs.add(clientRef);
              const problem = validateWrite(value);
              if (problem !== null) return problem;
              planned.push({
                clientRef,
                held,
                suiteId,
                value,
              });
            }
            const testNotInRepository = tests.find(
              (test) => !planned.some((entry) => entry.held?.id === test.id),
            );
            if (testNotInRepository !== undefined) {
              return refuse(
                422,
                "unprocessable",
                `the repository does not include active test ${testNotInRepository.id}; pull before pushing so no server test is deleted by inference`,
              );
            }
            const mockTools = options.prepareMockTools(records(said.mockTools));
            if ("refusal" in mockTools) return mockTools.refusal;

            // Nothing above this line changes fixture state. The complete
            // change set is valid before any suite, test, or mock tool moves.
            for (const entry of suiteNames) entry.suite.name = entry.name;
            mockTools.apply();
            const applied = planned.map((entry) => ({
              clientRef: entry.clientRef,
              test: described(
                entry.held === undefined
                  ? create(entry.suiteId, entry.value)
                  : apply(entry.held, entry.value),
              ),
            }));
            return { status: 200, body: { tests: applied } };
          }),
      },
    ],
  };

  return {
    group,
    controls,
    versionById: (id) =>
      tests.flatMap((test) => test.versions).find((version) => version.id === id) ?? null,
    testsInSuite: (suiteId) =>
      tests.filter((test) => test.suiteId === suiteId).map(current),
  };
}
