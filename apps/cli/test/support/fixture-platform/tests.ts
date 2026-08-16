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
 * - **A test names personas this project holds.** A write naming one it does
 *   not is refused at the door, in the factory's own words. It is the refusal
 *   nothing on the CLI's side can see coming — the file is perfectly readable
 *   and only the platform knows the answer — so it is the one this fixture has
 *   to be able to make.
 * - **Identifiers are Egma's.** `tst_` and `tstv_`, minted by the same
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

import {
  answerOf,
  delayOf,
  toolNameProblem,
  unknownKeyIn,
  type MockAnswer,
} from "./mock-tools.ts";
import {
  cannotActIn,
  given,
  isId,
  newId,
  NOT_AUTHENTICATED,
  PAGE_SIZE,
  refuse,
  text,
  textList,
} from "./reading.ts";
import type { FixtureAnswer, FixtureRequest, RouteGroup } from "./server.ts";

/** One version of a test, frozen the moment it was written. */
type Version = {
  readonly id: string;
  readonly version: number;
  readonly scenario: string;
  readonly expectedBehaviors: readonly string[];
  /** By identity, in the order they were authored. */
  readonly personaIds: readonly string[];
  /**
   * The tools this test answers for itself, in the order they were authored.
   *
   * Held on the version rather than beside the test, because an override is
   * test content: editing one mints the next version exactly as editing an
   * expected behavior does. It is the half of the mocked world that versions.
   */
  readonly mockOverrides: readonly StoredOverride[];
  readonly createdAt: Date;
};

/** One override as this fixture holds it. No scope: it is the test's own. */
type StoredOverride = {
  readonly toolName: string;
  readonly answer: MockAnswer;
  readonly delayMilliseconds: number;
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
  /** As the wire carries them: `{ tool, answer | error, delay_ms }`. */
  readonly mockTools?: readonly Record<string, unknown>[];
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
  "out and Egma takes the project's default persona.";

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

/** The wire's own refusals for a test's overrides, word for word. */
const MOCK_TOOLS_NOT_A_LIST =
  "mock_tools is the list of tools this test answers for itself. Send " +
  'it as a list of objects, like [{"tool": "check_availability", ' +
  '"answer": {"slots": []}}], or leave it out and the project\'s mock ' +
  "tools are the whole world.";

const AN_OVERRIDE_IS_AN_OBJECT =
  "each entry in mock_tools names one tool and what it answers with. " +
  'Send objects, like {"tool": "check_availability", "error": "the ' +
  'calendar is unreachable"}.';

/** The keys one entry of `mock_tools` holds, and no others. */
const OVERRIDE_KEYS = ["tool", "answer", "error", "delay_ms"] as const;

/**
 * The overrides a body carries, read in the order the shipped route reads
 * them: the envelope's shape here, and everything about the content in the
 * factory below — the same functions a project's own mock tools pass, so a rule
 * enforced on one half of the mocked world is not one a test can walk around.
 */
type WrittenOverrides =
  | { readonly entries: readonly Record<string, unknown>[] }
  | { readonly refusal: string };

function overrideEntries(value: unknown): WrittenOverrides {
  if (!Array.isArray(value)) return { refusal: MOCK_TOOLS_NOT_A_LIST };

  const entries: Record<string, unknown>[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return { refusal: AN_OVERRIDE_IS_AN_OBJECT };
    }
    const written = entry as Record<string, unknown>;
    const unknown = unknownKeyIn(written, OVERRIDE_KEYS, "a mock tool a test overrides");
    if (unknown !== undefined) return { refusal: unknown };
    if ("delay_ms" in written && typeof written.delay_ms !== "number") {
      return {
        refusal:
          "delay_ms is how long Egma holds an answer back, as a whole number " +
          `of milliseconds, and one entry in mock_tools sent ${typeof written.delay_ms}.`,
      };
    }
    entries.push(written);
  }
  return { entries };
}

/** The overrides as they will be stored, or the factory's own refusal. */
function validOverrides(
  written: readonly Record<string, unknown>[],
): { readonly overrides: readonly StoredOverride[] } | { readonly refusal: string } {
  const overrides: StoredOverride[] = [];
  const seen = new Set<string>();

  for (const entry of written) {
    const problem = toolNameProblem(entry.tool);
    if (problem !== undefined) return { refusal: problem };
    const toolName = (entry.tool as string).trim();

    if (seen.has(toolName)) {
      return { refusal: `this test overrides "${toolName}" twice; override each tool once` };
    }
    seen.add(toolName);

    const answer = answerOf(entry);
    if ("refusal" in answer) return { refusal: answer.refusal };
    const delay = delayOf(entry.delay_ms);
    if ("refusal" in delay) return { refusal: delay.refusal };

    overrides.push({
      toolName,
      answer: answer.answer,
      delayMilliseconds: delay.delay,
    });
  }
  return { overrides };
}

/** One override as the wire carries it, in both directions. */
function describedOverride(one: StoredOverride): Record<string, unknown> {
  return { tool: one.toolName, ...one.answer, delay_ms: one.delayMilliseconds };
}

/**
 * Whether two lists of overrides say the same thing. Order is content and so is
 * the answer's own key order, because the answer is compared by its
 * serialization: there is no fixed set of fields a tool's answer has.
 */
function sameOverrides(
  a: readonly StoredOverride[],
  b: readonly StoredOverride[],
): boolean {
  return (
    a.length === b.length &&
    a.every((entry, index) => {
      const other = b[index];
      return (
        other !== undefined &&
        entry.toolName === other.toolName &&
        entry.delayMilliseconds === other.delayMilliseconds &&
        JSON.stringify(entry.answer) === JSON.stringify(other.answer)
      );
    })
  );
}

/**
 * One frozen version, as the run endpoints need it: what test it belongs to,
 * and who calls about it. A run pins one of these per test and produces one
 * simulation per persona named on it.
 */
export type VersionLookup = (versionId: string) => {
  readonly versionId: string;
  readonly testId: string;
  readonly testName: string;
  readonly personas: readonly { readonly id: string; readonly name: string }[];
} | null;

export function testRoutes(options: {
  /** Whether the key a request carries is one this instance minted. */
  readonly holdsKey: (key: string) => boolean;
  /**
   * The one project this key acts in.
   *
   * Handed in rather than minted here, so every group of this fixture agrees
   * about which project this is — a fixture whose halves each believed in a
   * different project could not say anything true about a request that named
   * one.
   */
  readonly projectId: string;
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
  const projectId = options.projectId;

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
   *
   * Both refusals are the shipped API's own sentences, word for word, as the
   * agreement suite pins them: an identifier relays the factory's sentence
   * verbatim (`packages/db/src/access/tests.ts`), and a name — which is what
   * actually crosses the wire — answers the API's fuller sentence, next move
   * included. This is the one refusal the CLI cannot see coming: a file
   * naming a persona reads perfectly well, and only the platform knows which
   * personas it holds.
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
            : `Egma has no persona called "${wanted}" in this project. Name a persona this project already has, or name none and Egma takes the project's default.`,
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
      readonly mockOverrides: readonly StoredOverride[];
    },
  ): Version => {
    const current = currentOf(test);
    const same =
      current.scenario === content.scenario &&
      sameList(current.expectedBehaviors, content.expectedBehaviors) &&
      sameList(current.personaIds, content.personaIds) &&
      sameOverrides(current.mockOverrides, content.mockOverrides);
    if (same) return current;

    const version: Version = {
      id: newId("tstv"),
      version: current.version + 1,
      scenario: content.scenario,
      expectedBehaviors: content.expectedBehaviors,
      personaIds: content.personaIds,
      mockOverrides: content.mockOverrides,
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
    readonly mockOverrides: readonly StoredOverride[];
  }): StoredTest => {
    const version: Version = {
      id: newId("tstv"),
      version: 1,
      scenario: input.scenario.trim(),
      expectedBehaviors: input.expectedBehaviors.map((behavior) => behavior.trim()),
      personaIds: input.personaIds,
      mockOverrides: input.mockOverrides,
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
      mock_tools: current.mockOverrides.map(describedOverride),
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
      return { status: 401, body: NOT_AUTHENTICATED };
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
   *
   * It takes what the caller said rather than the raw field, because a body
   * trims what it carries and a query string does not — the difference is the
   * API's, so it is made at each door rather than smoothed over here.
   */
  const projectNamed = (named: string | undefined): FixtureAnswer | null => {
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
  ):
    | {
        readonly ids: readonly string[] | undefined;
        readonly overrides: readonly Record<string, unknown>[] | undefined;
      }
    | { readonly answer: FixtureAnswer } => {
    const named = "personas" in said ? personaEntries(said.personas) : undefined;
    if (named !== undefined && "refusal" in named) {
      return { answer: refuse(422, "unprocessable", named.refusal) };
    }

    // The shape of the overrides is read straight after the shape of the
    // personas and still before the project, because both are answerable
    // without knowing anything about what this project holds.
    const written = "mock_tools" in said ? overrideEntries(said.mock_tools) : undefined;
    if (written !== undefined && "refusal" in written) {
      return { answer: refuse(422, "unprocessable", written.refusal) };
    }

    const outsider = projectNamed(given(text(said.project)));
    if (outsider !== null) return { answer: outsider };

    const overrides = written === undefined ? undefined : written.entries;
    if (named === undefined) return { ids: undefined, overrides };

    const resolved = resolvePersonas(named.entries);
    if ("refusal" in resolved) {
      return { answer: refuse(422, "unprocessable", resolved.refusal) };
    }
    return { ids: resolved.ids, overrides };
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
          readonly mockOverrides: readonly StoredOverride[];
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

    // Last of the content, exactly as the factory reads it: the scenario and
    // the behaviors are what a test is, and the mocked world it runs in comes
    // after they hold up.
    const overrides = validOverrides(who.overrides ?? []);
    if ("refusal" in overrides) {
      return { answer: refuse(422, "unprocessable", overrides.refusal) };
    }

    return {
      input: {
        name,
        scenario,
        expectedBehaviors: [...expectedBehaviors],
        // Absent means the project's default persona, exactly as an empty list
        // does: a first test costs nobody a persona to author.
        personaIds: who.ids ?? [defaultPersonaId],
        mockOverrides: overrides.overrides,
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
            const outsider = projectNamed(given(request.url.searchParams.get("project")));
            if (outsider !== null) return outsider;

            const cursor = given(request.url.searchParams.get("cursor"));
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
                `there is no test version ${wanted} on this Egma. List the tests ` +
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
                mock_tools: version.mockOverrides.map(describedOverride),
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
                `there is no test ${request.params.testId ?? ""} on this Egma. List ` +
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

            // An empty list is not the same as leaving the field out: it clears
            // the overrides and leaves the project's mock tools the whole world.
            const overrides =
              who.overrides === undefined
                ? { overrides: current.mockOverrides }
                : validOverrides(who.overrides);
            if ("refusal" in overrides) {
              return refuse(422, "unprocessable", overrides.refusal);
            }

            write(test, {
              scenario: content.scenario,
              expectedBehaviors: [...content.expectedBehaviors],
              personaIds: who.ids ?? current.personaIds,
              mockOverrides: overrides.overrides,
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
      const overrides = validOverrides(seed.mockTools ?? []);
      if ("refusal" in overrides) throw new Error(overrides.refusal);
      return seededFrom(
        create({
          name: seed.name,
          scenario: seed.scenario,
          expectedBehaviors: seed.expectedBehaviors,
          personaIds: ids.length === 0 ? [defaultPersonaId] : ids,
          mockOverrides: overrides.overrides,
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
      const overrides =
        changes.mockTools === undefined
          ? { overrides: current.mockOverrides }
          : validOverrides(changes.mockTools);
      if ("refusal" in overrides) throw new Error(overrides.refusal);
      write(test, {
        scenario: (changes.scenario ?? current.scenario).trim(),
        expectedBehaviors: (changes.expectedBehaviors ?? current.expectedBehaviors).map(
          (behavior) => behavior.trim(),
        ),
        personaIds,
        mockOverrides: overrides.overrides,
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
