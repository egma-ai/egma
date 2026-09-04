/**
 * Current suite-owned test and atomic repository fixture contract.
 *
 * **A test carries its own world.** Its mock tools and its env are versioned
 * content of the test, so this one group is where both are written, judged, and
 * answered — there is no project-wide mock tool and no route that holds one.
 *
 * The content gates are the platform's, and the two ceilings are read from the
 * platform's own constants rather than copied: a fixture holding its own number
 * would go on refusing at yesterday's budget for a year after the real one
 * moved, and the CLI would ship a check against a number nothing enforces.
 */

import {
  LARGEST_JOB_DISPATCH_METADATA_BYTES,
  LARGEST_MOCK_TOOL_ANSWER_BYTES,
  RESERVED_ENV_VARIABLE_PREFIX,
} from "@egma/db";

import { given, newId, NOT_AUTHENTICATED, refuse, text, textList } from "./reading.ts";
import type { FixtureAnswer, FixtureRequest, RouteGroup } from "./server.ts";
import type { SeededSuite } from "./suites.ts";

export type SeedBehavior = string;

/** One tool the test answers for, and the one thing it answers with. */
export type FixtureMockTool =
  | { readonly tool: string; readonly answer: unknown }
  | { readonly tool: string; readonly error: string };

/** The world one test is conducted in, in the two platforms' own words. */
export type FixtureEnv = {
  readonly retell_dynamic_variables?: Readonly<Record<string, string>>;
  readonly job_dispatch_metadata?: Readonly<Record<string, unknown>>;
};

export type SeedTest = {
  readonly suiteId?: string;
  readonly name: string;
  readonly description?: string | null;
  readonly scenario: string;
  readonly expectedBehaviors: readonly SeedBehavior[];
  readonly personas?: readonly string[];
  readonly mockTools?: readonly FixtureMockTool[];
  readonly env?: FixtureEnv | null;
};

export type SeededTest = {
  readonly id: string;
  readonly suiteId: string;
  readonly name: string;
  readonly versionId: string;
  readonly version: number;
  readonly revision: string;
};

/** What one stored version says, for a check that wants to look at it. */
export type SeededTestVersion = {
  readonly versionId: string;
  readonly mockTools: readonly FixtureMockTool[];
  readonly env: FixtureEnv | null;
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
  readonly mockTools: readonly FixtureMockTool[];
  readonly env: FixtureEnv | null;
};

type StoredTest = {
  readonly id: string;
  readonly suiteId: string;
  deleted: boolean;
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
  /** The world the current version of one test carries. */
  worldOf(name: string): SeededTestVersion;
  version(id: string): FixtureTestVersion | null;
  /** The server-side cascade when its owning Suite is deleted. */
  deleteInSuite(suiteId: string): void;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** What the shipped API turns a write away with, thrown where it is noticed. */
class Unprocessable extends Error {}

/** The tagged envelope, which is what the exchange carries and counts. */
function servedBytes(value: unknown, key: "answer" | "error"): number {
  return Buffer.byteLength(`{"${key}":${JSON.stringify(value) ?? ""}}`, "utf8");
}

function tooLarge(tool: string, key: "answer" | "error", bytes: number): string {
  return (
    `mock tool "${tool}": ${key} is ${bytes} bytes once serialized and tagged ` +
    `for the wire, and the exchange that carries it holds at most ` +
    `${LARGEST_MOCK_TOOL_ANSWER_BYTES}. An answer that needs more than that ` +
    `is a document rather than a tool answer.`
  );
}

/**
 * The mock tools as they will be stored: one branch each, named once.
 *
 * Deliberately not kinder than the shipped factory anywhere. A CLI that relayed
 * a body this refuses would pass against a fixture that took it.
 */
function mockToolsFrom(value: unknown): readonly FixtureMockTool[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new Unprocessable("mockTools is the list of tools this test answers for");
  }
  const mockTools: FixtureMockTool[] = [];
  const named = new Set<string>();
  for (const entry of value) {
    if (!isRecord(entry)) {
      throw new Unprocessable("each mock tool is an object naming one tool");
    }
    const tool = text(entry.tool);
    if (tool === "") {
      throw new Unprocessable(
        "tool is the name of the agent's tool this mock tool answers for, and " +
          "this one is blank.",
      );
    }
    if (named.has(tool)) {
      throw new Unprocessable(
        `this test answers for "${tool}" more than once. One answer per tool.`,
      );
    }
    named.add(tool);
    const unknown = Object.keys(entry).find(
      (key) => key !== "tool" && key !== "answer" && key !== "error",
    );
    if (unknown !== undefined) {
      throw new Unprocessable(
        `mock tool "${tool}" has no key "${unknown}"; it holds tool, and one ` +
          `of answer and error.`,
      );
    }
    const gives = "answer" in entry && entry.answer !== undefined;
    const fails = "error" in entry && entry.error !== undefined;
    if (gives && fails) {
      throw new Unprocessable(
        `mock tool "${tool}" answers with one thing: this one sent both ` +
          "answer and error. Send whichever branch the test needs.",
      );
    }
    if (!gives && !fails) {
      throw new Unprocessable(
        `mock tool "${tool}" answers with something: send answer with what ` +
          "the tool returns, or error with the failure it raises. This one " +
          "sent neither.",
      );
    }
    if (fails) {
      const message = entry.error;
      if (typeof message !== "string" || message.trim() === "") {
        throw new Unprocessable(
          `error is the failure mock tool "${tool}" raises, written as text.`,
        );
      }
      const bytes = servedBytes(message, "error");
      if (bytes > LARGEST_MOCK_TOOL_ANSWER_BYTES) {
        throw new Unprocessable(tooLarge(tool, "error", bytes));
      }
      mockTools.push({ tool, error: message });
      continue;
    }
    const bytes = servedBytes(entry.answer, "answer");
    if (bytes > LARGEST_MOCK_TOOL_ANSWER_BYTES) {
      throw new Unprocessable(tooLarge(tool, "answer", bytes));
    }
    mockTools.push({ tool, answer: entry.answer });
  }
  return mockTools;
}

/** The two keys an env may carry, and nothing else. */
const ENV_KEYS = ["retell_dynamic_variables", "job_dispatch_metadata"] as const;

/**
 * The env as it will be stored, or null where the test asks for nothing.
 *
 * `{}`, a half with nothing in it, and an absent field all say the same thing,
 * so all three are stored the same way — which is what lets a pull straight
 * after a push find nothing to write.
 */
function envFrom(value: unknown): FixtureEnv | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) {
    throw new Unprocessable(
      "env is an object with at most retell_dynamic_variables and " +
        "job_dispatch_metadata in it",
    );
  }
  for (const key of Object.keys(value)) {
    if ((ENV_KEYS as readonly string[]).includes(key)) continue;
    throw new Unprocessable(
      `env has no ${JSON.stringify(key)} in it. An env carries ` +
        `${ENV_KEYS.join(" and ")}, and nothing else.`,
    );
  }

  const env: {
    retell_dynamic_variables?: Record<string, string>;
    job_dispatch_metadata?: Record<string, unknown>;
  } = {};

  const written = value.retell_dynamic_variables;
  if (written !== undefined && written !== null) {
    if (!isRecord(written)) {
      throw new Unprocessable(
        "env.retell_dynamic_variables is an object of text values, which " +
          'looks like {"caller_name": "Margaret"}',
      );
    }
    const variables: Record<string, string> = {};
    for (const [name, said] of Object.entries(written)) {
      if (name.startsWith(RESERVED_ENV_VARIABLE_PREFIX)) {
        throw new Unprocessable(
          `env.retell_dynamic_variables names ${JSON.stringify(name)}, and ` +
            `Egma keeps every variable beginning ` +
            `"${RESERVED_ENV_VARIABLE_PREFIX}" for the facts it writes into ` +
            `the conversation itself. Name the variable something else.`,
        );
      }
      if (typeof said !== "string") {
        throw new Unprocessable(
          `env.retell_dynamic_variables.${name} is the text Retell ` +
            `substitutes into the prompt, and this request sent ${typeof said}.`,
        );
      }
      variables[name] = said;
    }
    if (Object.keys(variables).length > 0) env.retell_dynamic_variables = variables;
  }

  const dispatch = value.job_dispatch_metadata;
  if (dispatch !== undefined && dispatch !== null) {
    if (!isRecord(dispatch)) {
      throw new Unprocessable(
        "env.job_dispatch_metadata is a JSON object handed to your worker, " +
          'which looks like {"tenant": "acme"}',
      );
    }
    const bytes = Buffer.byteLength(JSON.stringify(dispatch), "utf8");
    if (bytes > LARGEST_JOB_DISPATCH_METADATA_BYTES) {
      throw new Unprocessable(
        `env.job_dispatch_metadata is ${bytes} bytes once serialized, and ` +
          `LiveKit carries at most ${LARGEST_JOB_DISPATCH_METADATA_BYTES} on ` +
          `the dispatch.`,
      );
    }
    if (Object.keys(dispatch).length > 0) env.job_dispatch_metadata = dispatch;
  }

  return Object.keys(env).length === 0 ? null : env;
}

export function testRoutes(options: {
  readonly holdsKey: (key: string) => boolean;
  readonly projectId: string;
  readonly suiteById: (id: string) => SeededSuite | null;
  readonly allSuites: () => readonly SeededSuite[];
  readonly createSuite: (name: string) => SeededSuite;
  /** A deterministic edit seam after a version answer is frozen. */
  readonly afterVersionRead?: (version: FixtureTestVersion) => void;
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
      "mockTools" in value ? mockToolsFrom(value.mockTools) : (fallback?.mockTools ?? []),
    env: "env" in value ? envFrom(value.env) : (fallback?.env ?? null),
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
      deleted: false,
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
      mockTools: version.mockTools.map((entry) => ({ ...entry })),
      env: version.env === null ? null : { ...version.env },
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
    mockTools: version.mockTools.map((entry) => ({ ...entry })),
    env: version.env === null ? null : { ...version.env },
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  const validateWrite = (value: Record<string, unknown>): FixtureAnswer | null => {
    if (text(value.name) === "") return refuse(422, "unprocessable", "a test name is required");
    if (text(value.scenario) === "") return refuse(422, "unprocessable", "a test scenario is required");
    if (textList(value.expectedBehaviors).filter(Boolean).length === 0) {
      return refuse(422, "unprocessable", "a test needs at least one expected behavior");
    }
    // The world the test carries is judged here, with the shipped factory's own
    // sentences: everything the CLI does with a bad one is relay what it heard.
    try {
      if ("mockTools" in value) mockToolsFrom(value.mockTools);
      if ("env" in value) envFrom(value.env);
    } catch (problem) {
      if (problem instanceof Unprocessable) {
        return refuse(422, "unprocessable", problem.message);
      }
      throw problem;
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
          env: seed.env ?? null,
        }),
      );
    },
    editInDashboard(name, changes) {
      const test = tests.find((one) => !one.deleted && one.name === name);
      if (test === undefined) throw new Error(`no test ${name}`);
      return seedOf(
        apply(test, {
          name: changes.name ?? test.name,
          description: changes.description ?? test.description,
          scenario: changes.scenario ?? current(test).scenario,
          expectedBehaviors: changes.expectedBehaviors ?? current(test).expectedBehaviors,
          personas: changes.personas ?? current(test).personas.map((one) => one.id),
          mockTools: changes.mockTools ?? current(test).mockTools,
          env: changes.env === undefined ? current(test).env : changes.env,
        }),
      );
    },
    renameInDashboard(name, changes) {
      const test = tests.find((one) => !one.deleted && one.name === name);
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
      return tests.filter((test) => !test.deleted).map(seedOf);
    },
    versionsOf(name) {
      return tests.find((one) => !one.deleted && one.name === name)?.versions.length ?? 0;
    },
    seeded(name) {
      const test = tests.find((one) => !one.deleted && one.name === name);
      if (test === undefined) throw new Error(`no test ${name}`);
      return seedOf(test);
    },
    worldOf(name) {
      const test = tests.find((one) => one.name === name);
      if (test === undefined) throw new Error(`no test ${name}`);
      const version = current(test);
      return {
        versionId: version.id,
        mockTools: version.mockTools.map((entry) => ({ ...entry })),
        env: version.env === null ? null : { ...version.env },
      };
    },
    version(id) {
      return tests.flatMap((test) => test.versions).find((entry) => entry.id === id) ?? null;
    },
    deleteInSuite(suiteId) {
      for (const test of tests) {
        if (test.suiteId === suiteId) test.deleted = true;
      }
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
                tests: tests
                  .filter((test) => !test.deleted && test.suiteId === suite)
                  .map(described),
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
            const test = tests.find(
              (one) => !one.deleted && one.id === request.params.testId,
            );
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
            const projectId = given(request.url.searchParams.get("projectId"));
            if (projectId !== undefined && projectId !== options.projectId) {
              return refuse(403, "not_authorized", "this credential may not act in that project");
            }
            const version = tests.flatMap((test) => test.versions).find((one) => one.id === request.params.versionId);
            if (version === undefined) {
              return refuse(404, "not_found", "there is no test version with that id");
            }
            const body = versionBody(version);
            options.afterVersionRead?.(version);
            return { status: 200, body };
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
            const test = tests.find(
              (one) => !one.deleted && one.id === request.params.testId,
            );
            if (test === undefined) return refuse(404, "not_found", "there is no active test with that id");
            return { status: 200, body: described(apply(test, said)) };
          }),
      },
      {
        method: "DELETE",
        path: "/v1/tests/:testId",
        handle: (request) =>
          behind(request, () => {
            const projectId = given(request.url.searchParams.get("projectId"));
            if (projectId !== undefined && projectId !== options.projectId) {
              return refuse(403, "not_authorized", "this credential may not act in that project");
            }
            const expectedVersionId = given(
              request.url.searchParams.get("expectedVersionId"),
            );
            if (expectedVersionId === undefined) {
              return refuse(
                422,
                "unprocessable",
                "expectedVersionId must name the Test version being deleted",
              );
            }
            const expectedRevision = given(
              request.url.searchParams.get("expectedRevision"),
            );
            if (expectedRevision === undefined) {
              return refuse(
                422,
                "unprocessable",
                "expectedRevision must name the Test identity revision being deleted",
              );
            }
            const test = tests.find(
              (one) => !one.deleted && one.id === request.params.testId,
            );
            if (test === undefined) return refuse(404, "not_found", "there is no active test with that id");
            if (test.revision !== expectedRevision) {
              return refuse(
                409,
                "identity_conflict",
                `Test ${test.id} changed after you opened it. Read it again ` +
                  "before deciding whether to delete it.",
              );
            }
            if (test.currentVersionId !== expectedVersionId) {
              return {
                status: 409,
                body: {
                  error: "version_conflict",
                  message:
                    `this write was based on version ${expectedVersionId}, and ` +
                    `test ${test.id} has moved on to ${test.currentVersionId}`,
                  test: { id: test.id, name: test.name },
                  expectedVersionId,
                  currentVersionId: test.currentVersionId,
                },
              };
            }
            test.deleted = true;
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
                : tests.find(
                    (test) =>
                      !test.deleted &&
                      test.versions.some((version) => version.id === expected),
                  );
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
              (test) =>
                !test.deleted &&
                !planned.some((entry) => entry.held?.id === test.id),
            );
            if (testNotInRepository !== undefined) {
              return refuse(
                422,
                "unprocessable",
                `the repository does not include active test ${testNotInRepository.id}; pull before pushing so no server test is deleted by inference`,
              );
            }
            // Nothing above this line changes fixture state. The complete
            // change set is valid before any suite or test moves.
            for (const entry of suiteNames) entry.suite.name = entry.name;
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
    versionById: controls.version,
    testsInSuite: (suiteId) =>
      tests
        .filter((test) => !test.deleted && test.suiteId === suiteId)
        .map(current),
  };
}
