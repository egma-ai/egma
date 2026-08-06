/**
 * The test endpoints of the fixture platform.
 *
 * This is the contract `pull` and `push` are built against, written down as
 * something that runs. It mirrors the real test factory
 * (`packages/db/src/access/tests.ts`) where the mirroring is what the CLI
 * depends on, and it is deliberately not kinder than the real thing anywhere:
 *
 * - **Authored things are never overwritten.** An edit whose content differs
 *   inserts the next version and moves the pointer; the version it left behind
 *   keeps its rows, because a run that pinned it has to stay readable. Content
 *   byte-identical to the current version is not an edit at all — nothing is
 *   written and the current version comes back.
 * - **A test is falsifiable from birth.** A write with no expected behaviors is
 *   refused at the door, in the factory's own words, rather than stored.
 * - **Identifiers are egma's.** `tst_` and `tstv_`, minted by the same
 *   generator every table uses, so a pinned version id in a committed file is
 *   the same string it would be against a real instance.
 *
 * One thing is the public API's rather than the factory's: **personas cross the
 * wire by name.** The folder is a folder a team reviews in pull requests, so a
 * file says `personas: [impatient-caller]` and never an identifier. Resolving
 * that name is the platform's job, and this is where that is written down.
 *
 * The shape of the addresses is a standing rule and not a preference. Nothing is
 * rooted at a project, and the organization is never in a path — both are
 * resolved from the key the request carries. A write may name a project in its
 * body and a read may filter by one; neither has to, and the CLI never does.
 */

import { newId } from "@egma/ids";

import type { FixtureAnswer, FixtureRequest, RouteGroup } from "./server.ts";

/** One version of a test, frozen the moment it was written. */
type Version = {
  readonly id: string;
  readonly version: number;
  readonly scenario: string;
  readonly expectedBehaviors: readonly string[];
  /** By identity, in the order they were authored. */
  readonly personaIds: readonly string[];
  readonly createdAt: Date;
};

type StoredTest = {
  readonly id: string;
  name: string;
  readonly versions: Version[];
  currentVersionId: string;
  readonly createdAt: Date;
  updatedAt: Date;
};

type Persona = { readonly id: string; readonly name: string };

/** What a test looks like when a test writes one, not when the CLI does. */
export type SeedTest = {
  readonly name: string;
  readonly scenario: string;
  readonly expectedBehaviors: readonly string[];
  readonly personas?: readonly string[];
};

export type SeededTest = {
  readonly id: string;
  readonly name: string;
  readonly versionId: string;
  readonly version: number;
};

export type TestControls = {
  /** Author a test, as somebody working in the dashboard would have. */
  add(seed: SeedTest): SeededTest;
  /**
   * Edit one, as the QA lead in the dashboard does while a developer is part
   * way through a push. This is what makes the refusal rule testable.
   */
  editInDashboard(name: string, changes: Partial<SeedTest>): SeededTest;
  /** A persona a test file may name. The first one added is the default. */
  addPersona(name: string): string;
  /** Every test, newest last, for a check that wants to look. */
  readonly tests: readonly SeededTest[];
  /** How many versions a test has — the proof that an edit minted one. */
  versionsOf(name: string): number;
};

/** The factory's own refusals, word for word. */
const NEEDS_A_NAME = "a test needs a name";
const NEEDS_A_SCENARIO = "a test needs a scenario: the situation the agent is put in";
const NEEDS_A_BEHAVIOR =
  "a test needs at least one expected behavior, because a test that cannot fail is not a test";
const EMPTY_BEHAVIOR = "an expected behavior needs to say something";

function refuse(status: number, error: string, message: string): FixtureAnswer {
  return { status, body: { error, message } };
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function textList(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.map((item) => text(item)) : [];
}

export function testRoutes(options: {
  /** Whether the key a request carries is one this instance minted. */
  readonly holdsKey: (key: string) => boolean;
}): { readonly group: RouteGroup; readonly controls: TestControls } {
  const tests: StoredTest[] = [];
  const personas: Persona[] = [];
  // The one project this key acts in. Never in a path and never asked for; it
  // exists so that a body or a filter that names one has something to agree
  // with, which is the shape the public API has to keep room for.
  const projectId = newId("prj");

  const addPersona = (name: string): string => {
    const already = personas.find((persona) => persona.name === name);
    if (already !== undefined) return already.id;
    const persona = { id: newId("prs"), name };
    personas.push(persona);
    return persona.id;
  };

  // A project has a default persona before it has a test, exactly as one
  // provisioned at signup does, so a test that names nobody can always be
  // written.
  const defaultPersonaId = addPersona("default-persona");

  const byName = (name: string): StoredTest | undefined =>
    tests.find((test) => test.name === name);

  const currentOf = (test: StoredTest): Version =>
    test.versions.find((version) => version.id === test.currentVersionId) as Version;

  const namesOf = (personaIds: readonly string[]): readonly Persona[] =>
    personaIds.flatMap((id) => personas.filter((persona) => persona.id === id));

  /**
   * The persona ids a write names, from the names it gave. An empty list takes
   * the project's default, which is what lets a first test be authored before
   * anybody has authored a persona.
   */
  const resolvePersonas = (
    named: readonly string[],
  ): { readonly ids: readonly string[] } | { readonly refusal: string } => {
    if (named.length === 0) return { ids: [defaultPersonaId] };

    const ids: string[] = [];
    for (const entry of named) {
      const wanted = entry.trim();
      const found =
        personas.find((persona) => persona.id === wanted) ??
        personas.find((persona) => persona.name === wanted);
      if (found === undefined) return { refusal: `egma has no persona called "${wanted}"` };
      if (ids.includes(found.id)) {
        return { refusal: `persona "${wanted}" is named twice on one test` };
      }
      ids.push(found.id);
    }
    return { ids };
  };

  /** Everything the factory checks before it writes anything. */
  const validate = (input: {
    readonly name: string;
    readonly scenario: string;
    readonly expectedBehaviors: readonly string[];
  }): { readonly refusal: string } | null => {
    if (input.name.trim() === "") return { refusal: NEEDS_A_NAME };
    if (input.scenario.trim() === "") return { refusal: NEEDS_A_SCENARIO };
    if (input.expectedBehaviors.length === 0) return { refusal: NEEDS_A_BEHAVIOR };
    if (input.expectedBehaviors.some((behavior) => behavior.trim() === "")) {
      return { refusal: EMPTY_BEHAVIOR };
    }
    return null;
  };

  const sameList = (a: readonly string[], b: readonly string[]): boolean =>
    a.length === b.length && a.every((entry, index) => entry === b[index]);

  const write = (
    test: StoredTest,
    content: {
      readonly scenario: string;
      readonly expectedBehaviors: readonly string[];
      readonly personaIds: readonly string[];
    },
  ): Version => {
    const current = currentOf(test);
    const same =
      current.scenario === content.scenario &&
      sameList(current.expectedBehaviors, content.expectedBehaviors) &&
      sameList(current.personaIds, content.personaIds);
    if (same) return current;

    const version: Version = {
      id: newId("tstv"),
      version: current.version + 1,
      scenario: content.scenario,
      expectedBehaviors: content.expectedBehaviors,
      personaIds: content.personaIds,
      createdAt: new Date(),
    };
    test.versions.push(version);
    test.currentVersionId = version.id;
    test.updatedAt = new Date();
    return version;
  };

  const create = (input: {
    readonly name: string;
    readonly scenario: string;
    readonly expectedBehaviors: readonly string[];
    readonly personaIds: readonly string[];
  }): StoredTest => {
    const version: Version = {
      id: newId("tstv"),
      version: 1,
      scenario: input.scenario.trim(),
      expectedBehaviors: input.expectedBehaviors.map((behavior) => behavior.trim()),
      personaIds: input.personaIds,
      createdAt: new Date(),
    };
    const test: StoredTest = {
      id: newId("tst"),
      name: input.name.trim(),
      versions: [version],
      currentVersionId: version.id,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    tests.push(test);
    return test;
  };

  const described = (test: StoredTest): Record<string, unknown> => {
    const current = currentOf(test);
    return {
      id: test.id,
      name: test.name,
      version: current.version,
      version_id: current.id,
      scenario: current.scenario,
      expected_behaviors: [...current.expectedBehaviors],
      personas: namesOf(current.personaIds).map((persona) => ({
        id: persona.id,
        name: persona.name,
      })),
      created_at: test.createdAt.toISOString(),
      updated_at: test.updatedAt.toISOString(),
    };
  };

  /** Every route below is behind a key, and the key resolves the tenancy. */
  const behindAKey = (
    request: FixtureRequest,
    answer: () => FixtureAnswer,
  ): FixtureAnswer => {
    const offered = (request.headers.authorization ?? "").replace(/^Bearer\s+/iu, "");
    if (offered === "" || !options.holdsKey(offered)) {
      return refuse(401, "not_authenticated", "no key, or not one of ours");
    }
    return answer();
  };

  /** A body that named a project has to have named this one. */
  const projectNamed = (value: unknown): FixtureAnswer | null => {
    const named = text(value).trim();
    if (named === "" || named === projectId) return null;
    return refuse(403, "not_permitted", "this key does not act there");
  };

  const writeFrom = (
    body: Record<string, unknown> | null,
  ):
    | {
        readonly input: {
          readonly name: string;
          readonly scenario: string;
          readonly expectedBehaviors: readonly string[];
          readonly personaIds: readonly string[];
        };
      }
    | { readonly answer: FixtureAnswer } => {
    const said = body ?? {};
    const outsider = projectNamed(said.project);
    if (outsider !== null) return { answer: outsider };

    const name = text(said.name);
    const scenario = text(said.scenario);
    const expectedBehaviors = textList(said.expected_behaviors);

    const problem = validate({ name, scenario, expectedBehaviors });
    if (problem !== null) return { answer: refuse(422, "unprocessable", problem.refusal) };

    const resolved = resolvePersonas(textList(said.personas));
    if ("refusal" in resolved) {
      return { answer: refuse(422, "unprocessable", resolved.refusal) };
    }

    return {
      input: {
        name: name.trim(),
        scenario: scenario.trim(),
        expectedBehaviors: expectedBehaviors.map((behavior) => behavior.trim()),
        personaIds: resolved.ids,
      },
    };
  };

  const group: RouteGroup = {
    name: "tests",
    routes: [
      {
        // Newest first, as the factory's own list answers. A project may be
        // named as a filter and never has to be.
        method: "GET",
        path: "/api/tests",
        handle: (request) =>
          behindAKey(request, () => {
            const filter = (request.url.searchParams.get("project") ?? "").trim();
            if (filter !== "" && filter !== projectId) {
              return { status: 200, body: { tests: [], next_cursor: null } };
            }
            return {
              status: 200,
              body: {
                tests: [...tests].reverse().map(described),
                next_cursor: null,
              },
            };
          }),
      },
      {
        // One frozen version by its own id. This is what a pinned file resolves
        // through, so it says which test the version belongs to and whether the
        // test has moved past it.
        method: "GET",
        path: "/api/test-versions/:versionId",
        handle: (request) =>
          behindAKey(request, () => {
            const wanted = request.params.versionId ?? "";
            const test = tests.find((candidate) =>
              candidate.versions.some((version) => version.id === wanted),
            );
            const version = test?.versions.find((candidate) => candidate.id === wanted);
            if (test === undefined || version === undefined) {
              return refuse(
                404,
                "not_found",
                `there is no test version ${wanted} on this egma`,
              );
            }
            return {
              status: 200,
              body: {
                id: version.id,
                test_id: test.id,
                test_name: test.name,
                version: version.version,
                current: test.currentVersionId === version.id,
                scenario: version.scenario,
                expected_behaviors: [...version.expectedBehaviors],
                personas: namesOf(version.personaIds).map((persona) => ({
                  id: persona.id,
                  name: persona.name,
                })),
                created_at: version.createdAt.toISOString(),
              },
            };
          }),
      },
      {
        method: "POST",
        path: "/api/tests",
        handle: (request) =>
          behindAKey(request, () => {
            const read = writeFrom(request.body);
            if ("answer" in read) return read.answer;
            return { status: 201, body: described(create(read.input)) };
          }),
      },
      {
        // An edit, carrying the version it was written against. The comparison
        // is the refusal rule, and it lives here rather than in the client:
        // a check the client did could be walked past by a second writer.
        method: "PATCH",
        path: "/api/tests/:testId",
        handle: (request) =>
          behindAKey(request, () => {
            const test = tests.find((candidate) => candidate.id === request.params.testId);
            if (test === undefined) {
              return refuse(
                404,
                "not_found",
                `there is no test ${request.params.testId ?? ""} on this egma`,
              );
            }

            const expected = text(request.body?.expected_version_id).trim();
            if (expected !== "" && expected !== test.currentVersionId) {
              return {
                status: 409,
                body: {
                  error: "conflict",
                  message: `this edit was written against version ${expected}, and the test has moved on to ${test.currentVersionId}`,
                  test: { id: test.id, name: test.name },
                  expected_version_id: expected,
                  current_version_id: test.currentVersionId,
                },
              };
            }

            const read = writeFrom(request.body);
            if ("answer" in read) return read.answer;

            write(test, {
              scenario: read.input.scenario,
              expectedBehaviors: read.input.expectedBehaviors,
              personaIds: read.input.personaIds,
            });
            // Name and description are identity: they write in place and
            // version nothing.
            test.name = read.input.name;
            test.updatedAt = new Date();
            return { status: 200, body: described(test) };
          }),
      },
    ],
  };

  const seededFrom = (test: StoredTest): SeededTest => ({
    id: test.id,
    name: test.name,
    versionId: test.currentVersionId,
    version: currentOf(test).version,
  });

  const controls: TestControls = {
    add(seed) {
      const ids = (seed.personas ?? []).map((name) => addPersona(name));
      return seededFrom(
        create({
          name: seed.name,
          scenario: seed.scenario,
          expectedBehaviors: seed.expectedBehaviors,
          personaIds: ids.length === 0 ? [defaultPersonaId] : ids,
        }),
      );
    },
    editInDashboard(name, changes) {
      const test = byName(name);
      if (test === undefined) throw new Error(`no test called ${name} was seeded`);
      const current = currentOf(test);
      const personaIds =
        changes.personas === undefined
          ? current.personaIds
          : changes.personas.map((personaName) => addPersona(personaName));
      write(test, {
        scenario: (changes.scenario ?? current.scenario).trim(),
        expectedBehaviors: (changes.expectedBehaviors ?? current.expectedBehaviors).map(
          (behavior) => behavior.trim(),
        ),
        personaIds,
      });
      if (changes.name !== undefined) test.name = changes.name;
      return seededFrom(test);
    },
    addPersona,
    get tests() {
      return tests.map(seededFrom);
    },
    versionsOf(name) {
      return byName(name)?.versions.length ?? 0;
    },
  };

  return { group, controls };
}
