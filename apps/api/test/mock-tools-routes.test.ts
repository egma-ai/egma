import { createProject, type Role } from "@egma/db";
import { afterEach, describe, expect, it } from "vitest";

import { createApi, type TestApi } from "./support/api.ts";
import {
  colleagueOf,
  contextFor,
  mintKey,
  projectKeyFor,
  request as ask,
  signUp,
  type Answer,
  type Customer,
} from "./support/traces.ts";

/**
 * The mock-tool routes, over real HTTP against real Postgres.
 *
 * A mock tool answers for one of the agent's tools while a simulation runs, so
 * the agent's real backend is never touched and a test can order up the branch
 * it wants — an empty calendar, a booking that errors. This is the door those
 * are authored through, and what is asserted here is what a caller observes:
 * the shapes, the envelope, who may do what, and every refusal sentence word
 * for word. Refusal wording is contract — a coding agent reads it and decides
 * what to do next — so a sentence that changed without somebody deciding to
 * change it fails here.
 */

let api: TestApi;

afterEach(async () => {
  await api?.close();
});

const CALENDAR = {
  tool: "check_availability",
  answer: { slots: ["Tuesday 14:00", "Tuesday 15:30"] },
} as const;

function request(
  method: "GET" | "POST" | "PATCH",
  url: string,
  key: string,
  payload?: Record<string, unknown>,
): Promise<Answer> {
  return ask(api.app, method, url, key, payload);
}

async function createMockToolThrough(
  key: string,
  body: Record<string, unknown>,
): Promise<Answer> {
  return request("POST", "/api/mock-tools", key, body);
}

/** Which project a mock tool landed in — a fact the wire does not say. */
async function projectOf(mockToolId: string): Promise<string | undefined> {
  const { rows } = await api.database.sql<{ project_id: string }>(
    "select project_id from mock_tool where id = $1",
    [mockToolId],
  );
  return rows[0]?.project_id;
}

/** How many rows this project holds — the proof an edit overwrote one. */
async function rowCount(): Promise<number> {
  const { rows } = await api.database.sql<{ count: string }>(
    "select count(*) as count from mock_tool where deleted_at is null",
  );
  return Number(rows[0]?.count);
}

describe("authoring a mock tool", () => {
  it("answers the whole mock tool, with the answer it will serve", async () => {
    api = await createApi("mock_tools_create");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const key = await projectKeyFor(api.app, ada);

    const created = await createMockToolThrough(key, { ...CALENDAR });

    expect(created.statusCode, JSON.stringify(created.body)).toBe(201);
    expect(created.body).toMatchObject({
      tool: CALENDAR.tool,
      answer: CALENDAR.answer,
      delay_ms: 0,
      agents: [],
    });
    expect(String(created.body.id)).toMatch(/^mck_/u);
    expect(created.body.created_at).toBeTypeOf("string");
    expect(await projectOf(String(created.body.id))).toBe(ada.projectId);
  });

  it("admits an error as the answer, which is how a test forces the failure branch", async () => {
    api = await createApi("mock_tools_error");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const key = await projectKeyFor(api.app, ada);

    const created = await createMockToolThrough(key, {
      tool: "book_appointment",
      error: "the booking service is unavailable",
    });

    expect(created.statusCode, JSON.stringify(created.body)).toBe(201);
    expect(created.body).toMatchObject({
      tool: "book_appointment",
      error: "the booking service is unavailable",
      delay_ms: 0,
    });
    expect(created.body.answer).toBeUndefined();
  });

  it("admits a delay, so a mocked backend takes as long as the real one", async () => {
    api = await createApi("mock_tools_delay");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const key = await projectKeyFor(api.app, ada);

    const created = await createMockToolThrough(key, {
      ...CALENDAR,
      delay_ms: 1_200,
    });

    expect(created.statusCode, JSON.stringify(created.body)).toBe(201);
    expect(created.body.delay_ms).toBe(1_200);
  });

  it("admits an answer that is text, a number or null, because a tool may answer any of them", async () => {
    api = await createApi("mock_tools_scalars");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const key = await projectKeyFor(api.app, ada);

    for (const [index, answer] of [
      "already booked",
      42,
      null,
      [1, 2, 3],
      false,
    ].entries()) {
      const created = await createMockToolThrough(key, {
        tool: `answers_${index}`,
        answer,
      });
      expect(created.statusCode, JSON.stringify(created.body)).toBe(201);
      expect(created.body.answer).toEqual(answer);
      expect("answer" in created.body).toBe(true);
    }
  });
});

describe("the gates at the door", () => {
  it("refuses a blank tool name, naming the key", async () => {
    api = await createApi("mock_tools_blank_tool");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const key = await projectKeyFor(api.app, ada);

    const refused = await createMockToolThrough(key, {
      ...CALENDAR,
      tool: "   ",
    });

    expect(refused.statusCode).toBe(422);
    expect(refused.body).toEqual({
      error: "unprocessable",
      message:
        "tool is the name of the agent's tool this mock tool answers for, " +
        "and this one is blank. Send the tool's name exactly as the agent " +
        "registers it.",
    });
    expect(await rowCount()).toBe(0);
  });

  it("refuses a delay above the cap, naming the key and the cap", async () => {
    api = await createApi("mock_tools_delay_cap");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const key = await projectKeyFor(api.app, ada);

    const refused = await createMockToolThrough(key, {
      ...CALENDAR,
      delay_ms: 30_001,
    });

    expect(refused.statusCode).toBe(422);
    expect(refused.body).toEqual({
      error: "unprocessable",
      message:
        "delay_ms is 30001, and a mock tool may delay its answer by at most " +
        "30000 milliseconds — the budget the exchange carrying it is given. " +
        "Send a smaller delay_ms.",
    });
    expect(await rowCount()).toBe(0);
  });

  it("refuses an answer larger than the exchange can carry, naming the key", async () => {
    api = await createApi("mock_tools_answer_size");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const key = await projectKeyFor(api.app, ada);

    const enormous = "x".repeat(16 * 1024);
    const refused = await createMockToolThrough(key, {
      tool: "read_document",
      answer: { body: enormous },
    });

    expect(refused.statusCode).toBe(422);
    expect(refused.body).toEqual({
      error: "unprocessable",
      message:
        `answer is ${16 * 1024 + 11} bytes once serialized, and the exchange ` +
        `that carries it holds at most 15360. An answer that needs more than ` +
        `that is a document rather than a tool answer.`,
    });
    expect(await rowCount()).toBe(0);
  });

  it("refuses a key it has no place for, naming the key", async () => {
    api = await createApi("mock_tools_unknown_key");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const key = await projectKeyFor(api.app, ada);

    const refused = await createMockToolThrough(key, {
      ...CALENDAR,
      matches: { city: "Berlin" },
    });

    expect(refused.statusCode).toBe(400);
    expect(refused.body).toEqual({
      error: "invalid_request",
      message:
        'a mock tool has no key "matches"; it holds tool, answer, error, ' +
        "delay_ms, agents, project",
    });
    expect(await rowCount()).toBe(0);
  });

  it("refuses a scope naming an agent this project does not hold, naming the key", async () => {
    api = await createApi("mock_tools_foreign_agent");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const grace = await signUp(api.app, "grace@globex.example", "Globex");
    const key = await projectKeyFor(api.app, ada);
    const theirs = await agentFor(grace, "Globex front desk");

    const refused = await createMockToolThrough(key, {
      ...CALENDAR,
      agents: [theirs],
    });

    expect(refused.statusCode).toBe(422);
    expect(refused.body).toEqual({
      error: "unprocessable",
      message:
        `agents names ${theirs}, and there is no agent ${theirs} in this ` +
        `project. Name an agent this project already holds, or leave agents ` +
        `out and the mock tool applies to every agent in the project.`,
    });
    expect(await rowCount()).toBe(0);
  });

  it("refuses a mock tool that says nothing at all, naming both keys", async () => {
    api = await createApi("mock_tools_no_answer");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const key = await projectKeyFor(api.app, ada);

    const refused = await createMockToolThrough(key, { tool: "check" });

    expect(refused.statusCode).toBe(422);
    expect(refused.body).toEqual({
      error: "unprocessable",
      message:
        "a mock tool answers with something: send answer with what the tool " +
        "returns, or error with the failure it raises. This one sent neither.",
    });
  });

  it("refuses a mock tool that says two things at once, naming both keys", async () => {
    api = await createApi("mock_tools_both");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const key = await projectKeyFor(api.app, ada);

    const refused = await createMockToolThrough(key, {
      tool: "check",
      answer: { slots: [] },
      error: "unavailable",
    });

    expect(refused.statusCode).toBe(422);
    expect(refused.body).toEqual({
      error: "unprocessable",
      message:
        "a mock tool answers with one thing: this one sent both answer and " +
        "error. Send whichever branch the test needs.",
    });
  });

  it("refuses a second answer for a tool this project already answers for", async () => {
    api = await createApi("mock_tools_twice");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const key = await projectKeyFor(api.app, ada);
    const first = await createMockToolThrough(key, { ...CALENDAR });
    expect(first.statusCode).toBe(201);

    const refused = await createMockToolThrough(key, {
      tool: CALENDAR.tool,
      error: "the calendar is unreachable",
    });

    expect(refused.statusCode).toBe(409);
    expect(refused.body).toEqual({
      error: "conflict",
      message:
        `this project already answers for "${CALENDAR.tool}", with mock tool ` +
        `${String(first.body.id)}. One answer per tool: edit that one, or ` +
        `override it on the test that needs a different branch.`,
    });
    expect(await rowCount()).toBe(1);
  });
});

/** An agent, registered the way the product registers one. */
async function agentFor(
  person: Customer,
  name: string,
  projectId = person.projectId,
): Promise<string> {
  const registered = await ask(
    api.app,
    "POST",
    "/api/agents",
    await mintKey(api.app, person.cookie, `${name} key`, projectId),
    { name },
  );
  expect(registered.statusCode, JSON.stringify(registered.body)).toBe(201);
  return String((registered.body.agent as { id: string }).id);
}

describe("editing a mock tool", () => {
  it("overwrites the row in place, because a mock tool is deliberately unversioned", async () => {
    api = await createApi("mock_tools_edit");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const key = await projectKeyFor(api.app, ada);
    const created = await createMockToolThrough(key, { ...CALENDAR });
    const mockToolId = String(created.body.id);

    const edited = await request("PATCH", `/api/mock-tools/${mockToolId}`, key, {
      answer: { slots: [] },
      delay_ms: 900,
    });

    expect(edited.statusCode, JSON.stringify(edited.body)).toBe(200);
    expect(edited.body).toMatchObject({
      id: mockToolId,
      tool: CALENDAR.tool,
      answer: { slots: [] },
      delay_ms: 900,
    });

    const read = await request("GET", "/api/mock-tools", key);
    expect(read.body.items).toEqual([edited.body]);
    expect(await rowCount()).toBe(1);
  });

  it("turns an answer into an error, and back, keeping one row", async () => {
    api = await createApi("mock_tools_edit_branch");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const key = await projectKeyFor(api.app, ada);
    const created = await createMockToolThrough(key, { ...CALENDAR });
    const mockToolId = String(created.body.id);

    const failing = await request("PATCH", `/api/mock-tools/${mockToolId}`, key, {
      error: "the calendar is unreachable",
    });
    expect(failing.statusCode, JSON.stringify(failing.body)).toBe(200);
    expect(failing.body.error).toBe("the calendar is unreachable");
    expect("answer" in failing.body).toBe(false);

    const answering = await request(
      "PATCH",
      `/api/mock-tools/${mockToolId}`,
      key,
      { answer: { slots: [] } },
    );
    expect(answering.statusCode, JSON.stringify(answering.body)).toBe(200);
    expect(answering.body.answer).toEqual({ slots: [] });
    expect("error" in answering.body).toBe(false);
    expect(await rowCount()).toBe(1);
  });

  it("holds an edit to the same gates a create is held to", async () => {
    api = await createApi("mock_tools_edit_gates");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const key = await projectKeyFor(api.app, ada);
    const created = await createMockToolThrough(key, { ...CALENDAR });
    const mockToolId = String(created.body.id);

    const refused = await request("PATCH", `/api/mock-tools/${mockToolId}`, key, {
      delay_ms: 45_000,
    });

    expect(refused.statusCode).toBe(422);
    expect(refused.body).toEqual({
      error: "unprocessable",
      message:
        "delay_ms is 45000, and a mock tool may delay its answer by at most " +
        "30000 milliseconds — the budget the exchange carrying it is given. " +
        "Send a smaller delay_ms.",
    });

    const still = await request("GET", "/api/mock-tools", key);
    expect((still.body.items as { delay_ms: number }[])[0]?.delay_ms).toBe(0);
  });

  it("is not found for a mock tool this credential could not have read", async () => {
    api = await createApi("mock_tools_edit_tenancy");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const grace = await signUp(api.app, "grace@globex.example", "Globex");
    const created = await createMockToolThrough(
      await projectKeyFor(api.app, ada),
      { ...CALENDAR },
    );
    const theirs = String(created.body.id);

    const refused = await request(
      "PATCH",
      `/api/mock-tools/${theirs}`,
      await projectKeyFor(api.app, grace),
      { delay_ms: 10 },
    );

    expect(refused.statusCode).toBe(404);
    expect(refused.body).toEqual({
      error: "not_found",
      message:
        `there is no mock tool ${theirs} on this egma. List the mock tools ` +
        `to see what this project answers for.`,
    });
  });
});

describe("agent scoping", () => {
  it("names the agents it applies to, by id or by name, and reads them back", async () => {
    api = await createApi("mock_tools_scope");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const key = await projectKeyFor(api.app, ada);
    const stable = await agentFor(ada, "Front desk, stable");
    await agentFor(ada, "Front desk, experimental");

    const created = await createMockToolThrough(key, {
      ...CALENDAR,
      agents: [stable, "Front desk, experimental"],
    });

    expect(created.statusCode, JSON.stringify(created.body)).toBe(201);
    expect(created.body.agents).toEqual([
      { id: stable, name: "Front desk, stable" },
      { id: expect.stringMatching(/^agt_/u), name: "Front desk, experimental" },
    ]);
  });

  it("clears a scope back to every agent when the edit sends an empty list", async () => {
    api = await createApi("mock_tools_scope_cleared");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const key = await projectKeyFor(api.app, ada);
    const stable = await agentFor(ada, "Front desk, stable");
    const created = await createMockToolThrough(key, {
      ...CALENDAR,
      agents: [stable],
    });

    const widened = await request(
      "PATCH",
      `/api/mock-tools/${String(created.body.id)}`,
      key,
      { agents: [] },
    );

    expect(widened.statusCode, JSON.stringify(widened.body)).toBe(200);
    expect(widened.body.agents).toEqual([]);
  });
});

describe("the list of mock tools", () => {
  it("answers one envelope, newest first, and shows nobody else's", async () => {
    api = await createApi("mock_tools_list");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const grace = await signUp(api.app, "grace@globex.example", "Globex");
    const key = await projectKeyFor(api.app, ada);
    const first = await createMockToolThrough(key, { ...CALENDAR });
    const second = await createMockToolThrough(key, {
      tool: "book_appointment",
      error: "the booking service is unavailable",
    });

    const listed = await request("GET", "/api/mock-tools", key);
    expect(listed.statusCode).toBe(200);
    expect((listed.body.items as { id: string }[]).map((one) => one.id)).toEqual(
      [String(second.body.id), String(first.body.id)],
    );
    expect(listed.body.next_cursor).toBeNull();

    const theirs = await request(
      "GET",
      "/api/mock-tools",
      await projectKeyFor(api.app, grace),
    );
    expect(theirs.body).toEqual({ items: [], next_cursor: null });
  });

  it("reads the project the credential acts in, and no sibling of it", async () => {
    api = await createApi("mock_tools_list_project");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const outbound = await createProject(contextFor(ada, "admin"), {
      name: "Outbound",
      slug: "outbound",
    });
    await createMockToolThrough(await projectKeyFor(api.app, ada), {
      ...CALENDAR,
    });

    const there = await mintKey(api.app, ada.cookie, "outbound", outbound.id);
    const listed = await request("GET", "/api/mock-tools", there);

    expect(listed.statusCode).toBe(200);
    expect(listed.body.items).toEqual([]);
  });
});

describe("who may do what", () => {
  it("lets a viewer read every mock tool and write none of them", async () => {
    api = await createApi("mock_tools_viewer");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const vic: Customer = await colleagueOf(
      api.app,
      ada,
      "vic@acme.example",
      "viewer" satisfies Role,
    );
    const authored = await createMockToolThrough(
      await projectKeyFor(api.app, ada),
      { ...CALENDAR },
    );
    const theirs = await projectKeyFor(api.app, vic);

    const listed = await request("GET", "/api/mock-tools", theirs);
    expect(listed.statusCode).toBe(200);
    expect((listed.body.items as unknown[]).length).toBe(1);

    const written = await createMockToolThrough(theirs, {
      tool: "another",
      answer: {},
    });
    expect(written.statusCode).toBe(403);
    expect(written.body).toEqual({
      error: "not_permitted",
      message: "a viewer may not author_definitions",
    });

    const edited = await request(
      "PATCH",
      `/api/mock-tools/${String(authored.body.id)}`,
      theirs,
      { delay_ms: 5 },
    );
    expect(edited.statusCode).toBe(403);
    expect(await rowCount()).toBe(1);
  });
});
