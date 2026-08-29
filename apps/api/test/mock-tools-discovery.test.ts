import { afterEach, describe, expect, it } from "vitest";

import { createApi, type TestApi } from "./support/api.ts";
import {
  projectKeyFor,
  request as ask,
  signUp,
} from "./support/traces.ts";

/**
 * The tick, through the platform contract: what it finds, what it seeds, what
 * it warns about, and each of the four reasons it refuses.
 *
 * Driven over HTTP against a Retell that exists only in this file, because what
 * is being proved is what a developer reads back — the classes their tools fall
 * in, the sentence explaining why the box will not go on — and not which
 * requests Egma sent to find out.
 */

let api: TestApi;

afterEach(async () => {
  await api?.close();
});

const RETELL_AGENT = "agent_b0e2e9cb267c47e7e7026cd8e8";
const FLOW = "conversation_flow_2346a0e8367c";

type Account = {
  /** The engine the agent runs on. */
  readonly engine?: "conversation-flow" | "custom-llm";
  /** Every number on the account, with its whole `inbound_agents` array. */
  readonly numbers?: readonly Record<string, unknown>[];
  /** Which agent id the listing answers with, for the two-keys check. */
  readonly listsAgent?: string;
};

const FLOW_TOOLS = [
  {
    tool_id: "tool-get_availability",
    type: "custom",
    name: "get_availability",
    description: "Look up open appointment slots.",
    url: "https://backend.example.com/tools/get_availability",
    method: "POST",
    headers: { Authorization: "Bearer sk_live_FIXTURESECRET" },
    parameters: { type: "object", properties: {} },
    response_variables: { slots: "$.slots" },
  },
  {
    tool_id: "tool-book",
    type: "custom",
    name: "book_appointment",
    description: "Book a slot.",
    url: "https://backend.example.com/tools/book",
    method: "POST",
    headers: {},
    parameters: { type: "object", properties: {} },
  },
  {
    tool_id: "tool-transfer",
    type: "transfer_call",
    name: "transfer_to_front_desk",
    description: "Hands the caller to a person.",
  },
  {
    tool_id: "tool-sms",
    type: "send_sms",
    name: "text_directions",
    description: "Sends the address by SMS.",
  },
  {
    tool_id: "tool-end",
    type: "end_call",
    name: "end_call",
    description: "Ends the conversation.",
  },
];

/** A Retell that answers the four reads the tick makes. */
function retell(account: Account = {}): typeof fetch {
  const engine = account.engine ?? "conversation-flow";
  return (async (input: string | URL | Request) => {
    const url = String(input);
    const json = (value: unknown, status = 200) =>
      new Response(JSON.stringify(value), { status });

    if (url.includes("/v2/list-agents")) {
      return json({
        items: [
          {
            agent_id: account.listsAgent ?? RETELL_AGENT,
            agent_name: "After hours",
            channel: "voice",
          },
        ],
        has_more: false,
      });
    }
    if (url.includes("/v2/list-phone-numbers")) {
      return json({ items: account.numbers ?? [], has_more: false });
    }
    if (url.includes("/get-phone-number/")) {
      return json({
        phone_number: "+12567332874",
        nickname: "After hours",
        inbound_agents: [{ agent_id: RETELL_AGENT, agent_version: "prod" }],
      });
    }
    if (url.includes("/get-agent/")) {
      return json({
        agent_id: RETELL_AGENT,
        version: 105,
        is_published: true,
        response_engine:
          engine === "custom-llm"
            ? {
                type: "custom-llm",
                llm_websocket_url: "wss://customer.example/agent",
              }
            : {
                type: "conversation-flow",
                conversation_flow_id: FLOW,
                version: 105,
              },
      });
    }
    if (url.includes("/get-conversation-flow/")) {
      return json({
        conversation_flow_id: FLOW,
        version: 105,
        tools: FLOW_TOOLS,
        mcps: [{ mcp_id: "mcp-inventory", name: "inventory", url: "https://mcp.example" }],
      });
    }
    throw new Error(`Unexpected Retell read: ${url}`);
  }) as typeof fetch;
}

const WEB_CALL = {
  name: "Staging web call",
  agentPlatform: "retell",
  connectionType: "retell_web_call",
  accessVariant: "retell_web_call.api_key",
  modality: "voice",
  config: { retellAgentId: RETELL_AGENT },
  credentials: { apiKey: "retell-secret-A1B2C3D4WXYZ" },
  platformAgentId: RETELL_AGENT,
} as const;

const PHONE = {
  name: "The published line",
  agentPlatform: "retell",
  connectionType: "phone_number",
  accessVariant: "phone_number.public_e164",
  modality: "voice",
  config: { phoneNumber: "+12567332874" },
  // A phone connection is the one that cannot be taken on trust, so the save
  // re-reads the route with the key it is handed.
  agentPlatformSelection: {
    platformAgentId: RETELL_AGENT,
    credentials: { apiKey: "retell-secret-A1B2C3D4WXYZ" },
  },
} as const;

async function anAgent(
  label: string,
  account: Account,
  connection: Record<string, unknown> = { ...WEB_CALL },
): Promise<{ key: string; agentId: string }> {
  api = await createApi(label, { retellFetch: retell(account) });
  const ada = await signUp(api.app, "ada@acme.example", "Acme");
  const key = await projectKeyFor(api.app, ada);
  const registered = await ask(api.app, "POST", "/v1/agents", key, {
    agentPlatform: "retell",
    name: "After hours",
    connection,
  });
  expect(registered.statusCode, JSON.stringify(registered.body)).toBe(201);
  return { key, agentId: (registered.body.agent as { id: string }).id };
}

const RIDES_TAG = [{ agent_id: RETELL_AGENT, agent_version: "prod" }];
const RIDES_LATEST = [
  { agent_id: RETELL_AGENT, agent_version: "latest", weight: 2 },
];

const numbered = (bindings: readonly Record<string, unknown>[]) => [
  {
    phone_number: "+12567332874",
    nickname: "After hours",
    inbound_agents: bindings,
  },
];

describe("what the tick discovers", () => {
  it("puts every tool in its honest class and warns about the two that really act", async () => {
    const { key, agentId } = await anAgent("tick_discovers", {
      numbers: numbered(RIDES_TAG),
    });

    const found = await ask(
      api.app,
      "POST",
      `/v1/agents/${agentId}/mock-tools:discover`,
      key,
      {},
    );
    expect(found.statusCode, JSON.stringify(found.body)).toBe(200);
    expect(found.body.mockable).toBe(true);
    expect(found.body.refusal).toBeNull();
    expect(found.body.engine).toBe("conversation-flow");
    expect(found.body.servingVersion).toBe(105);

    const tools = found.body.tools as {
      name: string;
      coverage: string;
      answered: boolean;
    }[];
    expect(
      tools.map((tool) => [tool.name, tool.coverage]),
    ).toEqual([
      ["get_availability", "mocked"],
      ["book_appointment", "mocked"],
      ["transfer_to_front_desk", "notInterceptable"],
      ["text_directions", "notInterceptable"],
      ["end_call", "notInterceptable"],
      ["inventory", "notInThisVersion"],
    ]);
    // Nothing seeded by a read.
    expect(found.body.seeded).toEqual([]);
    expect(tools.every((tool) => !tool.answered)).toBe(true);

    // A transfer and an SMS act outside the call, and really will.
    expect(found.body.warnings).toEqual([
      {
        toolName: "transfer_to_front_desk",
        toolType: "transfer_call",
        effect: "transfers the call to a real destination",
      },
      {
        toolName: "text_directions",
        toolType: "send_sms",
        effect: "sends a real text message",
      },
    ]);

    // And the number's verdict, so a screen can say what Egma would do to it.
    expect(found.body.numbers).toEqual([
      {
        number: "+12567332874",
        label: "After hours",
        verdicts: ["environment-tag"],
        pin: false,
      },
    ]);
  });

  it("seeds a deterministic answer per interceptable tool, and never overwrites one", async () => {
    const { key, agentId } = await anAgent("tick_seeds", {
      numbers: numbered(RIDES_TAG),
    });

    // An answer somebody authored before ticking anything.
    const authored = await ask(api.app, "POST", "/v1/mock-tools", key, {
      tool: "book_appointment",
      error: "the calendar is down",
    });
    expect(authored.statusCode, JSON.stringify(authored.body)).toBe(201);

    const seeded = await ask(
      api.app,
      "POST",
      `/v1/agents/${agentId}/mock-tools:discover`,
      key,
      { seed: true },
    );
    expect(seeded.statusCode, JSON.stringify(seeded.body)).toBe(200);
    // Only the tool nobody answered for. The authored one keeps its row.
    expect(seeded.body.seeded).toEqual(["get_availability"]);

    const listed = await ask(api.app, "GET", "/v1/mock-tools", key);
    const rows = listed.body.mockTools as {
      tool: string;
      answer: unknown;
      error?: unknown;
    }[];
    const availability = rows.find((row) => row.tool === "get_availability");
    // Derived from the tool's own declaration: `response_variables` reads
    // `$.slots`, so the seeded answer carries `slots`.
    expect(availability?.answer).toEqual({ slots: "" });
    const booking = rows.find((row) => row.tool === "book_appointment");
    expect(booking?.error).toBe("the calendar is down");

    // Re-discovery only adds, and there is nothing left to add.
    const again = await ask(
      api.app,
      "POST",
      `/v1/agents/${agentId}/mock-tools:discover`,
      key,
      { seed: true },
    );
    expect(again.body.seeded).toEqual([]);
    expect(
      (again.body.tools as { name: string; answered: boolean }[]).filter(
        (tool) => tool.answered,
      ).length,
    ).toBe(2);
  });

  it("refuses the agent an edit that tries to carry a mock switch", async () => {
    // **Mocking is not an agent setting.** It is a switch on each connection,
    // because the lane is what decides whether a mocked run is a thing Egma
    // can conduct — so the agent door says it has no such key rather than
    // silently dropping half a payload.
    const { key, agentId } = await anAgent("tick_not_an_agent_setting", {
      numbers: numbered(RIDES_TAG),
    });

    const refused = await ask(api.app, "PATCH", `/v1/agents/${agentId}`, key, {
      mockToolsDuringSimulations: true,
    });
    expect(refused.statusCode).toBe(400);
    expect(String(refused.body.message)).toContain(
      'an agent edit has no key "mockToolsDuringSimulations"',
    );
  });
});

describe("the refusals the enable-time read carries", () => {
  /** What the consent screen reads, which is where a refusal is shown. */
  async function discovered(key: string, agentId: string) {
    const found = await ask(
      api.app,
      "POST",
      `/v1/agents/${agentId}/mock-tools:discover`,
      key,
      {},
    );
    expect(found.statusCode, JSON.stringify(found.body)).toBe(200);
    return found.body as {
      mockable: boolean;
      refusal: { reason: string; message: string } | null;
      numbers: { number: string; pin: boolean }[];
    };
  }

  it("names a custom-LLM engine, and says where those tools live", async () => {
    const { key, agentId } = await anAgent("mock_tools_custom_llm", {
      engine: "custom-llm",
    });
    const found = await discovered(key, agentId);
    expect(found.mockable).toBe(false);
    expect(found.refusal?.reason).toBe("custom_llm_engine");
    expect(found.refusal?.message).toContain("custom LLM");
  });

  it("shows the `latest`-riding number rather than refusing for it", async () => {
    // The per-number checkbox is gone: pinning and restoring is one of the
    // four promises the single consent screen makes, so the read shows the
    // number the promise is about and refuses nothing for it.
    const { key, agentId } = await anAgent("mock_tools_pin_shown", {
      numbers: numbered(RIDES_LATEST),
    });
    const found = await discovered(key, agentId);
    expect(found.mockable).toBe(true);
    expect(found.refusal).toBeNull();
    expect(found.numbers.some((one) => one.pin)).toBe(true);
  });

  it("names an agent whose only connection is a phone number", async () => {
    const { key, agentId } = await anAgent(
      "mock_tools_phone_only",
      { numbers: numbered(RIDES_TAG) },
      { ...PHONE },
    );
    const found = await discovered(key, agentId);
    expect(found.mockable).toBe(false);
    expect(found.refusal?.reason).toBe("phone_only_agent");
    expect(found.refusal?.message).toContain("never dialled");
    expect(found.refusal?.message).toContain("real carrier leg");
    expect(found.refusal?.message).toContain("web-call connection");
  });

  it("names two keys that see two different Retell agents", async () => {
    const { key, agentId } = await anAgent("mock_tools_keys_disagree", {
      numbers: numbered(RIDES_TAG),
    });

    // A second connection added by hand, pointing at another Retell agent —
    // which is how the two keys come to see two accounts in practice.
    const added = await ask(
      api.app,
      "POST",
      `/v1/agents/${agentId}/connections`,
      key,
      {
        name: "Somebody else's web call",
        agentPlatform: "retell",
        connectionType: "retell_web_call",
        accessVariant: "retell_web_call.api_key",
        modality: "voice",
        config: { retellAgentId: "agent_somebody_elses_0001" },
        credentials: { apiKey: "retell-secret-ZZZZ9999WXYZ" },
      },
    );
    expect(added.statusCode, JSON.stringify(added.body)).toBe(201);

    const found = await discovered(key, agentId);
    expect(found.mockable).toBe(false);
    expect(found.refusal?.reason).toBe("keys_disagree");
    expect(found.refusal?.message).toContain("agent_somebody_elses_0001");
    expect(found.refusal?.message).toContain("was never mocked");
  });
});
