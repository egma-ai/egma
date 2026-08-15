/**
 * The fixture platform, held against the shipped API's own words.
 *
 * The CLI's whole suite runs offline against a fixture, permanently, so that an
 * outside contributor needs no database and no account to work on it. That is
 * only worth having while the fixture is not kinder than the real thing: a
 * fixture that answered a friendlier sentence, a rounder shape or a softer
 * status code would hide exactly the bugs the suite exists to catch, and it
 * would hide them everywhere at once.
 *
 * So this file is the pin. Every assertion here is the same assertion the API's
 * own route tests make — the same request, the same expected body, word for
 * word — aimed at the fixture instead. When the API's wording improves
 * deliberately, this fails, and the fixture is brought along in the same
 * change. When it changes by accident, this fails too, which is the point.
 *
 * Refusal wording is contract: a client relays these sentences to a terminal a
 * coding agent is reading, and it decides what to do next from them. So they
 * are asserted whole rather than by substring, here as there.
 *
 * What is not pinned here is what the CLI never reaches offline — roles and
 * viewers, second projects, deleted personas, cancelling a run. The fixture
 * serves one key acting in one project, and a route nothing calls is a route
 * nobody should be writing.
 */

import {
  LARGEST_MOCK_TOOL_ANSWER_BYTES,
  LONGEST_MOCK_TOOL_DELAY_MILLISECONDS,
} from "@egma/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { REFUSALS } from "../../api/src/http/refusals.ts";
import { agentNotApplicable } from "../src/sync/refusals.ts";
import { startPlatform, type Platform } from "./support/fixture-platform/index.ts";

let platform: Platform;
let key: string;

beforeEach(async () => {
  platform = await startPlatform();
  key = platform.device.mint();
});

afterEach(async () => {
  await platform.close();
});

type Answer = { readonly status: number; readonly body: Record<string, unknown> };

async function ask(
  method: "GET" | "POST" | "PATCH",
  path: string,
  payload?: Record<string, unknown>,
): Promise<Answer> {
  const response = await fetch(`${platform.url}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${key}`,
      ...(payload === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

const RESCHEDULING = {
  name: "Reschedules a booked appointment",
  scenario:
    "Their cleaning is booked for Thursday morning and has to move to any afternoon next week.",
  expected_behaviors: [
    "verifies who it is speaking to before discussing the booking",
    "confirms the new time back before finishing",
  ],
} as const;

/** The registration a developer's connect sends. */
function registration(
  overrides: {
    readonly name?: string;
    readonly modality?: string;
    readonly retellAgentId?: string;
    readonly apiKey?: string;
    readonly connectionName?: string;
  } = {},
): Record<string, unknown> {
  return {
    name: overrides.name ?? "Front desk",
    connection: {
      ...(overrides.connectionName === undefined ? {} : { name: overrides.connectionName }),
      type: "retell",
      modality: overrides.modality ?? "chat",
      config: { retellAgentId: overrides.retellAgentId ?? "agent_in_retell_1" },
      credentials: { apiKey: overrides.apiKey ?? "retell-secret-A1B2C3D4WXYZ" },
    },
  };
}

/** An otherwise valid retell connection, spoiled one field at a time. */
function connectionPayload(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: "retell",
    modality: "voice",
    config: { retellAgentId: "agent_in_retell_2" },
    credentials: { apiKey: "retell-secret-B2C3D4E5WXYZ" },
    ...overrides,
  };
}

function agentOf(answer: Answer): Record<string, unknown> {
  return answer.body.agent as Record<string, unknown>;
}

function connectionOf(answer: Answer): Record<string, unknown> {
  return answer.body.connection as Record<string, unknown>;
}

/**
 * The one sentence both ends of the repository seam say.
 *
 * `push` preflights the whole folder against the tests its bound agent still
 * has, so the ordinary path never sends the request — the client says this
 * sentence itself. The platform's door says it in the race after that check.
 * Two wordings for one fact would teach a client to read neither, so they are
 * held to each other here rather than kept in step by hand.
 */
describe("the repository refusal both ends make", () => {
  it("is one wording, in the client and at the door", () => {
    expect(agentNotApplicable("tst_one", "agt_two")).toBe(
      REFUSALS.repositoryAgentNotApplicable("tst_one", "agt_two"),
    );
  });
});

describe("creating a test", () => {
  it("answers the whole test, with the version a file will pin", async () => {
    const created = await ask("POST", "/api/tests", { ...RESCHEDULING });

    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body).toMatchObject({
      name: RESCHEDULING.name,
      version: 1,
      scenario: RESCHEDULING.scenario,
      // A body may send bare text, and what comes back is never bare: each
      // statement with the priority it carries, and text sent bare is a P0.
      expected_behaviors: RESCHEDULING.expected_behaviors.map((behavior) => ({
        behavior,
        priority: "P0",
      })),
    });
    expect(String(created.body.id)).toMatch(/^tst_/u);
    expect(String(created.body.version_id)).toMatch(/^tstv_/u);
    expect(String(created.body.revision)).toMatch(/^rev_/u);
    expect(created.body.created_at).toBeTypeOf("string");
  });

  it("takes the project's default persona when the file names nobody", async () => {
    const named = await ask("POST", "/api/tests", { ...RESCHEDULING, personas: [] });
    const absent = await ask("POST", "/api/tests", { ...RESCHEDULING, name: "Another" });

    for (const created of [named, absent]) {
      expect(created.status).toBe(201);
      expect(created.body.personas).toEqual([
        { id: expect.any(String), name: expect.any(String), archived_at: null },
      ]);
    }
  });

  it("resolves personas by name, in the order the file named them", async () => {
    const omar = platform.tests.addPersona("Omar");
    const rita = platform.tests.addPersona("Impatient Rita");

    const created = await ask("POST", "/api/tests", {
      ...RESCHEDULING,
      personas: ["Impatient Rita", "Omar"],
    });

    expect(created.status).toBe(201);
    expect(created.body.personas).toEqual([
      { id: rita, name: "Impatient Rita", archived_at: null },
      { id: omar, name: "Omar", archived_at: null },
    ]);
  });

  it("resolves an identifier too, so a client holding one needs no name", async () => {
    const omar = platform.tests.addPersona("Omar");

    const created = await ask("POST", "/api/tests", { ...RESCHEDULING, personas: [omar] });

    expect(created.status).toBe(201);
    expect(created.body.personas).toEqual([
      { id: omar, name: "Omar", archived_at: null },
    ]);
  });

  it("refuses a persona nobody in this project answers to", async () => {
    const refused = await ask("POST", "/api/tests", {
      ...RESCHEDULING,
      personas: ["Impatient Rita"],
    });

    expect(refused.status).toBe(422);
    expect(refused.body).toEqual({
      error: "unprocessable",
      message:
        'egma has no persona called "Impatient Rita" in this project. Name a persona this project already has, or name none and egma takes the project\'s default.',
    });
    expect(platform.tests.tests).toEqual([]);
  });

  it("refuses one persona named twice, because that asks for one simulation twice", async () => {
    platform.tests.addPersona("Omar");

    const refused = await ask("POST", "/api/tests", {
      ...RESCHEDULING,
      personas: ["Omar", "Omar"],
    });

    expect(refused.status).toBe(422);
    expect(refused.body).toEqual({
      error: "unprocessable",
      message: 'persona "Omar" is named twice on one test; name each persona once',
    });
  });

  it("refuses personas sent as anything but text, rather than quietly dropping them", async () => {
    const structured = await ask("POST", "/api/tests", {
      ...RESCHEDULING,
      personas: [{ name: "Omar" }],
    });

    expect(structured.status).toBe(422);
    expect(structured.body).toEqual({
      error: "unprocessable",
      message:
        "a test names each persona as text — their name, or their prs_ " +
        'identifier — and one entry in personas is neither. Send it as a ' +
        'list of text, like ["impatient-caller"].',
    });

    const notAList = await ask("POST", "/api/tests", {
      ...RESCHEDULING,
      personas: "Omar",
    });

    expect(notAList.status).toBe(422);
    expect(notAList.body).toEqual({
      error: "unprocessable",
      message:
        "personas is the list of people who call about this test, by name. " +
        'Send it as a list of text, like ["impatient-caller"], or leave it ' +
        "out and egma takes the project's default persona.",
    });

    expect(platform.tests.tests).toEqual([]);
  });

  it("relays the factory's own sentence for a test that could never be one", async () => {
    const nameless = await ask("POST", "/api/tests", { ...RESCHEDULING, name: "" });
    expect(nameless.status).toBe(422);
    expect(nameless.body).toEqual({
      error: "unprocessable",
      message: "a test needs a name",
    });

    const situationless = await ask("POST", "/api/tests", { ...RESCHEDULING, scenario: "" });
    expect(situationless.status).toBe(422);
    expect(situationless.body).toEqual({
      error: "unprocessable",
      message: "a test needs a scenario: the situation the agent is put in",
    });

    const unfalsifiable = await ask("POST", "/api/tests", {
      ...RESCHEDULING,
      expected_behaviors: [],
    });
    expect(unfalsifiable.status).toBe(422);
    expect(unfalsifiable.body).toEqual({
      error: "unprocessable",
      message:
        "a test needs at least one expected behavior, because a test that cannot fail is not a test",
    });

    const empty = await ask("POST", "/api/tests", {
      ...RESCHEDULING,
      expected_behaviors: ["  "],
    });
    expect(empty.status).toBe(422);
    expect(empty.body).toEqual({
      error: "unprocessable",
      message: "an expected behavior needs to say something",
    });
  });
});

/**
 * The mock tool group, held against the shipped API's own words.
 *
 * These are the refusals a developer meets by authoring a file, so they are the
 * ones the folder's verbs relay to a terminal — which makes their wording
 * contract, and makes a fixture that softened any of them a fixture that would
 * let the client ship against sentences the real thing never says.
 *
 * The two ceilings are read from the platform's own constants here as they are
 * in the fixture: a number written down twice is a number that goes on being
 * enforced in one place after it moved in the other.
 */
describe("a mock tool the folder authors", () => {
  const CALENDAR = { tool: "check_availability", answer: { slots: [] } } as const;

  it("answers the whole mock tool, with no version anywhere on it", async () => {
    const created = await ask("POST", "/api/mock-tools", { ...CALENDAR });

    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body).toMatchObject({
      tool: "check_availability",
      answer: { slots: [] },
      delay_ms: 0,
      agents: [],
    });
    expect(String(created.body.id)).toMatch(/^mck_/u);
    // The one authored thing egma does not version: there is no version to
    // read, so a client cannot grow a pin it would then have to keep in step.
    expect(created.body).not.toHaveProperty("version");
    expect(created.body).not.toHaveProperty("version_id");
    expect(created.body).not.toHaveProperty("project_id");
  });

  it("keeps an answer of null tellable from no answer at all", async () => {
    const created = await ask("POST", "/api/mock-tools", {
      tool: "last_visit",
      answer: null,
    });

    expect(created.status).toBe(201);
    expect(created.body).toHaveProperty("answer", null);
    expect(created.body).not.toHaveProperty("error");
  });

  it("relays the factory's own sentence for an answer it cannot serve", async () => {
    const blank = await ask("POST", "/api/mock-tools", { ...CALENDAR, tool: "   " });
    expect(blank.status).toBe(422);
    expect(blank.body).toEqual({
      error: "unprocessable",
      message:
        "tool is the name of the agent's tool this mock tool answers for, " +
        "and this one is blank. Send the tool's name exactly as the agent " +
        "registers it.",
    });

    const both = await ask("POST", "/api/mock-tools", {
      ...CALENDAR,
      error: "unavailable",
    });
    expect(both.status).toBe(422);
    expect(both.body).toEqual({
      error: "unprocessable",
      message:
        "a mock tool answers with one thing: this one sent both answer and " +
        "error. Send whichever branch the test needs.",
    });

    const neither = await ask("POST", "/api/mock-tools", { tool: "check_availability" });
    expect(neither.status).toBe(422);
    expect(neither.body).toEqual({
      error: "unprocessable",
      message:
        "a mock tool answers with something: send answer with what the tool " +
        "returns, or error with the failure it raises. This one sent neither.",
    });
  });

  it("names the ceiling a delay went past, with the arithmetic the fix needs", async () => {
    const tooLong = LONGEST_MOCK_TOOL_DELAY_MILLISECONDS + 1;

    const refused = await ask("POST", "/api/mock-tools", {
      ...CALENDAR,
      delay_ms: tooLong,
    });

    expect(refused.status).toBe(422);
    expect(refused.body).toEqual({
      error: "unprocessable",
      message:
        `delay_ms is ${tooLong}, and a mock tool may delay its answer by at ` +
        `most ${LONGEST_MOCK_TOOL_DELAY_MILLISECONDS} milliseconds — the ` +
        `budget the exchange carrying it is given. Send a smaller delay_ms.`,
    });
  });

  it("names the size an answer went past, counted the way the exchange counts", async () => {
    const enormous = "x".repeat(LARGEST_MOCK_TOOL_ANSWER_BYTES);

    const refused = await ask("POST", "/api/mock-tools", {
      tool: "read_document",
      answer: { body: enormous },
    });

    expect(refused.status).toBe(422);
    expect(refused.body).toEqual({
      error: "unprocessable",
      message:
        // `{"answer":{"body":"…"}}` — the value's own eleven bytes of shape
        // plus the eleven the tag adds, which is what the wire carries and so
        // what the cap is counted against.
        `answer is ${enormous.length + 22} bytes once serialized and tagged ` +
        `for the wire, and the exchange that carries it holds at most ` +
        `${LARGEST_MOCK_TOOL_ANSWER_BYTES}. An answer that needs more than ` +
        `that is a document rather than a tool answer.`,
    });
  });

  it("refuses a key it has no place for, by name", async () => {
    const refused = await ask("POST", "/api/mock-tools", {
      ...CALENDAR,
      matches: { city: "Berlin" },
    });

    expect(refused.status).toBe(400);
    expect(refused.body).toEqual({
      error: "invalid_request",
      message:
        'a mock tool has no key "matches"; it holds tool, answer, error, ' +
        "delay_ms, agents, project",
    });
  });

  it("refuses a second answer for a tool this project already answers for", async () => {
    const first = await ask("POST", "/api/mock-tools", { ...CALENDAR });
    expect(first.status).toBe(201);

    const refused = await ask("POST", "/api/mock-tools", {
      tool: CALENDAR.tool,
      error: "the calendar is unreachable",
    });

    expect(refused.status).toBe(409);
    expect(refused.body).toEqual({
      error: "conflict",
      message:
        `this project already answers for "${CALENDAR.tool}", with mock tool ` +
        `${String(first.body.id)}. One answer per tool: edit that one, or ` +
        `override it on the test that needs a different branch.`,
    });
  });

  it("overwrites on an edit, minting nothing and asking for no version", async () => {
    const created = await ask("POST", "/api/mock-tools", { ...CALENDAR });
    const id = String(created.body.id);

    const edited = await ask("PATCH", `/api/mock-tools/${id}`, {
      error: "the calendar is unreachable",
      delay_ms: 250,
    });

    expect(edited.status).toBe(200);
    expect(edited.body).toMatchObject({
      id,
      tool: "check_availability",
      error: "the calendar is unreachable",
      delay_ms: 250,
    });
    // The branch it left behind is gone rather than kept beside the new one.
    expect(edited.body).not.toHaveProperty("answer");
  });

  it("says the same thing about a mock tool that is not there and one that is not yours", async () => {
    const theirs = "mck_01JZZZZZZZZZZZZZZZZZZZZZZZ";

    const refused = await ask("PATCH", `/api/mock-tools/${theirs}`, { answer: 1 });

    expect(refused.status).toBe(404);
    expect(refused.body).toEqual({
      error: "not_found",
      message:
        `there is no mock tool ${theirs} on this egma. List the mock tools to ` +
        `see what this project answers for.`,
    });
  });

  it("answers one envelope, and refuses a cursor it never issued", async () => {
    await ask("POST", "/api/mock-tools", { ...CALENDAR });

    const listed = await ask("GET", "/api/mock-tools");
    expect(listed.status).toBe(200);
    expect(Object.keys(listed.body).sort()).toEqual(["items", "next_cursor"]);
    expect(listed.body.next_cursor).toBeNull();

    const refused = await ask("GET", "/api/mock-tools?cursor=not-a-cursor");
    expect(refused.status).toBe(400);
    expect(refused.body).toEqual({
      error: "invalid_request",
      message:
        '"not-a-cursor" is not a cursor this list issued. Send the next_cursor ' +
        "an earlier page answered with, or leave it out to start at the newest " +
        "mock tool.",
    });
  });
});

/**
 * A test's own overrides, which are content and travel with the test.
 *
 * Every gate a project's mock tool passes, an override passes — from the same
 * functions on the real side, so a fixture that checked one half and waved the
 * other through would let a client ship a folder egma refuses.
 */
describe("the mock tools a test overrides", () => {
  it("rides the test, comes back on it, and versions with it", async () => {
    const created = await ask("POST", "/api/tests", {
      ...RESCHEDULING,
      mock_tools: [{ tool: "check_availability", answer: { slots: [] }, delay_ms: 250 }],
    });

    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.mock_tools).toEqual([
      { tool: "check_availability", answer: { slots: [] }, delay_ms: 250 },
    ]);

    // Editing one is editing the test, so it mints the next version.
    const edited = await ask("PATCH", `/api/tests/${String(created.body.id)}`, {
      expected_version_id: String(created.body.version_id),
      mock_tools: [{ tool: "check_availability", error: "the calendar is unreachable" }],
    });
    expect(edited.status).toBe(200);
    expect(edited.body.version).toBe(2);
    expect(edited.body.mock_tools).toEqual([
      { tool: "check_availability", error: "the calendar is unreachable", delay_ms: 0 },
    ]);

    // And the version it left behind still says what it said.
    const before = await ask("GET", `/api/test-versions/${String(created.body.version_id)}`);
    expect(before.body.mock_tools).toEqual([
      { tool: "check_availability", answer: { slots: [] }, delay_ms: 250 },
    ]);

    // An empty list clears them; leaving the field out keeps them.
    const cleared = await ask("PATCH", `/api/tests/${String(created.body.id)}`, {
      expected_version_id: String(edited.body.version_id),
      mock_tools: [],
    });
    expect(cleared.body.mock_tools).toEqual([]);
  });

  it("refuses an override that scopes agents, because an override scopes nothing", async () => {
    const refused = await ask("POST", "/api/tests", {
      ...RESCHEDULING,
      mock_tools: [{ tool: "check_availability", answer: 1, agents: ["front-desk"] }],
    });

    expect(refused.status).toBe(422);
    expect(refused.body).toEqual({
      error: "unprocessable",
      message:
        'a mock tool a test overrides has no key "agents"; it holds tool, ' +
        "answer, error, delay_ms",
    });
    expect(platform.tests.tests).toEqual([]);
  });

  it("holds an override to every gate a project's own mock tool passes", async () => {
    const tooLong = LONGEST_MOCK_TOOL_DELAY_MILLISECONDS + 1;
    const refused = await ask("POST", "/api/tests", {
      ...RESCHEDULING,
      mock_tools: [{ tool: "check_availability", answer: 1, delay_ms: tooLong }],
    });

    expect(refused.status).toBe(422);
    expect(refused.body).toEqual({
      error: "unprocessable",
      message:
        `delay_ms is ${tooLong}, and a mock tool may delay its answer by at ` +
        `most ${LONGEST_MOCK_TOOL_DELAY_MILLISECONDS} milliseconds — the ` +
        `budget the exchange carrying it is given. Send a smaller delay_ms.`,
    });

    const twice = await ask("POST", "/api/tests", {
      ...RESCHEDULING,
      mock_tools: [
        { tool: "check_availability", answer: 1 },
        { tool: "check_availability", answer: 2 },
      ],
    });
    expect(twice.status).toBe(422);
    expect(twice.body).toEqual({
      error: "unprocessable",
      message: 'this test overrides "check_availability" twice; override each tool once',
    });

    const notAList = await ask("POST", "/api/tests", {
      ...RESCHEDULING,
      mock_tools: { tool: "check_availability" },
    });
    expect(notAList.status).toBe(422);
    expect(notAList.body).toEqual({
      error: "unprocessable",
      message:
        "mock_tools is the list of tools this test answers for itself. Send " +
        'it as a list of objects, like [{"tool": "check_availability", ' +
        '"answer": {"slots": []}}], or leave it out and the project\'s mock ' +
        "tools are the whole world.",
    });

    expect(platform.tests.tests).toEqual([]);
  });
});

describe("the door every group is behind", () => {
  /**
   * A 401 is relayed to a terminal unchanged, so its sentence is contract as
   * much as any other — and it is one sentence for the whole API rather than
   * one per route group. A fixture with a shorter one would let a client ship a
   * check against words the real thing never says.
   */
  it("answers one sentence for a key it never minted, whichever group is asked", async () => {
    const refusal = {
      error: "not_authenticated",
      message:
        "this request carried no session and no usable API key. " +
        "Sign in, or send Authorization: Bearer with an egma key.",
    };

    for (const [method, path, payload] of [
      ["GET", "/api/tests"],
      ["POST", "/api/tests", RESCHEDULING],
      ["PATCH", "/api/tests/tst_01JZZZZZZZZZZZZZZZZZZZZZZZ", RESCHEDULING],
      ["GET", "/api/test-versions/tstv_01JZZZZZZZZZZZZZZZZZZZZZZZ"],
      ["GET", "/api/agents"],
      ["POST", "/api/agents", registration()],
      ["GET", "/api/agents/agt_01JZZZZZZZZZZZZZZZZZZZZZZZ"],
      ["POST", "/api/agents/agt_01JZZZZZZZZZZZZZZZZZZZZZZZ/connections", connectionPayload()],
      ["POST", "/api/runs", { connection: "con_01JZZZZZZZZZZZZZZZZZZZZZZZ" }],
      ["GET", "/api/runs/run_01JZZZZZZZZZZZZZZZZZZZZZZZ"],
      ["GET", "/api/runs/run_01JZZZZZZZZZZZZZZZZZZZZZZZ/events"],
      ["GET", "/api/keys"],
    ] as const) {
      const response = await fetch(`${platform.url}${path}`, {
        method,
        headers: {
          authorization: "Bearer egma_sk_not-one-of-ours",
          ...(payload === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      });
      expect(response.status, `${method} ${path}`).toBe(401);
      expect(await response.json(), `${method} ${path}`).toEqual(refusal);
    }

    // Refused before anything was read, so nothing was written by any of them.
    expect(platform.tests.tests).toEqual([]);
    expect(platform.registered.agents).toHaveLength(0);
    expect(platform.running.runs).toEqual([]);
  });
});

describe("the list of tests", () => {
  /**
   * A page holds fifty, and there is no parameter to ask for fewer: a list this
   * API answers is followed by its cursor and by nothing else. So the page size
   * is what this seeds past, and it is written here because a change to it is a
   * change a client would see.
   */
  const A_PAGE = 50;

  it("answers one envelope, newest first, and pages through with its cursor", async () => {
    // Seeded through the controls rather than the route: what is under test is
    // the page and its cursor, and fifty-one requests to arrange that would be
    // fifty-one requests proving nothing.
    const written: string[] = [];
    for (let index = 1; index <= A_PAGE + 1; index += 1) {
      written.push(
        platform.tests.add({
          name: `test ${String(index).padStart(2, "0")}`,
          scenario: RESCHEDULING.scenario,
          expectedBehaviors: [...RESCHEDULING.expected_behaviors],
        }).id,
      );
    }

    const page = await ask("GET", "/api/tests");
    expect(page.status).toBe(200);
    const items = page.body.items as { id: string }[];
    expect(items).toHaveLength(A_PAGE);
    // Newest first, so the last one written is the first one read.
    expect(items[0]?.id).toBe(written.at(-1));
    expect(page.body.next_cursor).toBe(items.at(-1)?.id);

    const rest = await ask("GET", `/api/tests?cursor=${String(page.body.next_cursor)}`);
    const remaining = rest.body.items as { id: string }[];
    expect(remaining.map((test) => test.id)).toEqual([written[0]]);
    // Null rather than absent, so "no next page" is told from "an older shape".
    expect(rest.body.next_cursor).toBeNull();

    expect(new Set([...items, ...remaining].map((test) => test.id))).toEqual(new Set(written));
  });

  it("answers one envelope, whatever the list is of", async () => {
    platform.tests.add({
      name: "Reschedules",
      scenario: "They move a booking.",
      expectedBehaviors: ["confirms the new time"],
    });

    const listed = await ask("GET", "/api/tests");

    expect(listed.status).toBe(200);
    expect(Object.keys(listed.body).sort()).toEqual(["items", "next_cursor"]);
    expect((listed.body.items as unknown[]).length).toBe(1);
    // Null rather than absent, so a client can tell "there is no next page"
    // from "this answer is an older shape that never had one".
    expect(listed.body.next_cursor).toBeNull();
  });

  it("refuses a project this credential may not act in, on a read as on a write", async () => {
    const theirs = "prj_01JZZZZZZZZZZZZZZZZZZZZZZZ";
    const refusal = {
      error: "not_permitted",
      message:
        `this credential may not act in project ${theirs}. A ` +
        `credential authorized for one project acts in that one, and a key ` +
        `for the whole organization acts in any project of that organization. ` +
        `Leave project out to use the project this credential already acts in.`,
    };

    const reading = await ask("GET", `/api/tests?project=${theirs}`);
    expect(reading.status).toBe(403);
    expect(reading.body).toEqual(refusal);

    const writing = await ask("POST", "/api/tests", { ...RESCHEDULING, project: theirs });
    expect(writing.status).toBe(403);
    expect(writing.body).toEqual(refusal);
    expect(platform.tests.tests).toEqual([]);
  });

  it("refuses a cursor it never issued rather than starting again from the top", async () => {
    const refused = await ask("GET", "/api/tests?cursor=not-a-cursor");

    expect(refused.status).toBe(400);
    expect(refused.body).toEqual({
      error: "invalid_request",
      message:
        '"not-a-cursor" is not a cursor this list issued. Send the next_cursor an earlier page answered with, or leave it out to start at the newest test.',
    });
  });
});

describe("one frozen version", () => {
  it("is not found for a version this egma never issued", async () => {
    const missing = "tstv_01JZZZZZZZZZZZZZZZZZZZZZZZ";

    const refused = await ask("GET", `/api/test-versions/${missing}`);

    expect(refused.status).toBe(404);
    expect(refused.body).toEqual({
      error: "not_found",
      message: `there is no test version ${missing} on this egma. List the tests to see the version each of them stands on now.`,
    });
  });
});

describe("editing a test", () => {
  /** A test on the platform, and the version an edit would be written against. */
  async function aTest(): Promise<{ id: string; versionId: string }> {
    const created = await ask("POST", "/api/tests", { ...RESCHEDULING });
    return {
      id: String(created.body.id),
      versionId: String(created.body.version_id),
    };
  }

  it("refuses an edit that named no version it was written against", async () => {
    const test = await aTest();

    const refused = await ask("PATCH", `/api/tests/${test.id}`, {
      scenario: "Something else entirely.",
    });

    expect(refused.status).toBe(422);
    expect(refused.body).toEqual({
      error: "unprocessable",
      message:
        "an edit says which version it was written against, and this one " +
        "named no expected_version_id. Send the version_id you last read " +
        "for this test, or read the test again and send the version it " +
        "names now.",
    });
    expect(platform.tests.versionsOf(RESCHEDULING.name)).toBe(1);
  });

  it("names both versions when the test moved since the edit was written", async () => {
    const test = await aTest();
    const stale = test.versionId;
    const moved = platform.tests.editInDashboard(RESCHEDULING.name, {
      scenario: "Somebody else got here first.",
    });
    const current = moved.versionId;

    const refused = await ask("PATCH", `/api/tests/${test.id}`, {
      ...RESCHEDULING,
      scenario: "And this is what the file says.",
      expected_version_id: stale,
    });

    expect(refused.status).toBe(409);
    expect(refused.body).toEqual({
      error: "conflict",
      message:
        `this edit was written against version ${stale}, and the test has ` +
        `moved on to ${current}. Read the test again and send the edit with ` +
        `expected_version_id set to the version it names now.`,
      test: { id: test.id, name: RESCHEDULING.name },
      expected_version_id: stale,
      current_version_id: current,
    });
  });

  it("is not found for a test this credential cannot see", async () => {
    const theirs = "tst_01JZZZZZZZZZZZZZZZZZZZZZZZ";

    const refused = await ask("PATCH", `/api/tests/${theirs}`, {
      ...RESCHEDULING,
      expected_version_id: "tstv_01JZZZZZZZZZZZZZZZZZZZZZZZ",
    });

    expect(refused.status).toBe(404);
    expect(refused.body).toEqual({
      error: "not_found",
      message: `there is no test ${theirs} on this egma. List the tests to see what this project holds, or create this one instead of editing it.`,
    });
  });

  it("mints nothing for content byte-identical to what it already holds", async () => {
    const test = await aTest();

    const again = await ask("PATCH", `/api/tests/${test.id}`, {
      ...RESCHEDULING,
      expected_version_id: test.versionId,
    });

    expect(again.status).toBe(200);
    expect(again.body.version_id).toBe(test.versionId);
    expect(again.body.version).toBe(1);
    expect(platform.tests.versionsOf(RESCHEDULING.name)).toBe(1);
  });
});

describe("registering an agent", () => {
  it("writes the agent and the first way of reaching it in one request", async () => {
    const registered = await ask("POST", "/api/agents", registration());

    expect(registered.status).toBe(201);
    expect(registered.body.result).toBe("created");
    expect(agentOf(registered)).toMatchObject({
      name: "Front desk",
      description: null,
    });
    expect(String(agentOf(registered).project_id)).toMatch(/^prj_/u);
    expect(connectionOf(registered)).toMatchObject({
      agent_id: agentOf(registered).id,
      name: "retell-1",
      type: "retell",
      modality: "chat",
      // Derived from the type, never caller-supplied.
      topology: "hosted-broker",
      config: { retellAgentId: "agent_in_retell_1" },
      credentials_hint: "WXYZ",
    });
    expect(platform.registered.agents).toHaveLength(1);
    expect(platform.registered.connections).toHaveLength(1);
  });

  it("leaves no agent behind when the connection payload is refused", async () => {
    const refused = await ask("POST", "/api/agents", {
      name: "Front desk",
      connection: {
        type: "retell",
        modality: "chat",
        // One letter wrong, which is the whole point: a typo dies at the door.
        config: { retellAgentld: "agent_in_retell_1" },
        credentials: { apiKey: "retell-secret-A1B2C3D4WXYZ" },
      },
    });

    expect(refused.status).toBe(400);
    expect(refused.body).toEqual({
      error: "invalid_request",
      message:
        'a retell connection\'s config has no key "retellAgentld"; it holds retellAgentId',
    });
    expect(platform.registered.agents).toHaveLength(0);
  });

  it("claims an identity on its own when no connection is named", async () => {
    const registered = await ask("POST", "/api/agents", { name: "Front desk" });

    expect(registered.status).toBe(201);
    expect(registered.body.result).toBe("created");
    expect(registered.body).not.toHaveProperty("connection");
    expect(platform.registered.connections).toHaveLength(0);
  });

  it("refuses an agent with no name, in the factory's own words", async () => {
    const refused = await ask("POST", "/api/agents", { name: "  " });

    expect(refused.status).toBe(422);
    expect(refused.body).toEqual({
      error: "unprocessable",
      message: "an agent needs a name",
    });
  });
});

describe("a connection payload its type will not take", () => {
  it("names a type egma has never heard of", async () => {
    const refused = await ask("POST", "/api/agents", {
      name: "Front desk",
      connection: connectionPayload({ type: "vapi" }),
    });

    expect(refused.status).toBe(400);
    expect(refused.body).toEqual({
      error: "invalid_request",
      message:
        '"vapi" is not a connection type egma knows; expected one of retell, phone, livekit',
    });
    expect(platform.registered.agents).toHaveLength(0);
  });

  it("names a modality the type does not speak", async () => {
    const refused = await ask("POST", "/api/agents", {
      name: "Old line",
      connection: {
        type: "phone",
        modality: "chat",
        config: { phoneNumber: "+15551234567" },
      },
    });

    expect(refused.status).toBe(400);
    expect(refused.body).toEqual({
      error: "invalid_request",
      message: "a phone connection speaks voice, and this one was asked for chat",
    });
  });

  it("names the credentials shape when none arrived", async () => {
    const refused = await ask("POST", "/api/agents", {
      name: "Front desk",
      connection: {
        type: "retell",
        modality: "voice",
        config: { retellAgentId: "agent_in_retell_2" },
      },
    });

    expect(refused.status).toBe(400);
    expect(refused.body).toEqual({
      error: "invalid_request",
      message: "a retell connection needs credentials shaped { apiKey }",
    });
  });

  it("names the floor under a credential that arrived too short", async () => {
    const refused = await ask("POST", "/api/agents", {
      name: "Front desk",
      connection: connectionPayload({ credentials: { apiKey: "short" } }),
    });

    expect(refused.status).toBe(400);
    expect(refused.body).toEqual({
      error: "invalid_request",
      message: "a retell connection's credentials need apiKey to be at least 8 characters",
    });
  });

  it("refuses a connection sent with a blank name, in the factory's own words", async () => {
    const refused = await ask("POST", "/api/agents", {
      name: "Front desk",
      connection: connectionPayload({ name: "  " }),
    });

    expect(refused.status).toBe(422);
    expect(refused.body).toEqual({
      error: "unprocessable",
      message: "a connection needs a name",
    });
    expect(platform.registered.agents).toHaveLength(0);
  });

  it("refuses a credential where the type takes none", async () => {
    const refused = await ask("POST", "/api/agents", {
      name: "Old line",
      connection: {
        type: "phone",
        modality: "voice",
        config: { phoneNumber: "+15551234567" },
        credentials: { apiKey: "retell-secret-A1B2C3D4WXYZ" },
      },
    });

    expect(refused.status).toBe(400);
    expect(refused.body).toEqual({
      error: "invalid_request",
      message:
        "a phone connection takes no credential: the customer supplies a public number, " +
        "and egma dials it with its own telephony configuration",
    });
  });

  /**
   * A livekit connection is the one type that comes in two shapes, and the
   * fixture has to tell them apart the same way the real registry does. These
   * are the sentences a caller who mixed the two really gets, and a fixture
   * that answered anything friendlier would hide the mix from whoever is
   * working on the client offline.
   */
  it("refuses a key pair sent alongside a token endpoint", async () => {
    const refused = await ask("POST", "/api/agents", {
      name: "Production agent",
      connection: {
        type: "livekit",
        modality: "voice",
        config: {
          url: "wss://acme.livekit.cloud",
          tokenEndpoint: "https://acme.example/egma/livekit-token",
        },
        credentials: {
          apiKey: "APIsomethingWXYZ",
          apiSecret: "livekit-secret-E5F6G7H8",
        },
      },
    });

    expect(refused.status).toBe(400);
    expect(refused.body).toEqual({
      error: "invalid_request",
      message:
        "a livekit connection whose config names a tokenEndpoint asks that " +
        "endpoint for every token, so it holds no key pair of its own: its " +
        "credentials are the endpoint's auth headers, shaped { headers }. " +
        "Send those, or drop the tokenEndpoint and egma will mint its own " +
        "tokens from an apiKey and apiSecret.",
    });
  });

  it("names both ways in when a livekit connection carries neither", async () => {
    const refused = await ask("POST", "/api/agents", {
      name: "Quickstart agent",
      connection: {
        type: "livekit",
        modality: "voice",
        config: { url: "wss://acme.livekit.cloud" },
      },
    });

    expect(refused.status).toBe(400);
    expect(refused.body).toEqual({
      error: "invalid_request",
      message:
        "a livekit connection mints its own tokens, so it needs the " +
        "project's apiKey and apiSecret. Send the pair, or name a " +
        "tokenEndpoint in the config and egma will ask that endpoint for a " +
        "token instead — which is the shape where the project's secret " +
        "never leaves the customer.",
    });
  });

  it("refuses an agent to dispatch on a connection that cannot dispatch", async () => {
    const refused = await ask("POST", "/api/agents", {
      name: "Production agent",
      connection: {
        type: "livekit",
        modality: "voice",
        config: {
          url: "wss://acme.livekit.cloud",
          tokenEndpoint: "https://acme.example/egma/livekit-token",
          agentName: "front-desk",
        },
        credentials: { headers: '{"Authorization":"Bearer not-real"}' },
      },
    });

    expect(refused.status).toBe(400);
    expect(refused.body).toEqual({
      error: "invalid_request",
      message:
        'a token-endpoint livekit connection\'s config has no key "agentName"; ' +
        "it holds url, tokenEndpoint",
    });
  });
});

describe("a livekit connection that asks an endpoint for its tokens", () => {
  it("lands, and reads back hinted by the header's name and never its value", async () => {
    const registered = await ask("POST", "/api/agents", {
      name: "Production agent",
      connection: {
        type: "livekit",
        modality: "voice",
        config: {
          url: "wss://acme.livekit.cloud",
          tokenEndpoint: "https://acme.example/egma/livekit-token",
        },
        credentials: {
          headers: '{"Authorization":"Bearer a-long-random-secret"}',
        },
      },
    });

    expect(registered.status, JSON.stringify(registered.body)).toBe(201);
    expect(connectionOf(registered)).toMatchObject({
      type: "livekit",
      modality: "voice",
      topology: "agent-dials-out",
      config: {
        url: "wss://acme.livekit.cloud",
        tokenEndpoint: "https://acme.example/egma/livekit-token",
      },
      credentials_hint: "Authorization",
    });
    expect(connectionOf(registered)).not.toHaveProperty("credentials");
    expect(JSON.stringify(registered.body)).not.toContain("a-long-random-secret");
  });
});

describe("registering the same vendor agent again", () => {
  it("answers what is already there, with the credential rotated whole", async () => {
    const first = await ask(
      "POST",
      "/api/agents",
      registration({ apiKey: "retell-secret-first-0000AAAA" }),
    );
    expect(first.body.result).toBe("created");

    const again = await ask(
      "POST",
      "/api/agents",
      registration({ apiKey: "retell-secret-second-1111ZZZZ" }),
    );

    expect(again.status).toBe(200);
    expect(again.body.result).toBe("reused");
    expect(agentOf(again).id).toBe(agentOf(first).id);
    expect(connectionOf(again).id).toBe(connectionOf(first).id);

    // The hint is the whole of what a read can see, so it is the whole of what
    // can show that the newly supplied key is the one now stored.
    expect(connectionOf(first).credentials_hint).toBe("AAAA");
    expect(connectionOf(again).credentials_hint).toBe("ZZZZ");

    expect(platform.registered.agents).toHaveLength(1);
    expect(platform.registered.connections).toHaveLength(1);
  });

  it("adds a second way of reaching the same agent when the modality changed", async () => {
    const chat = await ask("POST", "/api/agents", registration());
    const voice = await ask("POST", "/api/agents", registration({ modality: "voice" }));

    expect(voice.status).toBe(201);
    expect(voice.body.result).toBe("connection_added");
    expect(agentOf(voice).id).toBe(agentOf(chat).id);
    expect(connectionOf(voice).id).not.toBe(connectionOf(chat).id);
    expect(connectionOf(voice)).toMatchObject({ name: "retell-2", modality: "voice" });

    const one = await ask("GET", `/api/agents/${String(agentOf(chat).id)}`);
    expect((one.body.connections as { name: string }[]).map((held) => held.name)).toEqual([
      "retell-1",
      "retell-2",
    ]);
    expect(platform.registered.agents).toHaveLength(1);
  });

  /**
   * A registration that would be a reuse is held to exactly what a registration
   * that would be a create is held to.
   *
   * The whole payload is checked before anything looks at what is already
   * there — that is what the platform does, and it is the only order that is
   * safe. The other way round, a body egma would refuse outright from a new
   * customer would rotate a live credential for an existing one, and the same
   * client would work on one machine and fail on the next.
   */
  it("checks the whole payload before it decides this is a reuse", async () => {
    const first = await ask(
      "POST",
      "/api/agents",
      registration({ apiKey: "retell-secret-first-0000AAAA" }),
    );
    expect(first.body.result).toBe("created");

    // Each of these would be a reuse if it were accepted: same project, same
    // type, same vendor agent, same modality.
    const refusals = [
      [
        { ...registration(), name: "  " },
        422,
        { error: "unprocessable", message: "an agent needs a name" },
      ],
      [
        registration({ connectionName: "  " }),
        422,
        { error: "unprocessable", message: "a connection needs a name" },
      ],
      [
        registration({ modality: "telepathy" }),
        400,
        {
          error: "invalid_request",
          message:
            "a retell connection speaks chat or voice, and this one was asked for telepathy",
        },
      ],
    ] as const;

    for (const [body, status, refusal] of refusals) {
      const refused = await ask("POST", "/api/agents", body as Record<string, unknown>);
      expect(refused.status, JSON.stringify(refusal)).toBe(status);
      expect(refused.body).toEqual(refusal);
    }

    // And nothing rotated: the key the first registration sealed is still the
    // one stored, because none of those bodies ever reached the reuse rule.
    const one = await ask("GET", `/api/agents/${String(agentOf(first).id)}`);
    const held = one.body.connections as Record<string, unknown>[];
    expect(held).toHaveLength(1);
    expect(held[0]?.credentials_hint).toBe("AAAA");
    expect(platform.registered.sealed).toEqual(["retell-secret-first-0000AAAA"]);
  });

  it("reads the envelopes before the project, and the project before the payload", async () => {
    // The connection's unknown key is answered before the agent's blank name,
    // because the route reads both envelopes before the factory reads anything.
    const envelopeFirst = await ask("POST", "/api/agents", {
      name: "  ",
      connection: connectionPayload({ topology: "hosted-broker" }),
    });
    expect(envelopeFirst.status).toBe(400);
    expect(envelopeFirst.body).toEqual({
      error: "invalid_request",
      message:
        'a connection has no key "topology"; it holds name, type, modality, environment, config, credentials',
    });

    // And the agent's name is answered before anything the registry checks,
    // because a name is answerable without knowing what a retell connection is.
    const nameBeforePayload = await ask("POST", "/api/agents", {
      name: "  ",
      connection: connectionPayload({ type: "vapi" }),
    });
    expect(nameBeforePayload.status).toBe(422);
    expect(nameBeforePayload.body).toEqual({
      error: "unprocessable",
      message: "an agent needs a name",
    });
  });

  it("creates twice for a different vendor agent, which is a different agent", async () => {
    await ask("POST", "/api/agents", registration());
    const other = await ask(
      "POST",
      "/api/agents",
      registration({ name: "Back office", retellAgentId: "agent_in_retell_9" }),
    );

    expect(other.status).toBe(201);
    expect(other.body.result).toBe("created");
    expect(platform.registered.agents).toHaveLength(2);
  });
});

describe("the vendor payload egma no longer keeps", () => {
  it("is refused as an unknown key on a registration, loudly rather than ignored", async () => {
    const refused = await ask("POST", "/api/agents", {
      ...registration(),
      pulled: {
        vendor: "retell",
        documents: [{ of: "prompt", body: "you are a receptionist" }],
        prompt: "you are a receptionist",
        voice: null,
        tools: [],
      },
    });

    expect(refused.status).toBe(400);
    expect(refused.body).toEqual({
      error: "invalid_request",
      message:
        "egma no longer keeps what was pulled from the provider, so a " +
        'registration has no "pulled" key. Drop it and send name, ' +
        "description, project, connection; the agent's content stays at the " +
        "provider, where egma reads it fresh rather than out of a copy that " +
        "would go stale.",
    });
    expect(platform.registered.agents).toHaveLength(0);
  });

  it("names the object it was actually sent on, with that object's own keys", async () => {
    const refused = await ask("POST", "/api/agents", {
      name: "Front desk",
      connection: connectionPayload({ pulled: { vendor: "retell" } }),
    });

    expect(refused.status).toBe(400);
    expect(refused.body).toEqual({
      error: "invalid_request",
      message:
        "egma no longer keeps what was pulled from the provider, so a " +
        'connection has no "pulled" key. Drop it and send name, type, ' +
        "modality, environment, config, credentials; the agent's content " +
        "stays at the provider, where egma reads it fresh rather than out of " +
        "a copy that would go stale.",
    });
  });

  it("names any other unknown key the same way", async () => {
    const onTheRegistration = await ask("POST", "/api/agents", {
      ...registration(),
      organization: "org_whatever",
    });

    expect(onTheRegistration.status).toBe(400);
    expect(onTheRegistration.body).toEqual({
      error: "invalid_request",
      message:
        'a registration has no key "organization"; it holds name, description, project, connection',
    });

    // Topology is derived from the type, so a supplied one is the unknown key
    // it is rather than a preference egma weighs up.
    const onTheConnection = await ask("POST", "/api/agents", {
      name: "Front desk",
      connection: connectionPayload({ topology: "hosted-broker" }),
    });

    expect(onTheConnection.status).toBe(400);
    expect(onTheConnection.body).toEqual({
      error: "invalid_request",
      message:
        'a connection has no key "topology"; it holds name, type, modality, environment, config, credentials',
    });
  });
});

describe("names, and reading an agent back", () => {
  it("refuses a connection name a living one on that agent already holds", async () => {
    const registered = await ask("POST", "/api/agents", registration());
    const agentId = String(agentOf(registered).id);

    const clash = await ask("POST", `/api/agents/${agentId}/connections`, {
      ...connectionPayload(),
      name: "retell-1",
    });

    expect(clash.status).toBe(409);
    expect(clash.body).toEqual({
      error: "name_taken",
      message: 'a connection named "retell-1" already exists on this agent',
    });
  });

  it("refuses an agent name a living agent in the project already holds", async () => {
    await ask("POST", "/api/agents", registration());

    const clash = await ask("POST", "/api/agents", {
      name: "Front desk",
      connection: connectionPayload({ config: { retellAgentId: "agent_in_retell_other" } }),
    });

    expect(clash.status).toBe(409);
    expect(clash.body).toEqual({
      error: "name_taken",
      message: 'an agent named "Front desk" already exists in this project',
    });
  });

  it("says the same thing about an agent that is not there and one that is not yours", async () => {
    const refusal = {
      error: "not_found",
      message:
        "no agent of yours has that id. Check the id, or list your agents with GET /api/agents.",
    };

    const reading = await ask("GET", "/api/agents/agt_01JZZZZZZZZZZZZZZZZZZZZZZZ");
    expect(reading.status).toBe(404);
    expect(reading.body).toEqual(refusal);

    const attaching = await ask(
      "POST",
      "/api/agents/agt_01JZZZZZZZZZZZZZZZZZZZZZZZ/connections",
      connectionPayload(),
    );
    expect(attaching.status).toBe(404);
    expect(attaching.body).toEqual(refusal);
  });

  it("answers one envelope, newest first, and pages through with its cursor", async () => {
    for (let n = 0; n < 51; n += 1) {
      const written = await ask(
        "POST",
        "/api/agents",
        registration({
          name: `Agent ${String(n).padStart(2, "0")}`,
          retellAgentId: `agent_in_retell_${n}`,
        }),
      );
      expect(written.status, `agent ${n}`).toBe(201);
    }

    const page = await ask("GET", "/api/agents");
    expect(page.status).toBe(200);
    expect(Object.keys(page.body).sort()).toEqual(["items", "next_cursor"]);
    const first = page.body.items as { name: string }[];
    expect(first).toHaveLength(50);
    // Newest first, because the agent somebody is looking for is usually the
    // one they just registered.
    expect(first[0]?.name).toBe("Agent 50");
    expect(page.body.next_cursor).toBeTypeOf("string");

    const rest = await ask("GET", `/api/agents?cursor=${String(page.body.next_cursor)}`);
    expect((rest.body.items as { name: string }[]).map((one) => one.name)).toEqual(["Agent 00"]);
    expect(rest.body.next_cursor).toBeNull();
  });

  it("refuses a cursor that is not an agent id", async () => {
    await ask("POST", "/api/agents", registration());

    const refused = await ask("GET", "/api/agents?cursor=not-an-id");
    expect(refused.status).toBe(400);
    expect(refused.body).toEqual({
      error: "invalid_request",
      message:
        '"not-an-id" is not an agent id, so it cannot be a cursor. Send back ' +
        "the next_cursor from the page before this one, or leave it out to " +
        "start at the newest.",
    });
  });

  /**
   * The two route groups say this in two different sentences, and the fixture
   * keeps both rather than choosing one.
   *
   * The tests group resolves the acting project through the shared helper and
   * says "this credential may not act in project X"; the agents group writes
   * its own and says "this credential acts in project Y, and the request named
   * X". Both are the shipped wording, asserted word for word by each group's
   * own route tests, and a fixture that answered whichever it preferred would
   * teach a client to branch on a sentence the real thing does not always send.
   */
  it("refuses a project this credential was not minted for, in this group's own words", async () => {
    const registered = await ask("POST", "/api/agents", registration());
    const ours = String(agentOf(registered).project_id);
    const theirs = "prj_01JZZZZZZZZZZZZZZZZZZZZZZZ";

    const reading = await ask("GET", `/api/agents?project=${theirs}`);
    expect(reading.status).toBe(403);
    expect(reading.body).toEqual({
      error: "not_permitted",
      message:
        `this credential acts in project ${ours}, and the request ` +
        `named ${theirs}. A key minted for one product area reads that ` +
        "one; drop the project, or use a key for the whole organization.",
    });

    const writing = await ask("POST", "/api/agents", {
      ...registration({ name: "Elsewhere", retellAgentId: "agent_in_retell_5" }),
      project: theirs,
    });
    expect(writing.status).toBe(403);
    expect(writing.body).toEqual({
      error: "not_permitted",
      message:
        `this credential acts in project ${ours}, and the request ` +
        `named ${theirs}. A key minted for one product area writes into ` +
        "that one; drop the project, or use a key for the whole organization.",
    });
    expect(platform.registered.agents).toHaveLength(1);
  });

  it("never answers a sealed secret back, on any read", async () => {
    const secret = "retell-secret-A1B2C3D4WXYZ";
    const registered = await ask("POST", "/api/agents", registration({ apiKey: secret }));
    const agentId = String(agentOf(registered).id);

    for (const where of ["/api/agents", `/api/agents/${agentId}`]) {
      const answer = await fetch(`${platform.url}${where}`, {
        headers: { authorization: `Bearer ${key}` },
      });
      expect(answer.status).toBe(200);
      expect(await answer.text()).not.toContain(secret);
    }
  });
});

describe("starting a run", () => {
  /** A signed-in developer with an agent to check and a test to check it with. */
  async function readyToRun(type = "retell"): Promise<{
    agentId: string;
    connectionId: string;
    oneCaller: string;
  }> {
    const registered = await ask("POST", "/api/agents", {
      name: type === "retell" ? "Front desk" : "Old line",
      connection:
        type === "retell"
          ? {
              type: "retell",
              modality: "voice",
              config: { retellAgentId: "agent_in_retell_1" },
              credentials: { apiKey: "retell-secret-A1B2C3D4WXYZ" },
            }
          : { type: "phone", modality: "voice", config: { phoneNumber: "+15551234567" } },
    });
    const created = await ask("POST", "/api/tests", { ...RESCHEDULING });
    return {
      agentId: String(agentOf(registered).id),
      connectionId: String(connectionOf(registered).id),
      oneCaller: String(created.body.version_id),
    };
  }

  it("refuses the whole creation for one version it cannot pin", async () => {
    const { connectionId, oneCaller } = await readyToRun();
    const missing = "tstv_01JZZZZZZZZZZZZZZZZZZZZZZZ";

    const unknown = await ask("POST", "/api/runs", {
      connection: connectionId,
      test_versions: [oneCaller, missing],
    });
    expect(unknown.status).toBe(422);
    expect(unknown.body).toEqual({
      error: "unprocessable",
      message:
        `there is no test version ${missing} on this egma. Push the test ` +
        `first, or read the test and pin the version_id it names now.`,
    });

    const doubled = await ask("POST", "/api/runs", {
      connection: connectionId,
      test_versions: [oneCaller, oneCaller],
    });
    expect(doubled.status).toBe(422);
    expect(doubled.body).toEqual({
      error: "unprocessable",
      message:
        `test version ${oneCaller} is pinned twice on one run. Pin each ` +
        `version once; a run already conducts one simulation per test per ` +
        `persona.`,
    });

    const unusable = await ask("POST", "/api/runs", {
      connection: connectionId,
      test_versions: [oneCaller, 7],
    });
    expect(unusable.status).toBe(422);
    expect(unusable.body).toEqual({
      error: "unprocessable",
      message:
        "a run pins each test version as text — the version_id a push or a " +
        "read answered with — and one entry in test_versions is neither. " +
        "Send them all, or none of them runs.",
    });

    const none = await ask("POST", "/api/runs", {
      connection: connectionId,
      test_versions: [],
    });
    expect(none.status).toBe(422);
    expect(none.body).toEqual({
      error: "unprocessable",
      message:
        "a run needs at least one test version, because a run with no " +
        "simulations checks nothing. Pin the version_id of each test this " +
        "run should execute.",
    });

    expect(platform.running.runs).toEqual([]);
  });

  it("says which of the two ids it could not read, and never confirms one", async () => {
    const { agentId, connectionId, oneCaller } = await readyToRun();
    const missing = "con_01JZZZZZZZZZZZZZZZZZZZZZZZ";
    const other = "agt_01JZZZZZZZZZZZZZZZZZZZZZZZ";

    const nowhere = await ask("POST", "/api/runs", {
      connection: missing,
      test_versions: [oneCaller],
    });
    expect(nowhere.status).toBe(404);
    expect(nowhere.body).toEqual({
      error: "not_found",
      message:
        `there is no connection ${missing} in this project. Check the id, ` +
        `or read your agents to see how each one is reached.`,
    });

    const mismatched = await ask("POST", "/api/runs", {
      agent: other,
      connection: connectionId,
      test_versions: [oneCaller],
    });
    expect(mismatched.status).toBe(404);
    expect(mismatched.body).toEqual({
      error: "not_found",
      message:
        `connection ${connectionId} is not on agent ${other}. Name ` +
        `the agent that connection is on, or leave the agent out and egma ` +
        `takes the connection's own.`,
    });

    // A string that could not be an agent id at all is the same mistake one
    // step earlier, and it says which of the two ids it could not read.
    const misread = await ask("POST", "/api/runs", {
      agent: connectionId,
      connection: connectionId,
      test_versions: [oneCaller],
    });
    expect(misread.status).toBe(404);
    expect(misread.body).toEqual({
      error: "not_found",
      message:
        `"${connectionId}" is not an agent id, so no connection is on it. ` +
        `Name the agent that connection is on, or leave the agent out and ` +
        `egma takes the connection's own.`,
    });

    // And a connection id that could not be one either.
    const unreadable = await ask("POST", "/api/runs", {
      connection: agentId,
      test_versions: [oneCaller],
    });
    expect(unreadable.status).toBe(404);
    expect(unreadable.body).toEqual({
      error: "not_found",
      message:
        `"${agentId}" is not a connection id. Send the con_ id ` +
        `registering the agent answered with.`,
    });
  });

  it("refuses a request that named no connection, rather than one it never sent", async () => {
    const { oneCaller } = await readyToRun();

    // Absent and blank are the same mistake, and "no connection of yours has
    // that id" would be a sentence about an id nobody sent.
    for (const body of [
      { test_versions: [oneCaller] },
      { connection: "", test_versions: [oneCaller] },
      { connection: "   ", test_versions: [oneCaller] },
    ]) {
      const refused = await ask("POST", "/api/runs", body);
      expect(refused.status, JSON.stringify(body)).toBe(422);
      expect(refused.body).toEqual({
        error: "unprocessable",
        message:
          "a run is conducted over a connection, and this request named " +
          "none. Send connection with the con_ id of the way egma should " +
          "reach the agent — registering the agent answered with one.",
      });
    }
  });

  it("starts a run over a phone connection, because the phone adapter has shipped", async () => {
    const { connectionId, oneCaller } = await readyToRun("phone");

    const started = await ask("POST", "/api/runs", {
      connection: connectionId,
      test_versions: [oneCaller],
    });

    // This was the `no_adapter` refusal until the phone plug shipped. Both
    // ends of the agreement had to move together: a fixture still refusing
    // here would let a client pass its checks and fail on a real platform.
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    expect(started.body).toMatchObject({
      connection_id: connectionId,
      connection_type: "phone",
      modality: "voice",
    });
    expect(platform.running.runs).toHaveLength(1);
  });

  /**
   * Which refusal arrives when a body gets two things wrong at once.
   *
   * The shape of the selection is read at the door, before anything about the
   * connection is; the *contents* of the selection are read after. So a
   * `test_versions` that is not a list of text beats a missing connection, and
   * a `test_versions` that is empty does not. It is worth pinning because a
   * coding agent fixes one refusal at a time and meets them in this order.
   */
  it("reads the shape of the selection before the connection, and its contents after", async () => {
    const unusable = await ask("POST", "/api/runs", { test_versions: [7] });
    expect(unusable.status).toBe(422);
    expect(unusable.body).toEqual({
      error: "unprocessable",
      message:
        "a run pins each test version as text — the version_id a push or a " +
        "read answered with — and one entry in test_versions is neither. " +
        "Send them all, or none of them runs.",
    });

    // Empty is not a shape problem — it is a selection problem — so the missing
    // connection is answered first.
    const empty = await ask("POST", "/api/runs", { test_versions: [] });
    expect(empty.status).toBe(422);
    expect(empty.body).toEqual({
      error: "unprocessable",
      message:
        "a run is conducted over a connection, and this request named " +
        "none. Send connection with the con_ id of the way egma should " +
        "reach the agent — registering the agent answered with one.",
    });
  });

  it("refuses a selection larger than a run may hold, naming what it asked for", async () => {
    const { connectionId } = await readyToRun();

    const everybody = Array.from({ length: 20 }, (_, at) =>
      platform.tests.addPersona(`persona-${at}`),
    );
    const versions = Array.from({ length: 11 }, (_, at) =>
      platform.tests.add({
        name: `crowded-${at}`,
        scenario: "Everybody rings at once.",
        expectedBehaviors: ["The agent answers"],
        personas: everybody,
      }).versionId,
    );

    const refused = await ask("POST", "/api/runs", {
      connection: connectionId,
      test_versions: versions,
    });

    expect(refused.status).toBe(422);
    expect(refused.body).toEqual({
      error: "unprocessable",
      message:
        "a run conducts at most 200 simulations, and these 11 versions ask " +
        "for 220. Split the selection across runs.",
    });

    expect(platform.running.runs).toEqual([]);
  });
});

describe("reading and following a run", () => {
  async function aRun(): Promise<string> {
    const registered = await ask("POST", "/api/agents", registration({ modality: "voice" }));
    const created = await ask("POST", "/api/tests", { ...RESCHEDULING });
    const started = await ask("POST", "/api/runs", {
      connection: String(connectionOf(registered).id),
      test_versions: [String(created.body.version_id)],
    });
    expect(started.status).toBe(201);
    return String(started.body.id);
  }

  it("says the same thing about a run that is not there and one that is not yours", async () => {
    const refusal = {
      error: "not_found",
      message: "no run of yours has that id. Check the id, or start a run with POST /api/runs.",
    };

    const reading = await ask("GET", "/api/runs/run_01JZZZZZZZZZZZZZZZZZZZZZZZ");
    expect(reading.status).toBe(404);
    expect(reading.body).toEqual(refusal);

    const following = await ask("GET", "/api/runs/run_01JZZZZZZZZZZZZZZZZZZZZZZZ/events");
    expect(following.status).toBe(404);
    expect(following.body).toEqual(refusal);
  });

  it("refuses a number this feed never issued rather than starting again from the beginning", async () => {
    const runId = await aRun();

    // `Number` would take every one of these and answer about a page nobody
    // asked for — 0x10 is sixteen, 1e3 is a thousand, " 7 " is seven — while
    // the sentence says a sequence number is what it takes.
    for (const after of [
      "the-last-one",
      "-1",
      "1.5",
      "0x10",
      "1e3",
      "5.0",
      " 7 ",
      "+3",
      "2147483648",
      "9007199254740993",
      "99999999999999999999",
    ]) {
      const refused = await ask(
        "GET",
        `/api/runs/${runId}/events?after=${encodeURIComponent(after)}`,
      );
      expect(refused.status, after).toBe(400);
      expect(refused.body).toEqual({
        error: "invalid_request",
        message:
          `"${after}" is not a sequence number this feed issued. Send back ` +
          `the next an earlier page answered with, or leave after out to ` +
          `start at the first change.`,
      });
    }

    // A parameter that arrived empty is a parameter nobody set — the rule every
    // query in this API shares — so `?after=` starts at the beginning rather
    // than being refused for a value it does not have.
    const blank = await ask("GET", `/api/runs/${runId}/events?after=`);
    expect(blank.status).toBe(200);
    // The whole body: a follower seeds itself from `next` and stops on `done`,
    // so a feed that answered the right keys with the wrong numbers would send
    // it round again from a place it had already read.
    expect(blank.body).toEqual({ events: [], next: 0, done: false });
  });

  /**
   * What the query says is answered before the run is looked up.
   *
   * Both are refusals, so which one arrives is only visible when a request gets
   * both wrong at once — and that is exactly the request a follower makes after
   * a crash, holding a cursor it half-remembers and a run id it may have lost.
   * Telling it the run is gone when the real problem is its cursor sends it to
   * start a new run over a run that is still going.
   */
  it("answers a cursor it cannot read before it says whether the run is there", async () => {
    const refused = await ask(
      "GET",
      "/api/runs/run_01JZZZZZZZZZZZZZZZZZZZZZZZ/events?after=1e3",
    );

    expect(refused.status).toBe(400);
    expect(refused.body).toEqual({
      error: "invalid_request",
      message:
        '"1e3" is not a sequence number this feed issued. Send back the next ' +
        "an earlier page answered with, or leave after out to start at the " +
        "first change.",
    });
  });
});
