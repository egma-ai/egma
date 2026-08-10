import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  getRun,
  LONGEST_MOCK_TOOL_DELAY_MILLISECONDS,
  resolveMockTools,
} from "@egma/db";
import { afterEach, describe, expect, it } from "vitest";

import { createApi, type TestApi } from "./support/api.ts";
import {
  contextFor,
  projectKeyFor,
  request as ask,
  signUp,
  type Answer,
  type Customer,
} from "./support/traces.ts";

/**
 * The mocked world a run executes in, from both ends: the overrides a test
 * carries in its own versioned content, and the world a run freezes when it
 * starts.
 *
 * Two promises are asserted here and they are the reason mock tools can go
 * unversioned at all. **A test's overrides version with the test**, exactly as
 * its expected behaviors do, so editing one mints a version and the version
 * before it still says what it said. **A run freezes the rest at creation**, so
 * editing a project mock tool afterwards reaches nothing already going — every
 * simulation of one run sees one world, and a run half-conducted under two
 * worlds is a run whose numbers would mean nothing.
 */

let api: TestApi;

afterEach(async () => {
  await api?.close();
});

function request(
  method: "GET" | "POST" | "PATCH",
  url: string,
  key: string,
  payload?: Record<string, unknown>,
): Promise<Answer> {
  return ask(api.app, method, url, key, payload);
}

const RESCHEDULING = {
  name: "Reschedules a booked appointment",
  scenario:
    "Their cleaning is booked for Thursday morning and has to move to any afternoon next week.",
  expected_behaviors: ["confirms the new time back before finishing"],
} as const;

/**
 * A way of reaching one agent. The provider's own id is per agent, because the
 * factory reuses an agent registered for the same one — which is exactly right,
 * and would quietly hand a second `registerAgent` the first agent back.
 */
function retellFor(name: string): Record<string, unknown> {
  return {
    type: "retell",
    modality: "chat",
    config: { retellAgentId: `agent_in_retell_${name.replace(/\W+/gu, "_")}` },
    credentials: { apiKey: "retell-secret-A1B2C3D4WXYZ" },
  };
}

type Pinned = { readonly testId: string; readonly versionId: string };

async function pushTest(
  key: string,
  body: Record<string, unknown>,
): Promise<Pinned & { body: Record<string, unknown> }> {
  const created = await request("POST", "/api/tests", key, {
    ...RESCHEDULING,
    ...body,
  });
  expect(created.statusCode, JSON.stringify(created.body)).toBe(201);
  return {
    testId: String(created.body.id),
    versionId: String(created.body.version_id),
    body: created.body,
  };
}

async function registerAgent(
  key: string,
  name: string,
): Promise<{ agentId: string; connectionId: string }> {
  const registered = await request("POST", "/api/agents", key, {
    name,
    connection: { ...retellFor(name), name },
  });
  expect(registered.statusCode, JSON.stringify(registered.body)).toBe(201);
  return {
    agentId: (registered.body.agent as { id: string }).id,
    connectionId: (registered.body.connection as { id: string }).id,
  };
}

async function mockTool(
  key: string,
  body: Record<string, unknown>,
): Promise<string> {
  const created = await request("POST", "/api/mock-tools", key, body);
  expect(created.statusCode, JSON.stringify(created.body)).toBe(201);
  return String(created.body.id);
}

/** How many versions a test holds — the proof an edit minted one, or none. */
async function versionCount(testId: string): Promise<number> {
  const { rows } = await api.database.sql<{ count: string }>(
    "select count(*) as count from test_version where test_id = $1",
    [testId],
  );
  return Number(rows[0]?.count);
}

const EMPTY_CALENDAR = {
  tool: "check_availability",
  answer: { slots: [] },
} as const;

describe("a test's own overrides", () => {
  it("are admitted as versioned content and read back inside the version", async () => {
    api = await createApi("mock_world_test_content");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const key = await projectKeyFor(api.app, ada);

    const pushed = await pushTest(key, {
      mock_tools: [{ ...EMPTY_CALENDAR, delay_ms: 400 }],
    });

    expect(pushed.body.mock_tools).toEqual([
      { tool: "check_availability", answer: { slots: [] }, delay_ms: 400 },
    ]);

    const frozen = await request(
      "GET",
      `/api/test-versions/${pushed.versionId}`,
      key,
    );
    expect(frozen.statusCode).toBe(200);
    expect(frozen.body.mock_tools).toEqual(pushed.body.mock_tools);
  });

  it("mints a version when one is edited, exactly as a behavior does", async () => {
    api = await createApi("mock_world_test_versions");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const key = await projectKeyFor(api.app, ada);
    const pushed = await pushTest(key, { mock_tools: [EMPTY_CALENDAR] });

    const edited = await request("PATCH", `/api/tests/${pushed.testId}`, key, {
      mock_tools: [
        { tool: "check_availability", error: "the calendar is unreachable" },
      ],
      expected_version_id: pushed.versionId,
    });

    expect(edited.statusCode, JSON.stringify(edited.body)).toBe(200);
    expect(edited.body.version).toBe(2);
    expect(edited.body.mock_tools).toEqual([
      {
        tool: "check_availability",
        error: "the calendar is unreachable",
        delay_ms: 0,
      },
    ]);
    expect(await versionCount(pushed.testId)).toBe(2);

    // And the version it left behind still says what it said.
    const before = await request(
      "GET",
      `/api/test-versions/${pushed.versionId}`,
      key,
    );
    expect(before.body.mock_tools).toEqual([
      { tool: "check_availability", answer: { slots: [] }, delay_ms: 0 },
    ]);
  });

  it("mints nothing for overrides byte-identical to the current version", async () => {
    api = await createApi("mock_world_test_identical");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const key = await projectKeyFor(api.app, ada);
    const pushed = await pushTest(key, { mock_tools: [EMPTY_CALENDAR] });

    const again = await request("PATCH", `/api/tests/${pushed.testId}`, key, {
      mock_tools: [EMPTY_CALENDAR],
      expected_version_id: pushed.versionId,
    });

    expect(again.statusCode, JSON.stringify(again.body)).toBe(200);
    expect(again.body.version_id).toBe(pushed.versionId);
    expect(await versionCount(pushed.testId)).toBe(1);
  });

  it("keeps the overrides an edit left out, and clears them for an empty list", async () => {
    api = await createApi("mock_world_test_kept");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const key = await projectKeyFor(api.app, ada);
    const pushed = await pushTest(key, { mock_tools: [EMPTY_CALENDAR] });

    const elsewhere = await request(
      "PATCH",
      `/api/tests/${pushed.testId}`,
      key,
      {
        scenario: "They want the Wednesday slot instead.",
        expected_version_id: pushed.versionId,
      },
    );
    expect(elsewhere.statusCode, JSON.stringify(elsewhere.body)).toBe(200);
    expect(elsewhere.body.mock_tools).toEqual(pushed.body.mock_tools);

    const cleared = await request("PATCH", `/api/tests/${pushed.testId}`, key, {
      mock_tools: [],
      expected_version_id: elsewhere.body.version_id,
    });
    expect(cleared.statusCode, JSON.stringify(cleared.body)).toBe(200);
    expect(cleared.body.mock_tools).toEqual([]);
    expect(cleared.body.version).toBe(3);
  });

  it("holds an override to the gates a project mock tool is held to", async () => {
    api = await createApi("mock_world_test_gates");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const key = await projectKeyFor(api.app, ada);

    const blank = await request("POST", "/api/tests", key, {
      ...RESCHEDULING,
      mock_tools: [{ tool: "  ", answer: {} }],
    });
    expect(blank.statusCode).toBe(422);
    expect(blank.body).toEqual({
      error: "unprocessable",
      message:
        "tool is the name of the agent's tool this mock tool answers for, " +
        "and this one is blank. Send the tool's name exactly as the agent " +
        "registers it.",
    });

    const slow = await request("POST", "/api/tests", key, {
      ...RESCHEDULING,
      mock_tools: [{ ...EMPTY_CALENDAR, delay_ms: 60_000 }],
    });
    expect(slow.statusCode).toBe(422);
    expect(slow.body).toEqual({
      error: "unprocessable",
      message:
        "delay_ms is 60000, and a mock tool may delay its answer by at most " +
        "30000 milliseconds — the budget the exchange carrying it is given. " +
        "Send a smaller delay_ms.",
    });

    const twice = await request("POST", "/api/tests", key, {
      ...RESCHEDULING,
      mock_tools: [EMPTY_CALENDAR, { ...EMPTY_CALENDAR, answer: { slots: [1] } }],
    });
    expect(twice.statusCode).toBe(422);
    expect(twice.body).toEqual({
      error: "unprocessable",
      message:
        'this test overrides "check_availability" twice; override each tool once',
    });

    const { rows } = await api.database.sql("select id from test");
    expect(rows).toEqual([]);
  });
});

/** Somebody with a key, an agent to check and a way of reaching it. */
async function aCustomerReadyToRun(label: string): Promise<{
  ada: Customer;
  key: string;
  agentId: string;
  connectionId: string;
}> {
  api = await createApi(label);
  const ada = await signUp(api.app, "ada@acme.example", "Acme");
  const key = await projectKeyFor(api.app, ada);
  const { agentId, connectionId } = await registerAgent(key, "Front desk");
  return { ada, key, agentId, connectionId };
}

describe("the world a run freezes", () => {
  it("carries the project's answers, and an edit afterwards reaches none of them", async () => {
    const { ada, key, connectionId } = await aCustomerReadyToRun(
      "mock_world_frozen",
    );
    const mockToolId = await mockTool(key, EMPTY_CALENDAR);
    const pinned = await pushTest(key, {});

    const started = await request("POST", "/api/runs", key, {
      connection: connectionId,
      test_versions: [pinned.versionId],
    });
    expect(started.statusCode, JSON.stringify(started.body)).toBe(201);
    const runId = String(started.body.id);

    expect(started.body.mock_tools).toEqual({
      defaults: [
        {
          tool: "check_availability",
          mock_tool_id: mockToolId,
          answer: { slots: [] },
          delay_ms: 0,
        },
      ],
      overrides: {},
    });

    // The world moves, after the run was created.
    const edited = await request("PATCH", `/api/mock-tools/${mockToolId}`, key, {
      answer: { slots: ["Tuesday 14:00"] },
      delay_ms: 2_000,
    });
    expect(edited.statusCode, JSON.stringify(edited.body)).toBe(200);

    // And the run answers exactly what it froze, in every reading of it.
    const read = await request("GET", `/api/runs/${runId}`, key);
    expect(read.body.mock_tools).toEqual(started.body.mock_tools);

    const held = await getRun(contextFor(ada, "member"), runId);
    expect(resolveMockTools(held!.mockToolSnapshot, pinned.versionId)).toEqual([
      {
        toolName: "check_availability",
        mockToolId,
        answer: { answer: { slots: [] } },
        delayMilliseconds: 0,
      },
    ]);

    // A run started now sees the world as it is now, which is the other half:
    // the freeze is per run, never a refusal to move.
    const after = await request("POST", "/api/runs", key, {
      connection: connectionId,
      test_versions: [pinned.versionId],
    });
    expect(
      (after.body.mock_tools as { defaults: { delay_ms: number }[] }).defaults[0]
        ?.delay_ms,
    ).toBe(2_000);
  });

  it("lets a test's override beat the project's answer for the same tool", async () => {
    const { ada, key, connectionId } = await aCustomerReadyToRun(
      "mock_world_override_wins",
    );
    const mockToolId = await mockTool(key, EMPTY_CALENDAR);
    await mockTool(key, {
      tool: "book_appointment",
      answer: { booked: true },
    });

    const plain = await pushTest(key, { name: "the ordinary path" });
    const forcing = await pushTest(key, {
      name: "the calendar is down",
      mock_tools: [
        {
          tool: "check_availability",
          error: "the calendar is unreachable",
          delay_ms: 250,
        },
      ],
    });

    const started = await request("POST", "/api/runs", key, {
      connection: connectionId,
      test_versions: [plain.versionId, forcing.versionId],
    });
    expect(started.statusCode, JSON.stringify(started.body)).toBe(201);

    const held = await getRun(
      contextFor(ada, "member"),
      String(started.body.id),
    );
    const snapshot = held!.mockToolSnapshot;

    // The ordinary test sees the project's world, untouched.
    expect(resolveMockTools(snapshot, plain.versionId)).toEqual([
      {
        toolName: "check_availability",
        mockToolId,
        answer: { answer: { slots: [] } },
        delayMilliseconds: 0,
      },
      {
        toolName: "book_appointment",
        mockToolId: expect.stringMatching(/^mck_/u),
        answer: { answer: { booked: true } },
        delayMilliseconds: 0,
      },
    ]);

    // The forcing test sees its own answer in that tool's place, and the
    // project's answer for everything it did not override. The override carries
    // no mock tool id, because an override is the test's own content.
    expect(resolveMockTools(snapshot, forcing.versionId)).toEqual([
      {
        toolName: "check_availability",
        mockToolId: null,
        answer: { error: "the calendar is unreachable" },
        delayMilliseconds: 250,
      },
      {
        toolName: "book_appointment",
        mockToolId: expect.stringMatching(/^mck_/u),
        answer: { answer: { booked: true } },
        delayMilliseconds: 0,
      },
    ]);
  });

  it("carries a test's override of a tool the project answers for at all", async () => {
    const { ada, key, connectionId } = await aCustomerReadyToRun(
      "mock_world_override_only",
    );
    const pinned = await pushTest(key, {
      mock_tools: [{ tool: "lookup_customer", answer: { tier: "gold" } }],
    });

    const started = await request("POST", "/api/runs", key, {
      connection: connectionId,
      test_versions: [pinned.versionId],
    });
    expect(started.statusCode, JSON.stringify(started.body)).toBe(201);

    const held = await getRun(
      contextFor(ada, "member"),
      String(started.body.id),
    );
    expect(resolveMockTools(held!.mockToolSnapshot, pinned.versionId)).toEqual([
      {
        toolName: "lookup_customer",
        mockToolId: null,
        answer: { answer: { tier: "gold" } },
        delayMilliseconds: 0,
      },
    ]);
  });

  it("keeps a scoped answer out of a run against an agent it does not name", async () => {
    const { ada, key } = await aCustomerReadyToRun("mock_world_scoping");
    const experimental = await registerAgent(key, "Front desk, experimental");
    const stable = await registerAgent(key, "Front desk, stable");

    const everywhere = await mockTool(key, {
      tool: "book_appointment",
      answer: { booked: true },
    });
    await mockTool(key, {
      ...EMPTY_CALENDAR,
      agents: ["Front desk, experimental"],
    });

    const pinned = await pushTest(key, {});
    const auth = contextFor(ada, "member");

    const against = async (connectionId: string) => {
      const started = await request("POST", "/api/runs", key, {
        connection: connectionId,
        test_versions: [pinned.versionId],
      });
      expect(started.statusCode, JSON.stringify(started.body)).toBe(201);
      const held = await getRun(auth, String(started.body.id));
      return resolveMockTools(held!.mockToolSnapshot, pinned.versionId).map(
        (one) => one.toolName,
      );
    };

    // The scoped answer applies where it was scoped, and nowhere else. The
    // unscoped one applies everywhere, which is the ordinary case and what
    // keeps two prompt variants comparable.
    expect(await against(experimental.connectionId)).toEqual([
      "book_appointment",
      "check_availability",
    ]);
    expect(await against(stable.connectionId)).toEqual(["book_appointment"]);
    expect(everywhere).toMatch(/^mck_/u);
  });

  it("freezes nothing at all for a project that answers for no tool", async () => {
    const { ada, key, connectionId } = await aCustomerReadyToRun(
      "mock_world_empty",
    );
    const pinned = await pushTest(key, {});

    const started = await request("POST", "/api/runs", key, {
      connection: connectionId,
      test_versions: [pinned.versionId],
    });
    expect(started.statusCode, JSON.stringify(started.body)).toBe(201);
    expect(started.body.mock_tools).toEqual({ defaults: [], overrides: {} });

    const held = await getRun(
      contextFor(ada, "member"),
      String(started.body.id),
    );
    expect(resolveMockTools(held!.mockToolSnapshot, pinned.versionId)).toEqual(
      [],
    );
  });
});

describe("no version chain exists for a mock tool", () => {
  it("holds one row and one row only, however many times it is edited", async () => {
    api = await createApi("mock_world_unversioned");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const key = await projectKeyFor(api.app, ada);
    const mockToolId = await mockTool(key, EMPTY_CALENDAR);

    for (const slots of [["Tuesday"], ["Wednesday"], ["Thursday"]]) {
      const edited = await request(
        "PATCH",
        `/api/mock-tools/${mockToolId}`,
        key,
        { answer: { slots } },
      );
      expect(edited.statusCode, JSON.stringify(edited.body)).toBe(200);
    }

    const { rows } = await api.database.sql<{ count: string }>(
      "select count(*) as count from mock_tool",
    );
    expect(Number(rows[0]?.count)).toBe(1);

    // And there is no table anywhere holding a mock tool's history, which is
    // the whole of the exemption: a version chain nobody wrote cannot be relied
    // on by accident later.
    const { rows: tables } = await api.database.sql<{ tablename: string }>(
      `select tablename from pg_tables
        where schemaname = 'public' and tablename like '%mock%'
        order by tablename`,
    );
    expect(tables.map((row) => row.tablename)).toEqual([
      "mock_tool",
      "mock_tool_agent",
    ]);
  });
});

/**
 * The delay an author may write and the delay the simulator will be handed are
 * one number written in two places — a constant here and a `maximum` in the
 * contract's own schema, in two languages, neither able to import the other.
 *
 * They have to agree or the guarantee stops holding at exactly the moment it
 * matters: an authoring gate admitting what the work order refuses would let a
 * mock tool be saved and then make every run that used it undispatchable, and
 * the reverse would hand the simulator a delay the exchange carrying it cannot
 * survive. Nothing enforces the agreement but this.
 */
describe("the longest delay, said in two places", () => {
  it("admits at authoring exactly what the work order admits", async () => {
    const schema = JSON.parse(
      await readFile(
        fileURLToPath(
          new URL(
            "../../../packages/simulation-contract/schemas/simulation-spec.v1.schema.json",
            import.meta.url,
          ),
        ),
        "utf8",
      ),
    ) as {
      $defs: {
        mock_tool: { properties: { delay_milliseconds: { maximum: number } } };
      };
    };

    expect(schema.$defs.mock_tool.properties.delay_milliseconds.maximum).toBe(
      LONGEST_MOCK_TOOL_DELAY_MILLISECONDS,
    );
  });
});
