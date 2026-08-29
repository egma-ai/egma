import { newId } from "@egma/ids";
import { createPersona, recordMockState, type MockMetadata } from "@egma/db";
import { afterEach, describe, expect, it } from "vitest";

import { createApi, type TestApi } from "./support/api.ts";
import {
  contextFor,
  NEUTRAL_PERSON,
  projectKeyFor,
  request as ask,
  signUp,
  type Customer,
} from "./support/traces.ts";

/**
 * The mocked world through the platform contract: what a developer can set,
 * and what they can read back.
 *
 * The database proofs beside this one show the record admits these facts. This
 * one shows they cross the wire — because a fact only the schema knows is a
 * fact nobody can act on.
 */

let api: TestApi;

afterEach(async () => {
  await api?.close();
});

const RETELL_CHAT = {
  agentPlatform: "retell",
  connectionType: "retell_chat_api",
  accessVariant: "retell_chat_api.api_key",
  modality: "chat",
  config: { retellAgentId: "agent_in_retell_1" },
  credentials: { apiKey: "retell-secret-A1B2C3D4WXYZ" },
} as const;

/**
 * A Retell holding one chat agent with one mockable tool.
 *
 * It answers the reads the tick makes as well as the listing setup makes,
 * because turning the tick on is a read of the account: Egma has to know which
 * response engine the agent runs on and what its numbers are bound to before it
 * can promise anything about a mocked run.
 */
const RETELL_FETCH: typeof fetch = async (input) => {
  const url = String(input);
  const json = (value: unknown) =>
    new Response(JSON.stringify(value), { status: 200 });

  if (url.includes("/v2/list-agents")) {
    return json({
      items: [
        {
          agent_id: "agent_in_retell_1",
          agent_name: "Front desk",
          channel: "chat",
        },
      ],
      has_more: false,
    });
  }
  if (url.includes("/v2/list-phone-numbers")) {
    return json({ items: [], has_more: false });
  }
  if (url.includes("/get-agent/")) {
    return json({
      agent_id: "agent_in_retell_1",
      version: 105,
      is_published: true,
      response_engine: {
        type: "conversation-flow",
        conversation_flow_id: "conversation_flow_2346a0e8367c",
        version: 105,
      },
    });
  }
  if (url.includes("/get-conversation-flow/")) {
    return json({
      conversation_flow_id: "conversation_flow_2346a0e8367c",
      version: 105,
      tools: [
        {
          tool_id: "tool-get_availability",
          type: "custom",
          name: "get_availability",
          description: "Look up open appointment slots.",
          url: "https://backend.example.com/tools/get_availability",
          method: "POST",
          headers: {},
          parameters: { type: "object", properties: {} },
        },
      ],
    });
  }
  throw new Error(`Unexpected Retell read: ${url}`);
};

async function aCustomer(
  label: string,
): Promise<{ ada: Customer; key: string }> {
  api = await createApi(label, { retellFetch: RETELL_FETCH });
  const ada = await signUp(api.app, "ada@acme.example", "Acme");
  return { ada, key: await projectKeyFor(api.app, ada) };
}

describe("the retell_web_call connection, through the API", () => {
  it("is registered and read back with its own product label", async () => {
    const { key } = await aCustomer("web_call_contract");

    const registered = await ask(api.app, "POST", "/v1/agents", key, {
      agentPlatform: "retell",
      name: "Front desk",
      connection: {
        name: "Staging web call",
        agentPlatform: "retell",
        connectionType: "retell_web_call",
        accessVariant: "retell_web_call.api_key",
        modality: "voice",
        config: { retellAgentId: "agent_in_retell_1" },
        credentials: { apiKey: "retell-secret-A1B2C3D4WXYZ" },
      },
    });
    expect(registered.statusCode, JSON.stringify(registered.body)).toBe(201);

    const connection = registered.body.connection as {
      connectionType: string;
      accessVariant: string;
      modality: string;
      credentialsHint: string;
    };
    expect(connection.connectionType).toBe("retell_web_call");
    expect(connection.accessVariant).toBe("retell_web_call.api_key");
    expect(connection.modality).toBe("voice");
    // Sealed: a read gives back the last four characters and never the key.
    expect(connection.credentialsHint).toBe("WXYZ");

    // And the catalog a form is drawn from offers it, conductable: the plug
    // places the call, and the control plane hands it the version to place it
    // against.
    const options = await ask(api.app, "GET", "/v1/connection-options", key);
    expect(options.statusCode, JSON.stringify(options.body)).toBe(200);
    const offered = (
      options.body.items as {
        connectionType: string;
        productLabel: string;
        modality: string;
        simulatorAdapter: boolean;
      }[]
    ).find((one) => one.connectionType === "retell_web_call");
    expect(offered?.productLabel).toBe("Retell web call");
    expect(offered?.modality).toBe("voice");
    expect(offered?.simulatorAdapter).toBe(true);
  });
});

describe("what one run records, through the API", () => {
  it("is four plain facts a reader can interpret without a decoder", async () => {
    const { ada, key } = await aCustomer("mock_tools_contract");

    const registered = await ask(api.app, "POST", "/v1/agents", key, {
      agentPlatform: "retell",
      name: "Front desk",
      connection: RETELL_CHAT,
    });
    expect(registered.statusCode, JSON.stringify(registered.body)).toBe(201);
    const agentId = (registered.body.agent as { id: string }).id;
    const connectionId = (registered.body.connection as { id: string }).id;

    const suite = await ask(api.app, "POST", "/v1/test-suites", key, {
      name: "Appointment changes",
    });
    await createPersona(contextFor(ada, "member"), {
      name: "Impatient Rita",
      ...NEUTRAL_PERSON,
    });
    const pushed = await ask(api.app, "POST", "/v1/tests", key, {
      name: "Books an appointment",
      scenario: "Wants the first free afternoon slot next week.",
      expectedBehaviors: ["confirms the time back before finishing"],
      suiteId: String(suite.body.id),
      personas: ["Impatient Rita"],
    });
    expect(pushed.statusCode, JSON.stringify(pushed.body)).toBe(201);

    const started = await ask(api.app, "POST", "/v1/runs", key, {
      suiteId: String(suite.body.id),
      agentId,
      connectionId,
      idempotencyKey: newId("run"),
    });
    expect(started.statusCode, JSON.stringify(started.body)).toBe(201);
    const runId = String(started.body.id);

    const before = await ask(api.app, "GET", `/v1/runs/${runId}`, key);
    expect(before.statusCode, JSON.stringify(before.body)).toBe(200);
    // A run that copied nothing says so in three nulls, and says whether it
    // was mocked at all off its own frozen snapshot.
    expect(before.body.tempMockAgentVersion).toBeNull();
    expect(before.body.tempMockAgentVersionCleanup).toBeNull();
    expect(before.body.mockMetadata).toBeNull();
    expect(before.body.mockToolsEnabled).toBe(false);

    const note: MockMetadata = {
      engine: {
        type: "conversation-flow",
        engineId: "conversation_flow_2346a0e8367c",
        version: 105,
      },
      numbers: [{ number: "+14155550199", was: "latest", pinnedTo: 8 }],
    };
    await recordMockState(contextFor(ada, "member"), runId, {
      tempMockAgentVersion: 106,
      tempMockAgentVersionCleanup: false,
      mockMetadata: note,
    });

    const after = await ask(api.app, "GET", `/v1/runs/${runId}`, key);
    expect(after.statusCode, JSON.stringify(after.body)).toBe(200);
    expect(after.body.tempMockAgentVersion).toBe(106);
    expect(after.body.tempMockAgentVersionCleanup).toBe(false);
    // The note as the record stores it: where each touched number pointed,
    // and what Egma pinned it to.
    expect(after.body.mockMetadata).toEqual({
      engine: {
        type: "conversation-flow",
        engine_id: "conversation_flow_2346a0e8367c",
        version: 105,
      },
      numbers: [{ number: "+14155550199", was: "latest", pinned_to: 8 }],
    });
  });
});
