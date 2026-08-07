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

// The platform's own identifier generator, reached the way the other checks
// that cross a package reach one: by path. `@egma/ids` is a name only the test
// runner knows how to resolve, and the smoke checks run this fixture under
// plain node, where a name nothing has installed is a name that does not exist.
import { isId, newId } from "../../../../../packages/ids/src/index.ts";
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

/** The wire's own refusals, word for word, from the route rather than the factory. */
const PERSONAS_NOT_A_LIST =
  "personas is the list of people who call about this test, by name. " +
  'Send it as a list of text, like ["impatient-caller"], or leave it ' +
  "out and egma takes the project's default persona.";

const A_PERSONA_IS_TEXT =
  "a test names each persona as text — their name, or their prs_ " +
  'identifier — and one entry in personas is neither. Send it as a ' +
  'list of text, like ["impatient-caller"].';

const NO_EXPECTED_VERSION =
  "an edit says which version it was written against, and this one " +
  "named no expected_version_id. Send the version_id you last read " +
  "for this test, or read the test again and send the version it " +
  "names now.";

/**
 * A project this credential may not act in.
 *
 * One sentence for reads and writes alike. A surface that refused a stranger's
 * project on a write and answered an empty list on a read would have two rules,
 * and the empty list is the worse half: it reads as "you have no tests there"
 * rather than as "that is not yours to ask about".
 */
function cannotActIn(projectId: string): string {
  return (
    `this credential may not act in project ${projectId}. A credential ` +
    `authorized for one project acts in that one, and a key for the whole ` +
    `organization acts in any project of that organization. Leave project out ` +
    `to use the project this credential already acts in.`
  );
}

function refuse(status: number, error: string, message: string): FixtureAnswer {
  return { status, body: { error, message } };
}

/** A string somebody sent, trimmed, or nothing at all for anything else. */
function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** What a caller actually said, as against a field that arrived empty. */
function given(value: string | undefined | null): string | undefined {
  return value === undefined || value === null || value === "" ? undefined : value;
}

function textList(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.map((item) => text(item)) : [];
}

/**
 * The personas a body names, in the order it named them.
 *
 * Text, and only text. An entry that is not text is refused rather than
 * dropped, because dropping it would quietly hand the test to the project's
 * default persona instead — a different test from the one that was asked for.
 */
type NamedPersonas =
  | { readonly entries: readonly string[] }
  | { readonly refusal: string };

function personaEntries(value: unknown): NamedPersonas {
  if (!Array.isArray(value)) return { refusal: PERSONAS_NOT_A_LIST };

  const entries: string[] = [];
  for (const entry of value) {
    const named = text(entry);
    if (typeof entry !== "string" || named === "") return { refusal: A_PERSONA_IS_TEXT };
    entries.push(named);
  }
  return { entries };
}

/**
 * One frozen version, as the run endpoints need it: what test it belongs to,
 * and who calls about it. A run pins one of these per test and produces one
 * simulation per persona named on it.
 */
/** How many rows one page holds, as the data-access layer's default does. */
const PAGE_SIZE = 50;

export type VersionLookup = (versionId: string) => {
  readonly versionId: string;
  readonly testId: string;
  readonly testName: string;
  readonly personas: readonly { readonly id: string; readonly name: string }[];
} | null;

export function testRoutes(options: {
  /** Whether the key a request carries is one this instance minted. */
  readonly holdsKey: (key: string) => boolean;
}): {
  readonly group: RouteGroup;
  readonly controls: TestControls;
  /** How a run resolves a pinned version. Never a route; the store itself. */
  readonly versionById: VersionLookup;
} {
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
      // The identifier first, so a project holding a persona whose name is
      // another persona's identifier still resolves the identifier.
      const found =
        personas.find((persona) => persona.id === wanted) ??
        personas.find((persona) => persona.name === wanted);
      if (found === undefined) {
        return {
          refusal: isId("prs", wanted)
            ? `there is no persona ${wanted} in this project`
            : `egma has no persona called "${wanted}" in this project. Name a persona this project already has, or name none and egma takes the project's default.`,
        };
      }
      if (ids.includes(found.id)) {
        return { refusal: `persona "${wanted}" is named twice on one test; name each persona once` };
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

  /**
   * A project a request named has to be the one this key acts in.
   *
   * This key is minted for one project, so naming a different one is refused
   * rather than quietly narrowed back to this one. The narrowing would be safe
   * and the silence would not: a caller whose filter was dropped reads the
   * answer as though the filter had applied.
   */
  const projectNamed = (value: unknown): FixtureAnswer | null => {
    const named = given(text(value));
    if (named === undefined || named === projectId) return null;
    return refuse(403, "not_permitted", cannotActIn(named));
  };

  /**
   * Who a write names, resolved — in exactly the order the route resolves
   * them.
   *
   * The order is contract as much as the sentences are: the shape of the
   * `personas` field is answered before the project, the project before the
   * names in it, and the names before anything the factory checks. A caller
   * fixing one refusal at a time meets them in that order, and a fixture that
   * met them in another would teach a client the wrong first move.
   */
  const personasFor = (
    said: Record<string, unknown>,
  ): { readonly ids: readonly string[] | undefined } | { readonly answer: FixtureAnswer } => {
    const named = "personas" in said ? personaEntries(said.personas) : undefined;
    if (named !== undefined && "refusal" in named) {
      return { answer: refuse(422, "unprocessable", named.refusal) };
    }

    const outsider = projectNamed(said.project);
    if (outsider !== null) return { answer: outsider };

    if (named === undefined) return { ids: undefined };

    const resolved = resolvePersonas(named.entries);
    if ("refusal" in resolved) {
      return { answer: refuse(422, "unprocessable", resolved.refusal) };
    }
    return { ids: resolved.ids };
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

    const who = personasFor(said);
    if ("answer" in who) return who;

    const name = text(said.name);
    const scenario = text(said.scenario);
    const expectedBehaviors = textList(said.expected_behaviors);

    const problem = validate({ name, scenario, expectedBehaviors });
    if (problem !== null) return { answer: refuse(422, "unprocessable", problem.refusal) };

    return {
      input: {
        name,
        scenario,
        expectedBehaviors: [...expectedBehaviors],
        // Absent means the project's default persona, exactly as an empty list
        // does: a first test costs nobody a persona to author.
        personaIds: who.ids ?? [defaultPersonaId],
      },
    };
  };

  const group: RouteGroup = {
    name: "tests",
    routes: [
      {
        /**
         * The project's tests, newest first, one page at a time.
         *
         * `{ items, next_cursor }` is the envelope every list in this API
         * answers with, and the cursor is the last id of the page rather than a
         * count of rows to skip: the ids sort by mint time, so a list changing
         * under a reader never shows them a row twice and never skips one.
         *
         * There is no page-size parameter, here or anywhere. A page is a page,
         * and the cursor carries a reader through the rest.
         */
        method: "GET",
        path: "/api/tests",
        handle: (request) =>
          behindAKey(request, () => {
            const outsider = projectNamed(request.url.searchParams.get("project"));
            if (outsider !== null) return outsider;

            const cursor = given(text(request.url.searchParams.get("cursor")));
            if (cursor !== undefined && !isId("tst", cursor)) {
              return refuse(
                400,
                "invalid_request",
                `"${cursor}" is not a cursor this list issued. Send the next_cursor ` +
                  `an earlier page answered with, or leave it out to start at the ` +
                  `newest test.`,
              );
            }

            const newestFirst = [...tests].reverse();
            const from =
              cursor === undefined
                ? 0
                : newestFirst.findIndex((held) => held.id === cursor) + 1;
            const page = newestFirst.slice(from, from + PAGE_SIZE);
            const more = newestFirst.length > from + page.length;

            return {
              status: 200,
              body: {
                items: page.map(described),
                // Null rather than absent, so a client can tell "there is no
                // next page" from "this answer is an older shape that never
                // had one".
                next_cursor: more ? (page.at(-1)?.id ?? null) : null,
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
                `there is no test version ${wanted} on this egma. List the tests ` +
                  `to see the version each of them stands on now.`,
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
        /**
         * An edit, carrying the version it was written against.
         *
         * `expected_version_id` is **required**, and it is required because it
         * is the whole of the refusal rule: an edit that named no version would
         * be accepted over a test somebody else moved in the meantime, and the
         * later write would quietly become what the test says. It costs the
         * writer nothing — a create and every read answer the version id.
         *
         * The comparison is the platform's and not the client's: a check the
         * client did could be walked past by a second writer between the check
         * and the write.
         *
         * The order below is the route's order and it is contract. Everything
         * answerable without reading anything is answered first, so a body that
         * could never be written is refused before it can learn whether the
         * test it names is even there.
         */
        method: "PATCH",
        path: "/api/tests/:testId",
        handle: (request) =>
          behindAKey(request, () => {
            const said = request.body ?? {};

            const expected = given(text(said.expected_version_id));
            if (expected === undefined) {
              return refuse(422, "unprocessable", NO_EXPECTED_VERSION);
            }

            const who = personasFor(said);
            if ("answer" in who) return who.answer;

            // A name is answerable without the database, so it is answered
            // before one, exactly as a create answers it.
            const name = given(text(said.name));
            if ("name" in said && name === undefined) {
              return refuse(422, "unprocessable", NEEDS_A_NAME);
            }

            // A test this key cannot see reads exactly as a test that is not
            // there, because to this caller those are the same thing.
            const test = tests.find((candidate) => candidate.id === request.params.testId);
            if (test === undefined) {
              return refuse(
                404,
                "not_found",
                `there is no test ${request.params.testId ?? ""} on this egma. List ` +
                  `the tests to see what this project holds, or create this one ` +
                  `instead of editing it.`,
              );
            }

            if (expected !== test.currentVersionId) {
              // The one refusal in this API carrying more than
              // `{ error, message }` — the caller's next move is to go and read
              // one named test — so it writes its own body.
              return {
                status: 409,
                body: {
                  error: "conflict",
                  message:
                    `this edit was written against version ${expected}, and the ` +
                    `test has moved on to ${test.currentVersionId}. Read the test ` +
                    `again and send the edit with expected_version_id set to the ` +
                    `version it names now.`,
                  test: { id: test.id, name: test.name },
                  expected_version_id: expected,
                  current_version_id: test.currentVersionId,
                },
              };
            }

            // What the body leaves out, the test keeps. An empty persona list
            // is not the same as leaving the field out: it means what it means
            // on a create, which is that the project's default persona calls.
            const current = currentOf(test);
            const content = {
              scenario: "scenario" in said ? text(said.scenario) : current.scenario,
              expectedBehaviors:
                "expected_behaviors" in said
                  ? textList(said.expected_behaviors)
                  : current.expectedBehaviors,
            };
            const problem = validate({ name: name ?? test.name, ...content });
            if (problem !== null) return refuse(422, "unprocessable", problem.refusal);

            write(test, {
              scenario: content.scenario,
              expectedBehaviors: [...content.expectedBehaviors],
              personaIds: who.ids ?? current.personaIds,
            });
            // A name is identity: it writes in place and versions nothing.
            if (name !== undefined) test.name = name;
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

  const versionById: VersionLookup = (versionId) => {
    for (const test of tests) {
      const version = test.versions.find((held) => held.id === versionId);
      if (version === undefined) continue;
      return {
        versionId: version.id,
        testId: test.id,
        testName: test.name,
        personas: namesOf(version.personaIds).map((persona) => ({
          id: persona.id,
          name: persona.name,
        })),
      };
    }
    return null;
  };

  return { group, controls, versionById };
}
