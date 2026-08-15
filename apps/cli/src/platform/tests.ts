/**
 * The tests on the platform, over egma's public HTTP API.
 *
 * The platform is the versioned store and the folder is a working copy, so this
 * module reads two things and writes two things: the tests as they currently
 * stand, one frozen version by its own id, a new test, and an edit to one.
 *
 * **Authored things are never overwritten.** An edit does not change a version;
 * it creates the next one and moves the pointer, so a run that pinned the old
 * one still says exactly what it executed. That is why a write carries the
 * version the writer last saw: the platform compares it against what is current
 * and refuses when the two have parted, which is the whole of the refusal rule
 * and it is enforced there rather than here. This end checks first only so that
 * a push that is going to be refused is refused before it has written anything.
 *
 * Two shapes of answer are values rather than exceptions, because both are
 * ordinary things that happen to somebody working in a team: the platform has
 * moved on, and the platform turned a test away at its door. Everything else —
 * an instance that did not answer, a key that is not one — is thrown, because
 * nothing further up can do anything sensible with it.
 */

import type { MockToolEntry } from "../folder/mock-tools.ts";
import type { Fetch } from "./device-flow.ts";
import { overrideFrom } from "./mock-tools.ts";
import { PlatformRefusedError } from "./refused.ts";
import type { SignedIn } from "./signed-in.ts";
import { ask, saidBy, text } from "./wire.ts";

/** A test as the platform currently has it. */
export type PlatformTest = {
  readonly id: string;
  readonly name: string;
  /** The current version's own id — what a file pins and a run pins. */
  readonly versionId: string;
  readonly version: number;
  readonly scenario: string;
  readonly expectedBehaviors: readonly string[];
  /** By name, in the order they were authored. */
  readonly personas: readonly string[];
  /**
   * The tools this test answers for itself.
   *
   * Content, like the expected behaviors beside them: an override versions with
   * the test, so editing one mints the next version exactly as editing a
   * behavior does. That is why they ride this shape rather than the mock tool
   * group's, which versions nothing.
   */
  readonly mockTools: readonly MockToolEntry[];
};

/** One frozen version, and whether the test has since moved past it. */
export type PlatformTestVersion = {
  readonly id: string;
  readonly testId: string;
  readonly testName: string;
  readonly version: number;
  /** False once a later version exists. */
  readonly current: boolean;
};

/** What a write came back with. */
export type WriteAnswer =
  | { readonly kind: "written"; readonly test: PlatformTest }
  /** The platform has moved since the version this write named. */
  | {
      readonly kind: "moved";
      readonly testName: string;
      readonly currentVersionId: string;
    }
  /** The platform turned the test away at its door, in its own words. */
  | { readonly kind: "turned-away"; readonly reason: string };

/**
 * The personas a version names, by name.
 *
 * A file says `personas: [impatient-caller]`, because a folder a team reviews
 * cannot be a folder of identifiers. So the wire carries names in both
 * directions and the platform is what resolves them.
 */
function personaNames(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const named =
      typeof entry === "object" && entry !== null
        ? text((entry as Record<string, unknown>).name)
        : text(entry);
    return named === "" ? [] : [named];
  });
}

/**
 * The behaviors a version holds, as statements.
 *
 * The platform answers each with the priority it carries — P0 blocks, P1 warns,
 * P2 informs — and this folder's file format has no way to write one down yet,
 * so what a file round-trips is the statement. Reading both shapes is what lets
 * an older platform and a newer one both be pulled from without the folder
 * caring which it is talking to; writing the priority back is the file format's
 * own change and is not this one.
 */
function behaviorStatements(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const written =
      typeof entry === "object" && entry !== null
        ? text((entry as Record<string, unknown>).behavior)
        : text(entry);
    return written === "" ? [] : [written];
  });
}

function testFrom(body: Record<string, unknown>): PlatformTest {
  return {
    id: text(body.id),
    name: text(body.name),
    versionId: text(body.version_id),
    version: typeof body.version === "number" ? body.version : 0,
    scenario: text(body.scenario),
    expectedBehaviors: behaviorStatements(body.expected_behaviors),
    personas: personaNames(body.personas),
    mockTools: mockToolsIn(body.mock_tools),
  };
}

/**
 * The overrides a test carries, in the order they were authored.
 *
 * Order is content: it is what the platform stores and what it compares an edit
 * against, so a folder that reordered them would mint a version saying nothing.
 */
function mockToolsIn(value: unknown): readonly MockToolEntry[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) =>
    typeof entry === "object" && entry !== null
      ? [overrideFrom(entry as Record<string, unknown>)]
      : [],
  );
}

/**
 * Everything the credential reaches, newest first, following every page.
 *
 * Every list in this API answers one envelope — `{ items, next_cursor }` — and
 * the page is read out of `items` whatever the list is of. One envelope is what
 * lets a client hold one function for "walk every page" rather than one per
 * resource, and it is what stops a new list arriving with a key nobody guessed.
 */
export async function listTests(
  signedIn: SignedIn,
  fetchImpl?: Fetch,
): Promise<readonly PlatformTest[]> {
  const found: PlatformTest[] = [];
  let cursor: string | null = null;

  for (;;) {
    const at: string =
      cursor === null ? "/api/tests" : `/api/tests?cursor=${encodeURIComponent(cursor)}`;
    const { response, body } = await ask({
      signedIn,
      path: at,
      ...(fetchImpl === undefined ? {} : { fetchImpl }),
    });
    if (!response.ok) throw new PlatformRefusedError(response.status, saidBy(body, response.status));

    for (const entry of Array.isArray(body.items) ? body.items : []) {
      if (typeof entry === "object" && entry !== null) {
        found.push(testFrom(entry as Record<string, unknown>));
      }
    }

    const next = text(body.next_cursor);
    if (next === "") return found;
    cursor = next;
  }
}

/**
 * One version by its own id — how a pinned file says which test it is a draft
 * of, and how a stale pin is told from one the platform has never heard of.
 */
export async function getTestVersion(
  signedIn: SignedIn,
  versionId: string,
  fetchImpl?: Fetch,
): Promise<PlatformTestVersion | null> {
  const { response, body } = await ask({
    signedIn,
    path: `/api/test-versions/${encodeURIComponent(versionId)}`,
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
  });

  if (response.status === 404) return null;
  if (!response.ok) throw new PlatformRefusedError(response.status, saidBy(body, response.status));

  return {
    id: text(body.id),
    testId: text(body.test_id),
    testName: text(body.test_name),
    version: typeof body.version === "number" ? body.version : 0,
    current: body.current === true,
  };
}

/** What a write says about one test. */
export type TestInput = {
  readonly name: string;
  readonly scenario: string;
  readonly expectedBehaviors: readonly string[];
  /** By name. Empty takes the default persona. */
  readonly personas: readonly string[];
  /**
   * The tools this test answers for itself. Empty clears them and leaves the
   * project's mock tools the whole world, which is why it is always sent: a
   * write that left the field out would keep overrides the file no longer has.
   */
  readonly mockTools: readonly MockToolEntry[];
};

/**
 * What a create says beyond the test itself: the agent this repository is bound
 * to.
 *
 * **A test always applies to at least one agent**, and the one a repository can
 * honestly name is its own — `egma/config.yaml` binds the folder to exactly one.
 * A create that named none would be answered with the platform's own refusal,
 * which is the right answer for a folder bound to nothing.
 *
 * An edit never carries it. Which agents a test applies to is edited in the
 * browser and has its own revision on the platform; a push that sent the bound
 * agent on every edit would make one file the source of truth for a set it
 * cannot see.
 */
export type CreateInput = TestInput & {
  /** The `agt_` id in `egma/config.yaml`, when the folder is bound to one. */
  readonly agentId: string | null;
};

function writeBody(input: TestInput): Record<string, unknown> {
  return {
    name: input.name,
    scenario: input.scenario,
    expected_behaviors: [...input.expectedBehaviors],
    personas: [...input.personas],
    // The heading names the tool and the block says the rest, so what goes up
    // is the block with the heading's name put back on it. Nothing here judges
    // what the block said; egma's door does, in egma's own words.
    mock_tools: input.mockTools.map((entry) => ({ ...entry.says, tool: entry.tool })),
  };
}

function answerFor(
  status: number,
  body: Record<string, unknown>,
): WriteAnswer | null {
  if (status === 409) {
    return {
      kind: "moved",
      testName: text((body.test as Record<string, unknown> | undefined)?.name) || text(body.name),
      currentVersionId: text(body.current_version_id),
    };
  }
  if (status === 422) return { kind: "turned-away", reason: saidBy(body, status) };
  return null;
}

export async function createTest(
  signedIn: SignedIn,
  input: CreateInput,
  fetchImpl?: Fetch,
): Promise<WriteAnswer> {
  const { response, body } = await ask({
    signedIn,
    path: "/api/tests",
    method: "POST",
    body: {
      ...writeBody(input),
      ...(input.agentId === null ? {} : { agents: [input.agentId] }),
    },
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
  });

  const expected = answerFor(response.status, body);
  if (expected !== null) return expected;
  if (!response.ok) throw new PlatformRefusedError(response.status, saidBy(body, response.status));
  return { kind: "written", test: testFrom(body) };
}

/**
 * Edit one test, saying which version this edit was written against.
 *
 * `expectedVersionId` is the whole refusal rule on the wire. The platform
 * compares it against what is current and answers `moved` when they differ, so
 * a teammate's dashboard edit cannot be lost by a push that started before it.
 */
export async function editTest(
  signedIn: SignedIn,
  testId: string,
  expectedVersionId: string,
  input: TestInput,
  fetchImpl?: Fetch,
): Promise<WriteAnswer> {
  const { response, body } = await ask({
    signedIn,
    path: `/api/tests/${encodeURIComponent(testId)}`,
    method: "PATCH",
    body: { ...writeBody(input), expected_version_id: expectedVersionId },
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
  });

  const expected = answerFor(response.status, body);
  if (expected !== null) return expected;
  if (!response.ok) throw new PlatformRefusedError(response.status, saidBy(body, response.status));
  return { kind: "written", test: testFrom(body) };
}
