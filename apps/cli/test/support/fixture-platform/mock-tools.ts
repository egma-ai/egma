/**
 * The mock tool endpoints of the fixture platform.
 *
 * This is the contract the folder's mock tools are built against, written down
 * as something that runs. It mirrors the real factory
 * (`packages/db/src/access/mock-tools.ts`) and its route group where the
 * mirroring is what the CLI depends on, and it is deliberately not kinder than
 * the real thing anywhere:
 *
 * - **An edit overwrites.** There is no `expected_version_id` here and there is
 *   no version to name: a mock tool is the one authored thing egma does not
 *   version. So a second push of the same file is a write that changes nothing
 *   rather than a conflict.
 * - **One answer per tool name.** A create naming a tool this project already
 *   answers for is refused, in the factory's own words.
 * - **The content gates are the platform's.** A blank tool name, both answer
 *   branches at once or neither, a delay past the budget, an answer past what
 *   the exchange carries — every one of them is refused here in the sentence
 *   the shipped API says, because the CLI's whole job with them is to relay
 *   what it was told.
 * - **The two ceilings are read from the platform's own constants**, never
 *   copied: a fixture holding its own 30 000 would go on refusing at 30 000
 *   for a year after the budget moved, and the client would ship a check
 *   against a number nothing enforces.
 *
 * One thing is the public API's rather than the factory's: **agents cross the
 * wire by name.** A file in a repository says `agents: [front-desk]`, so that
 * one shape crosses in both directions and resolving it is the platform's job.
 */

import {
  LARGEST_MOCK_TOOL_ANSWER_BYTES,
  LONGEST_MOCK_TOOL_DELAY_MILLISECONDS,
} from "@egma/db";

import {
  cannotActIn,
  given,
  isId,
  newId,
  NOT_AUTHENTICATED,
  PAGE_SIZE,
  refuse,
  text,
} from "./reading.ts";
import type { FixtureAnswer, FixtureRequest, RouteGroup } from "./server.ts";

/** What one mock tool answers with: one branch, never both and never none. */
export type MockAnswer = { readonly answer: unknown } | { readonly error: string };

/** One mock tool as this fixture holds it. */
type StoredMockTool = {
  readonly id: string;
  toolName: string;
  answer: MockAnswer;
  delayMilliseconds: number;
  /** By identity, in the order they were authored. Empty means every agent. */
  agentIds: readonly string[];
  readonly createdAt: Date;
  updatedAt: Date;
};

/** An agent a mock tool's scope may name. */
export type NamedAgent = { readonly id: string; readonly name: string };

export type SeedMockTool = {
  readonly tool: string;
  readonly answer?: unknown;
  readonly error?: string;
  readonly delayMilliseconds?: number;
  /** By name or identifier, exactly as a file writes them. */
  readonly agents?: readonly string[];
};

export type SeededMockTool = {
  readonly id: string;
  readonly tool: string;
};

export type MockToolControls = {
  /** Author one, as somebody working in the dashboard would have. */
  add(seed: SeedMockTool): SeededMockTool;
  /** Edit one, as a teammate does while a developer is part way through. */
  editInDashboard(tool: string, changes: Partial<SeedMockTool>): SeededMockTool;
  /** Every mock tool, oldest first, for a check that wants to look. */
  readonly mockTools: readonly (SeededMockTool & {
    readonly answer: MockAnswer;
    readonly delayMilliseconds: number;
    readonly agents: readonly string[];
  })[];
};

/** The keys a mock tool's body holds, and no others. */
const MOCK_TOOL_KEYS = ["tool", "answer", "error", "delay_ms", "agents", "project"] as const;

/** The route group's own refusals, word for word. */
export function unknownKeyIn(
  body: Record<string, unknown>,
  keys: readonly string[],
  what: string,
): string | undefined {
  for (const key of Object.keys(body)) {
    if (keys.includes(key)) continue;
    return `${what} has no key "${key}"; it holds ${keys.join(", ")}`;
  }
  return undefined;
}

const AGENTS_NOT_A_LIST =
  "agents is the list of agents this mock tool applies to, by name. " +
  'Send it as a list of text, like ["front-desk"], or leave it out and ' +
  "the mock tool applies to every agent in the project.";

const AN_AGENT_IS_TEXT =
  "a mock tool names each agent as text — its name, or its agt_ " +
  "identifier — and one entry in agents is neither. Send it as a " +
  'list of text, like ["front-desk"].';

function delayIsNotANumber(sent: string): string {
  return (
    "delay_ms is how long Egma holds this answer back, as a whole number " +
    `of milliseconds, and this request sent ${sent}.`
  );
}

/** The factory's own refusals, word for word. */
export function toolNameProblem(name: unknown): string | undefined {
  if (typeof name !== "string") {
    return (
      "tool is the name of the agent's tool this mock tool answers for, " +
      `written as text, and this request sent ${typeof name}.`
    );
  }
  if (name.trim() === "") {
    return (
      "tool is the name of the agent's tool this mock tool answers for, and " +
      "this one is blank. Send the tool's name exactly as the agent " +
      "registers it."
    );
  }
  return undefined;
}

function tooLarge(key: "answer" | "error", bytes: number): string {
  return (
    `${key} is ${bytes} bytes once serialized and tagged for the wire, and ` +
    `the exchange that carries it holds at most ` +
    `${LARGEST_MOCK_TOOL_ANSWER_BYTES}. An answer that needs more than that ` +
    `is a document rather than a tool answer.`
  );
}

/** The tagged envelope, which is what the exchange carries and counts. */
function servedBytes(value: unknown, key: "answer" | "error"): number {
  return Buffer.byteLength(`{"${key}":${JSON.stringify(value) ?? ""}}`, "utf8");
}

/** The answer as it will be stored: exactly one branch, within the size. */
export function answerOf(
  body: Record<string, unknown>,
): { readonly answer: MockAnswer } | { readonly refusal: string } {
  const gives = "answer" in body && body.answer !== undefined;
  const fails = "error" in body && body.error !== undefined;

  if (gives && fails) {
    return {
      refusal:
        "a mock tool answers with one thing: this one sent both answer and " +
        "error. Send whichever branch the test needs.",
    };
  }
  if (!gives && !fails) {
    return {
      refusal:
        "a mock tool answers with something: send answer with what the tool " +
        "returns, or error with the failure it raises. This one sent neither.",
    };
  }

  if (fails) {
    const message = body.error;
    if (typeof message !== "string") {
      return {
        refusal:
          "error is the failure this mock tool raises, written as text, and " +
          `this request sent ${typeof message}.`,
      };
    }
    if (message.trim() === "") {
      return {
        refusal:
          "error is the failure this mock tool raises, and this one is blank. " +
          "Say what the agent's backend would have said.",
      };
    }
    const bytes = servedBytes(message, "error");
    if (bytes > LARGEST_MOCK_TOOL_ANSWER_BYTES) {
      return { refusal: tooLarge("error", bytes) };
    }
    return { answer: { error: message } };
  }

  const bytes = servedBytes(body.answer, "answer");
  if (bytes > LARGEST_MOCK_TOOL_ANSWER_BYTES) {
    return { refusal: tooLarge("answer", bytes) };
  }
  return { answer: { answer: body.answer } };
}

/** The delay as it will be stored, refused with the arithmetic the fix needs. */
export function delayOf(
  milliseconds: unknown,
): { readonly delay: number } | { readonly refusal: string } {
  if (milliseconds === undefined) return { delay: 0 };
  if (typeof milliseconds !== "number") return { delay: 0 };
  if (!Number.isInteger(milliseconds) || milliseconds < 0) {
    return {
      refusal:
        `delay_ms is a whole number of milliseconds, zero or more, and this ` +
        `request sent ${JSON.stringify(milliseconds)}.`,
    };
  }
  if (milliseconds > LONGEST_MOCK_TOOL_DELAY_MILLISECONDS) {
    return {
      refusal:
        `delay_ms is ${milliseconds}, and a mock tool may delay its answer by ` +
        `at most ${LONGEST_MOCK_TOOL_DELAY_MILLISECONDS} milliseconds — the ` +
        `budget the exchange carrying it is given. Send a smaller delay_ms.`,
    };
  }
  return { delay: milliseconds };
}

function noSuchAgent(named: string): string {
  return (
    `agents names ${named}, and there is no agent ${named} in this project. ` +
    `Name an agent this project already holds, or leave agents out and the ` +
    `mock tool applies to every agent in the project.`
  );
}

function takenBy(toolName: string, mockToolId: string): string {
  return (
    `this project already answers for "${toolName}", with mock tool ` +
    `${mockToolId}. One answer per tool: edit that one, or override ` +
    `it on the test that needs a different branch.`
  );
}

function noSuchMockTool(mockToolId: string): string {
  return (
    `there is no mock tool ${mockToolId} on this Egma. List the mock tools ` +
    `to see what this project answers for.`
  );
}

export function mockToolRoutes(options: {
  readonly holdsKey: (key: string) => boolean;
  readonly projectId: string;
  /** The agents a scope may name, read fresh so a late registration counts. */
  readonly agentsHere: () => readonly NamedAgent[];
}): { readonly group: RouteGroup; readonly controls: MockToolControls } {
  const mockTools: StoredMockTool[] = [];
  const projectId = options.projectId;

  const byTool = (toolName: string): StoredMockTool | undefined =>
    mockTools.find((one) => one.toolName === toolName);

  const namesOf = (agentIds: readonly string[]): readonly NamedAgent[] =>
    agentIds.flatMap((id) => options.agentsHere().filter((named) => named.id === id));

  /**
   * The agent ids a write names, from the names or ids a reviewed file carries.
   * The identifier is tried first, so a project holding an agent whose name is
   * another agent's identifier still resolves the identifier.
   */
  const resolveAgents = (
    named: readonly string[],
  ): { readonly ids: readonly string[] } | { readonly refusal: string } => {
    const here = options.agentsHere();
    const ids: string[] = [];
    for (const entry of named.map((one) => one.trim())) {
      const found =
        here.find((one) => one.id === entry) ?? here.find((one) => one.name === entry);
      if (found === undefined) return { refusal: noSuchAgent(entry) };
      if (ids.includes(found.id)) {
        return { refusal: `agents names agent ${found.id} twice; name each agent once` };
      }
      ids.push(found.id);
    }
    return { ids };
  };

  const agentEntries = (
    value: unknown,
  ): { readonly entries: readonly string[] } | { readonly refusal: string } => {
    if (!Array.isArray(value)) return { refusal: AGENTS_NOT_A_LIST };
    const entries: string[] = [];
    for (const entry of value) {
      const named = text(entry);
      if (typeof entry !== "string" || named === "") return { refusal: AN_AGENT_IS_TEXT };
      entries.push(named);
    }
    return { entries };
  };

  const described = (one: StoredMockTool): Record<string, unknown> => ({
    id: one.id,
    tool: one.toolName,
    ...one.answer,
    delay_ms: one.delayMilliseconds,
    agents: namesOf(one.agentIds).map((named) => ({ id: named.id, name: named.name })),
    created_at: one.createdAt.toISOString(),
    updated_at: one.updatedAt.toISOString(),
  });

  const behindAKey = (request: FixtureRequest, answer: () => FixtureAnswer): FixtureAnswer => {
    const offered = (request.headers.authorization ?? "").replace(/^Bearer\s+/iu, "");
    if (offered === "" || !options.holdsKey(offered)) {
      return { status: 401, body: NOT_AUTHENTICATED };
    }
    return answer();
  };

  const projectNamed = (named: string | undefined): FixtureAnswer | null =>
    named === undefined || named === projectId
      ? null
      : refuse(403, "not_permitted", cannotActIn(named));

  /**
   * What a body says, read in exactly the order the shipped route reads it.
   *
   * The order is contract as much as the sentences are: the envelope's unknown
   * keys, then the delay's shape, then the agents' shape, then the project,
   * then the agents themselves, and only then anything the factory checks. A
   * caller fixing one refusal at a time meets them in that order.
   */
  type Written = {
    readonly toolName: string | undefined;
    readonly answer: MockAnswer | undefined;
    readonly delay: number | undefined;
    readonly agentIds: readonly string[] | undefined;
  };

  const readWrite = (
    body: Record<string, unknown> | null,
    kind: "create" | "edit",
  ): { readonly written: Written } | { readonly refused: FixtureAnswer } => {
    const said = body ?? {};

    const unknown = unknownKeyIn(said, MOCK_TOOL_KEYS, "a mock tool");
    if (unknown !== undefined) return { refused: refuse(400, "invalid_request", unknown) };

    if ("delay_ms" in said && said.delay_ms !== undefined && typeof said.delay_ms !== "number") {
      return {
        refused: refuse(422, "unprocessable", delayIsNotANumber(typeof said.delay_ms)),
      };
    }

    const named = "agents" in said ? agentEntries(said.agents) : undefined;
    if (named !== undefined && "refusal" in named) {
      return { refused: refuse(422, "unprocessable", named.refusal) };
    }

    const outsider = projectNamed(given(text(said.project)));
    if (outsider !== null) return { refused: outsider };

    const resolved = named === undefined ? undefined : resolveAgents(named.entries);
    if (resolved !== undefined && "refusal" in resolved) {
      return { refused: refuse(422, "unprocessable", resolved.refusal) };
    }

    // The factory's own order: the name, then the answer, then the delay. What
    // an edit leaves out, the mock tool keeps — so only what the body mentioned
    // is judged, and a create mentions everything by definition. It turns on
    // what the body said rather than on whether the row is there, because the
    // row has not been looked for yet: an edit naming a mock tool that is gone
    // is answered `not_found`, not told off about a name it never had to send.
    const wantsName = kind === "create" || "tool" in said;
    if (wantsName) {
      const problem = toolNameProblem(said.tool);
      if (problem !== undefined) return { refused: refuse(422, "unprocessable", problem) };
    }

    const wantsAnswer = kind === "create" || "answer" in said || "error" in said;
    let answer: MockAnswer | undefined;
    if (wantsAnswer) {
      const read = answerOf(said);
      if ("refusal" in read) return { refused: refuse(422, "unprocessable", read.refusal) };
      answer = read.answer;
    }

    let delay: number | undefined;
    if ("delay_ms" in said && said.delay_ms !== undefined) {
      const read = delayOf(said.delay_ms);
      if ("refusal" in read) return { refused: refuse(422, "unprocessable", read.refusal) };
      delay = read.delay;
    } else if (kind === "create") {
      delay = 0;
    }

    return {
      written: {
        toolName: wantsName ? (said.tool as string).trim() : undefined,
        answer,
        delay,
        agentIds: resolved === undefined ? undefined : resolved.ids,
      },
    };
  };

  const group: RouteGroup = {
    name: "mock-tools",
    routes: [
      {
        method: "GET",
        path: "/api/mock-tools",
        handle: (request) =>
          behindAKey(request, () => {
            const outsider = projectNamed(given(request.url.searchParams.get("project")));
            if (outsider !== null) return outsider;

            const cursor = given(request.url.searchParams.get("cursor"));
            if (cursor !== undefined && !isId("mck", cursor)) {
              return refuse(
                400,
                "invalid_request",
                `"${cursor}" is not a cursor this list issued. Send the next_cursor ` +
                  `an earlier page answered with, or leave it out to start at the ` +
                  `newest mock tool.`,
              );
            }

            const newestFirst = [...mockTools].reverse();
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
                next_cursor: more ? (page.at(-1)?.id ?? null) : null,
              },
            };
          }),
      },
      {
        method: "POST",
        path: "/api/mock-tools",
        handle: (request) =>
          behindAKey(request, () => {
            const read = readWrite(request.body, "create");
            if ("refused" in read) return read.refused;
            const written = read.written;

            const toolName = written.toolName as string;
            const taken = byTool(toolName);
            if (taken !== undefined) {
              return refuse(409, "conflict", takenBy(toolName, taken.id));
            }

            const one: StoredMockTool = {
              id: newId("mck"),
              toolName,
              answer: written.answer as MockAnswer,
              delayMilliseconds: written.delay ?? 0,
              agentIds: written.agentIds ?? [],
              createdAt: new Date(),
              updatedAt: new Date(),
            };
            mockTools.push(one);
            return { status: 201, body: described(one) };
          }),
      },
      {
        method: "PATCH",
        path: "/api/mock-tools/:mockToolId",
        handle: (request) =>
          behindAKey(request, () => {
            const id = request.params.mockToolId ?? "";

            // Everything answerable without looking anything up is answered
            // first, so a body that could never be written is refused before it
            // can learn whether the mock tool it names is even there.
            const read = readWrite(request.body, "edit");
            if ("refused" in read) return read.refused;

            // A mock tool this key cannot see reads exactly as one that is not
            // there, because to this caller those are the same thing.
            const held = mockTools.find((one) => one.id === id);
            if (held === undefined) return refuse(404, "not_found", noSuchMockTool(id));
            const written = read.written;

            if (written.toolName !== undefined && written.toolName !== held.toolName) {
              const taken = byTool(written.toolName);
              if (taken !== undefined) {
                return refuse(409, "conflict", takenBy(written.toolName, taken.id));
              }
              held.toolName = written.toolName;
            }
            if (written.answer !== undefined) held.answer = written.answer;
            if (written.delay !== undefined) held.delayMilliseconds = written.delay;
            if (written.agentIds !== undefined) held.agentIds = written.agentIds;
            held.updatedAt = new Date();

            return { status: 200, body: described(held) };
          }),
      },
    ],
  };

  const seededFrom = (one: StoredMockTool): SeededMockTool => ({
    id: one.id,
    tool: one.toolName,
  });

  const controls: MockToolControls = {
    add(seed) {
      const one: StoredMockTool = {
        id: newId("mck"),
        toolName: seed.tool,
        answer: seed.error === undefined ? { answer: seed.answer } : { error: seed.error },
        delayMilliseconds: seed.delayMilliseconds ?? 0,
        agentIds: (() => {
          const resolved = resolveAgents(seed.agents ?? []);
          if ("refusal" in resolved) throw new Error(resolved.refusal);
          return resolved.ids;
        })(),
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      mockTools.push(one);
      return seededFrom(one);
    },
    editInDashboard(tool, changes) {
      const held = byTool(tool);
      if (held === undefined) throw new Error(`no mock tool for ${tool} was seeded`);
      if (changes.tool !== undefined) held.toolName = changes.tool;
      if (changes.error !== undefined) held.answer = { error: changes.error };
      else if ("answer" in changes) held.answer = { answer: changes.answer };
      if (changes.delayMilliseconds !== undefined) {
        held.delayMilliseconds = changes.delayMilliseconds;
      }
      if (changes.agents !== undefined) {
        const resolved = resolveAgents(changes.agents);
        if ("refusal" in resolved) throw new Error(resolved.refusal);
        held.agentIds = resolved.ids;
      }
      held.updatedAt = new Date();
      return seededFrom(held);
    },
    get mockTools() {
      return mockTools.map((one) => ({
        ...seededFrom(one),
        answer: one.answer,
        delayMilliseconds: one.delayMilliseconds,
        agents: namesOf(one.agentIds).map((named) => named.name),
      }));
    },
  };

  return { group, controls };
}
