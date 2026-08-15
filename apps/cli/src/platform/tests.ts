/**
 * The tests on the platform, over egma's HTTP API.
 *
 * The platform is the versioned store and the folder is a working copy, so this
 * module reads two things and writes two things: the tests as they currently
 * stand, one frozen version by its own id, a new test, and an edit to one.
 *
 * **Authored things are never overwritten.** An edit does not change a version;
 * it creates the next one and moves the pointer, so a run that pinned the old
 * one still says exactly what it executed. That is why a write carries what the
 * writer last saw: the platform compares it against what is current and refuses
 * when the two have parted, which is the whole of the refusal rule and it is
 * enforced there rather than here. This end checks first only so that a push
 * that is going to be refused is refused before it has written anything.
 *
 * **A test has three halves that move apart, and a repository copy pins two of
 * them.** The content a run is judged by carries `expected_version_id`; the
 * live name and description carry `expected_revision`; which agents the test
 * applies to carries neither, because the browser owns that set and a link edit
 * makes no repository copy stale. A write that named one token for all three
 * would refuse a scenario edit because somebody renamed the test.
 *
 * Four shapes of answer are values rather than exceptions, because all four are
 * ordinary things that happen to somebody working in a team: the content has
 * moved on, the live half has moved on, the test no longer applies to the agent
 * this repository is bound to, and the platform turned the test away at its
 * door. Everything else — an instance that did not answer, a key that is not
 * one — is thrown, because nothing further up can do anything sensible with it.
 */

import type { MockToolEntry } from "../folder/mock-tools.ts";
import type { ExpectedBehavior, FilePersona } from "../folder/test-file.ts";
import type { Fetch } from "./device-flow.ts";
import { overrideFrom } from "./mock-tools.ts";
import { PlatformRefusedError } from "./refused.ts";
import type { SignedIn } from "./signed-in.ts";
import { ask, saidBy, text, textList } from "./wire.ts";

/** The whole of one test's content, as a file holds it and a version pins it. */
export type PlatformContent = {
  readonly scenario: string;
  readonly expectedBehaviors: readonly ExpectedBehavior[];
  /** By identity and display name, in the order they were authored. */
  readonly personas: readonly FilePersona[];
  /** What a connection has to be able to do. */
  readonly requiredCapabilities: readonly string[];
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

/** A test as the platform currently has it. */
export type PlatformTest = PlatformContent & {
  readonly id: string;
  readonly name: string;
  /** Live metadata beside the name; empty when the test carries none. */
  readonly description: string;
  /** The current version's own id — what a file pins and a run pins. */
  readonly versionId: string;
  readonly version: number;
  /** The live half's opaque token — the other thing a file pins. */
  readonly revision: string;
  /** Every agent this test applies to, archived links included. */
  readonly agentIds: readonly string[];
};

/** One frozen version, and whether the test has since moved past it. */
export type PlatformTestVersion = PlatformContent & {
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
  /** The platform's content has moved since the version this write named. */
  | {
      readonly kind: "moved";
      readonly testName: string;
      readonly currentVersionId: string;
    }
  /** The live half has moved since the revision this write named. */
  | { readonly kind: "identity-moved"; readonly reason: string }
  /** This test no longer applies to the agent this repository is bound to. */
  | { readonly kind: "not-applicable"; readonly reason: string }
  /** The platform turned the test away at its door, in its own words. */
  | { readonly kind: "turned-away"; readonly reason: string };

/**
 * The personas a version names.
 *
 * The identifier is what a push resolves and the name is what a reviewer reads.
 * Older platforms answered names alone, and one read as a bare string still
 * comes back as a persona with no id — which resolves by name, exactly as a
 * version-1 file does.
 */
function personasIn(value: unknown): readonly FilePersona[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) {
      const name = text(entry);
      return name === "" ? [] : [{ id: "", name }];
    }
    const said = entry as Record<string, unknown>;
    const persona = { id: text(said.id), name: text(said.name) };
    return persona.id === "" && persona.name === "" ? [] : [persona];
  });
}

/**
 * The behaviors a version holds: plain sentences, in the order authored.
 *
 * **The retired object shape is still read, and only on the way in.** The
 * platform answers sentences now, and a stored version frozen before the ladder
 * retired still carries `{behavior, priority}` beside each one — a frozen
 * version is read past rather than rewritten, which is the platform's own rule.
 * So an object is unwrapped to the sentence inside it and the priority is
 * dropped. Nothing writes the shape back: `writeBody` sends sentences, and
 * egma's door refuses the object shape by name.
 */
function behaviorsIn(value: unknown): readonly ExpectedBehavior[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const written =
      typeof entry === "object" && entry !== null
        ? text((entry as Record<string, unknown>).behavior)
        : text(entry);
    return written === "" ? [] : [written];
  });
}

/** The `id` of every entry of a list of named things, in order. */
function idsIn(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const id =
      typeof entry === "object" && entry !== null
        ? text((entry as Record<string, unknown>).id)
        : text(entry);
    return id === "" ? [] : [id];
  });
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

function contentFrom(body: Record<string, unknown>): PlatformContent {
  return {
    scenario: text(body.scenario),
    expectedBehaviors: behaviorsIn(body.expected_behaviors),
    personas: personasIn(body.personas),
    requiredCapabilities: textList(body.required_capabilities),
    mockTools: mockToolsIn(body.mock_tools),
  };
}

function testFrom(body: Record<string, unknown>): PlatformTest {
  return {
    ...contentFrom(body),
    id: text(body.id),
    name: text(body.name),
    description: text(body.description),
    versionId: text(body.version_id),
    version: typeof body.version === "number" ? body.version : 0,
    revision: text(body.revision),
    agentIds: idsIn(body.agents),
  };
}

/** Which tests to read. */
export type ListOptions = {
  /**
   * The agent this repository is bound to.
   *
   * **The list is the repository's whole view of the platform**, so narrowing
   * it here is what keeps one file from becoming a second source of truth for a
   * set of links it cannot see. A repository bound to nothing sees everything,
   * which is what a folder that has never been connected is looking at.
   */
  readonly agentId?: string | null;
  readonly fetchImpl?: Fetch;
};

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
  options: ListOptions = {},
): Promise<readonly PlatformTest[]> {
  const { agentId = null, fetchImpl } = options;
  const found: PlatformTest[] = [];
  let cursor: string | null = null;

  for (;;) {
    const query = new URLSearchParams();
    if (agentId !== null && agentId !== "") query.set("agent", agentId);
    if (cursor !== null) query.set("cursor", cursor);
    const at = query.size === 0 ? "/api/tests" : `/api/tests?${query.toString()}`;
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
 * One test by its own id, whatever state it is in.
 *
 * The list a repository reads is narrowed to its bound agent and to what is
 * active, so a test that has left that list has left it for one of three
 * reasons and they need three different sentences: it was archived, the browser
 * unlinked the agent, or this credential can no longer see it at all. Guessing
 * between them would put the wrong instruction in a refusal, which is the one
 * thing a refusal must not do. So it is asked, and only in the case where the
 * list has already come up empty-handed.
 */
export async function getTest(
  signedIn: SignedIn,
  testId: string,
  fetchImpl?: Fetch,
): Promise<{ readonly test: PlatformTest; readonly archived: boolean } | null> {
  const { response, body } = await ask({
    signedIn,
    path: `/api/tests/${encodeURIComponent(testId)}`,
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
  });

  if (response.status === 404) return null;
  if (!response.ok) throw new PlatformRefusedError(response.status, saidBy(body, response.status));

  return { test: testFrom(body), archived: text(body.archived_at) !== "" };
}

/**
 * One version by its own id — how a pinned file says which test it is a draft
 * of, and how a stale pin is told from one the platform has never heard of.
 *
 * It answers the version's whole content, because that is what makes an old
 * file safe to migrate: a file pinned to a version and saying exactly what that
 * version says is a faithful copy with no draft in it, and only a faithful copy
 * may be rewritten in the newer format without asking anybody.
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
    ...contentFrom(body),
    id: text(body.id),
    testId: text(body.test_id),
    testName: text(body.test_name),
    version: typeof body.version === "number" ? body.version : 0,
    current: body.current === true,
  };
}

/** What a write says about one test. */
export type TestInput = PlatformContent & {
  readonly name: string;
  /** Live metadata beside the name. Always sent, so clearing it works. */
  readonly description: string;
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
 * An edit never carries it as a *change*. Which agents a test applies to is
 * edited in the browser and has its own revision on the platform; a push that
 * sent the bound agent on every edit would make one file the source of truth
 * for a set it cannot see. It rides an edit only as `repository_agent`, which
 * the platform reads as a question — *does this test still apply to me?* — and
 * never as an instruction.
 */
export type CreateInput = TestInput & {
  /** The `agt_` id in `egma/config.yaml`, when the folder is bound to one. */
  readonly agentId: string | null;
};

/**
 * How a write names one persona: by identity where the file has one, and by
 * name where it does not.
 *
 * The display name beside an id is never sent. It is what a reviewer reads and
 * the platform's own copy is the one that is true, so sending it could only
 * ever be a second opinion about a name egma already knows.
 */
function personaFor(persona: FilePersona): string {
  return persona.id.trim() === "" ? persona.name : persona.id;
}

function writeBody(input: TestInput): Record<string, unknown> {
  return {
    name: input.name,
    description: input.description,
    scenario: input.scenario,
    expected_behaviors: [...input.expectedBehaviors],
    personas: input.personas.map(personaFor),
    required_capabilities: [...input.requiredCapabilities],
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
    const code = text(body.error);
    if (code === "identity_conflict") {
      return { kind: "identity-moved", reason: saidBy(body, status) };
    }
    if (code === "repository_agent_not_applicable") {
      return { kind: "not-applicable", reason: saidBy(body, status) };
    }
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

/** What an edit was written against, and which repository is sending it. */
export type EditExpectations = {
  /** The content version this file was last synced at. */
  readonly versionId: string;
  /** The live-half revision this file was last synced at. */
  readonly revision: string;
  /** The agent this repository is bound to, when it is bound to one. */
  readonly agentId: string | null;
};

/**
 * Edit one test, saying what this edit was written against.
 *
 * The two expectations are the whole refusal rule on the wire. The platform
 * compares each against what is current and answers separately, so a teammate's
 * scenario edit and a teammate's rename each refuse the write they would
 * actually have overwritten and neither refuses the other.
 *
 * `repository_agent` is a question and not a change. The platform answers it by
 * refusing when the test no longer applies to that agent, which is the one way
 * a repository bound to one agent can be told that the browser took its link
 * away — and it is told before anything is written rather than after.
 */
export async function editTest(
  signedIn: SignedIn,
  testId: string,
  expectations: EditExpectations,
  input: TestInput,
  fetchImpl?: Fetch,
): Promise<WriteAnswer> {
  const { response, body } = await ask({
    signedIn,
    path: `/api/tests/${encodeURIComponent(testId)}`,
    method: "PATCH",
    body: {
      ...writeBody(input),
      expected_version_id: expectations.versionId,
      ...(expectations.revision === ""
        ? {}
        : { expected_revision: expectations.revision }),
      ...(expectations.agentId === null || expectations.agentId === ""
        ? {}
        : { repository_agent: expectations.agentId }),
    },
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
  });

  const expected = answerFor(response.status, body);
  if (expected !== null) return expected;
  if (!response.ok) throw new PlatformRefusedError(response.status, saidBy(body, response.status));
  return { kind: "written", test: testFrom(body) };
}
