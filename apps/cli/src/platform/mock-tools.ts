/**
 * The project's mock tools on the platform, over egma's public HTTP API.
 *
 * The list, a new one, and an edit to one. There is no version to read and none
 * to send, because **a mock tool is the one authored thing egma does not
 * version**: an edit overwrites the row it names. So the pin machinery the test
 * files carry has no counterpart here, and a nervous second push of the same
 * file is a write that changes nothing rather than a conflict.
 *
 * **Nothing here holds an opinion about what a mock tool may say.** How long a
 * delay may be, how large an answer may be, whether the two answer keys add up
 * to one branch, and which keys exist at all are egma's rules, refused at
 * egma's door in egma's own words — which this end relays whole. A second copy
 * out here would be a copy free to disagree with the one that matters, and it
 * would disagree on the day egma's changed.
 *
 * A refusal about *this mock tool* is a value rather than an exception, exactly
 * as a test turned away at the door is: it is an ordinary thing that happens to
 * somebody authoring a file, and the sentence is what they need. Everything
 * else — an instance that did not answer, a key that is not one — is thrown,
 * because nothing further up can do anything sensible with it.
 */

import type { MockToolEntry } from "../folder/mock-tools.ts";
import { PlatformUnreachableError, type Fetch } from "./device-flow.ts";
import type { SignedIn } from "./signed-in.ts";
import { PlatformRefusedError } from "./refused.ts";

/** A mock tool as the platform currently has it. */
export type PlatformMockTool = {
  readonly id: string;
  /** What a file writes, so a folder and a read are compared as written. */
  readonly entry: MockToolEntry;
};

/** What a write came back with. */
export type MockToolWriteAnswer =
  | { readonly kind: "written"; readonly mockTool: PlatformMockTool }
  /** The platform would not take it, in its own words. */
  | { readonly kind: "turned-away"; readonly reason: string };

/**
 * A string off the wire, with nothing in it a terminal would obey — the rule
 * every read of this API follows, and for the reason the test end states.
 *
 * It is applied to the names and to nothing else. **An answer is data and is
 * never printed**: it is written into a fenced JSON block, where a control
 * character comes out escaped and can move no cursor, and stripping characters
 * out of somebody's answer would be egma quietly editing the mocked world it
 * was handed — and would leave the folder saying something the platform does
 * not, for every push after this one.
 */
function text(value: unknown): string {
  return typeof value === "string" ? value.replaceAll(/[\p{Cc}\p{Cf}]/gu, "").trim() : "";
}

/** The agents a mock tool is scoped to, by name — the shape a file writes. */
function agentNames(value: unknown): readonly string[] {
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
 * What one answered mock tool says, in the shape a file writes it.
 *
 * The two branches are two keys and never one nullable field, because `null` is
 * a perfectly good thing for a tool to answer and a shape that could not tell
 * it from "no answer" would make an authored `null` unreadable.
 *
 * A delay of none and a scope of everybody are left out rather than written as
 * `0` and `[]`: they are what a mock tool says by saying nothing, and writing
 * them would put two lines of noise on every entry a folder holds.
 */
export function saysFrom(
  body: Record<string, unknown>,
  options: { readonly withAgents: boolean },
): Readonly<Record<string, unknown>> {
  const delay = typeof body.delay_ms === "number" ? body.delay_ms : 0;
  const agents = options.withAgents ? agentNames(body.agents) : [];
  return {
    ...("error" in body ? { error: body.error } : { answer: body.answer }),
    ...(delay === 0 ? {} : { delay_ms: delay }),
    ...(agents.length === 0 ? {} : { agents: [...agents] }),
  };
}

/**
 * One override as a test's own file writes it. **No `agents`** — an override
 * applies to the test that holds it and scopes nothing.
 */
export function overrideFrom(body: Record<string, unknown>): MockToolEntry {
  return { tool: text(body.tool), says: saysFrom(body, { withAgents: false }) };
}

function mockToolFrom(body: Record<string, unknown>): PlatformMockTool {
  return {
    id: text(body.id),
    entry: { tool: text(body.tool), says: saysFrom(body, { withAgents: true }) },
  };
}

/** What a file sends: the heading's tool, and everything the block said. */
function writeBody(entry: MockToolEntry): Record<string, unknown> {
  return { ...entry.says, tool: entry.tool };
}

async function bodyOf(response: Response): Promise<Record<string, unknown>> {
  return (await response.json().catch(() => ({}))) as Record<string, unknown>;
}

/** What the platform said about a refusal, or egma's own words for a silence. */
function saidBy(body: Record<string, unknown>, status: number): string {
  const message = text(body.message).trim();
  return message === "" ? `egma answered ${status} and said nothing about it` : message;
}

type Call = {
  readonly signedIn: SignedIn;
  readonly path: string;
  readonly method?: string;
  readonly body?: unknown;
  readonly fetchImpl?: Fetch;
};

async function ask(call: Call): Promise<{ response: Response; body: Record<string, unknown> }> {
  const fetchImpl = call.fetchImpl ?? fetch;

  let response: Response;
  try {
    response = await fetchImpl(`${call.signedIn.url}${call.path}`, {
      method: call.method ?? "GET",
      headers: {
        authorization: `Bearer ${call.signedIn.key}`,
        ...(call.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(call.body === undefined ? {} : { body: JSON.stringify(call.body) }),
    });
  } catch (cause) {
    throw new PlatformUnreachableError(call.signedIn.url, cause);
  }

  return { response, body: await bodyOf(response) };
}

/**
 * Whether an answer is about this mock tool or about this egma.
 *
 * Four statuses are the platform saying something about what was written — the
 * body held a key egma has no room for, the mock tool is gone, another one
 * already answers for the tool, or a rule about the content was broken — and
 * all four are handed back for the author to read. A 401 or a 403 is about the
 * credential rather than the file, so it is thrown and the whole verb stops.
 */
function turnedAway(
  status: number,
  body: Record<string, unknown>,
): MockToolWriteAnswer | null {
  if (status === 400 || status === 404 || status === 409 || status === 422) {
    return { kind: "turned-away", reason: saidBy(body, status) };
  }
  return null;
}

/**
 * Every mock tool this project answers with, following every page.
 *
 * `{ items, next_cursor }` is the envelope every list in this API answers, and
 * the page is read out of `items` whatever the list is of.
 */
export async function listMockTools(
  signedIn: SignedIn,
  fetchImpl?: Fetch,
): Promise<readonly PlatformMockTool[]> {
  const found: PlatformMockTool[] = [];
  let cursor: string | null = null;

  for (;;) {
    const at: string =
      cursor === null
        ? "/api/mock-tools"
        : `/api/mock-tools?cursor=${encodeURIComponent(cursor)}`;
    const { response, body } = await ask({
      signedIn,
      path: at,
      ...(fetchImpl === undefined ? {} : { fetchImpl }),
    });
    if (!response.ok) throw new PlatformRefusedError(response.status, saidBy(body, response.status));

    for (const entry of Array.isArray(body.items) ? body.items : []) {
      if (typeof entry === "object" && entry !== null) {
        found.push(mockToolFrom(entry as Record<string, unknown>));
      }
    }

    const next = text(body.next_cursor);
    if (next === "") return found;
    cursor = next;
  }
}

export async function createMockTool(
  signedIn: SignedIn,
  entry: MockToolEntry,
  fetchImpl?: Fetch,
): Promise<MockToolWriteAnswer> {
  const { response, body } = await ask({
    signedIn,
    path: "/api/mock-tools",
    method: "POST",
    body: writeBody(entry),
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
  });

  const refused = turnedAway(response.status, body);
  if (refused !== null) return refused;
  if (!response.ok) throw new PlatformRefusedError(response.status, saidBy(body, response.status));
  return { kind: "written", mockTool: mockToolFrom(body) };
}

/**
 * Edit one, which overwrites it.
 *
 * No version is named and none is asked for. **What the body leaves out, the
 * mock tool keeps** — so what the file leaves out is sent as the nothing it
 * means, rather than left out and quietly kept. A file that no longer says
 * `delay_ms` is a mock tool with no delay, and a file that no longer names
 * `agents` is one that applies to every agent; sending neither would leave the
 * folder saying one thing and egma answering another, for every push after this
 * one.
 *
 * The answer is the one field with no such nothing to send: a mock tool always
 * answers with something, so a block that says neither branch leaves the answer
 * as it stands and the file is written back with it.
 */
export async function editMockTool(
  signedIn: SignedIn,
  mockToolId: string,
  entry: MockToolEntry,
  fetchImpl?: Fetch,
): Promise<MockToolWriteAnswer> {
  const { response, body } = await ask({
    signedIn,
    path: `/api/mock-tools/${encodeURIComponent(mockToolId)}`,
    method: "PATCH",
    body: { delay_ms: 0, agents: [], ...writeBody(entry) },
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
  });

  const refused = turnedAway(response.status, body);
  if (refused !== null) return refused;
  if (!response.ok) throw new PlatformRefusedError(response.status, saidBy(body, response.status));
  return { kind: "written", mockTool: mockToolFrom(body) };
}
