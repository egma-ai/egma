import { newId } from "@egma/ids";
import { createPersona, recordMockedWorld, type MockedWorld } from "@egma/db";
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

const RETELL_FETCH: typeof fetch = async (input) => {
  const url = String(input);
  if (!url.includes("/v2/list-agents")) {
    throw new Error(`Unexpected Retell read: ${url}`);
  }
  return new Response(
    JSON.stringify({
      items: [
        {
          agent_id: "agent_in_retell_1",
          agent_name: "Front desk",
          channel: "chat",
        },
      ],
      has_more: false,
    }),
    { status: 200 },
  );
};

async function aCustomer(
  label: string,
): Promise<{ ada: Customer; key: string }> {
  api = await createApi(label, { retellFetch: RETELL_FETCH });
  const ada = await signUp(api.app, "ada@acme.example", "Acme");
  return { ada, key: await projectKeyFor(api.app, ada) };
}

describe("the mock-tools tick, through the API", () => {
  it("reads off a new agent as off, and is refused with a reason", async () => {
    const { key } = await aCustomer("tick_contract_refused");

    const registered = await ask(api.app, "POST", "/v1/agents", key, {
      agentPlatform: "retell",
      name: "Front desk",
    });
    expect(registered.statusCode, JSON.stringify(registered.body)).toBe(201);
    const agentId = (registered.body.agent as { id: string }).id;
    expect(
      (registered.body.agent as { mockToolsDuringSimulations: boolean })
        .mockToolsDuringSimulations,
    ).toBe(false);

    const refused = await ask(
      api.app,
      "PATCH",
      `/v1/agents/${agentId}`,
      key,
      { mockToolsDuringSimulations: true },
    );
    expect(refused.statusCode, JSON.stringify(refused.body)).toBe(400);
    // The sentence says what to do about it rather than naming a constraint.
    expect(String(refused.body.message)).toContain("platform identity and key");
    expect(String(refused.body.message)).toContain(
      "Connect the agent to its platform first",
    );
  });

  it("turns on for an agent that holds its platform key, and reads back", async () => {
    const { key } = await aCustomer("tick_contract_on");

    const registered = await ask(api.app, "POST", "/v1/agents", key, {
      agentPlatform: "retell",
      name: "Front desk",
      connection: { ...RETELL_CHAT, platformAgentId: "agent_in_retell_1" },
    });
    expect(registered.statusCode, JSON.stringify(registered.body)).toBe(201);
    const agentId = (registered.body.agent as { id: string }).id;

    const ticked = await ask(api.app, "PATCH", `/v1/agents/${agentId}`, key, {
      mockToolsDuringSimulations: true,
    });
    expect(ticked.statusCode, JSON.stringify(ticked.body)).toBe(200);
    expect(
      (ticked.body.agent as { mockToolsDuringSimulations: boolean })
        .mockToolsDuringSimulations,
    ).toBe(true);

    const read = await ask(api.app, "GET", `/v1/agents/${agentId}`, key);
    expect(
      (read.body.agent as { mockToolsDuringSimulations: boolean })
        .mockToolsDuringSimulations,
    ).toBe(true);

    // A rename leaves it alone: a mocked world must never be turned off as the
    // side effect of an unrelated edit.
    const renamed = await ask(api.app, "PATCH", `/v1/agents/${agentId}`, key, {
      name: "Front desk, renamed",
    });
    expect(
      (renamed.body.agent as { mockToolsDuringSimulations: boolean })
        .mockToolsDuringSimulations,
    ).toBe(true);
  });

  it("refuses a value that is not true or false", async () => {
    const { key } = await aCustomer("tick_contract_bad_value");
    const registered = await ask(api.app, "POST", "/v1/agents", key, {
      agentPlatform: "retell",
      name: "Front desk",
    });
    const agentId = (registered.body.agent as { id: string }).id;

    const refused = await ask(api.app, "PATCH", `/v1/agents/${agentId}`, key, {
      mockToolsDuringSimulations: "yes",
    });
    expect(refused.statusCode).toBe(400);
  });
});

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

describe("the world a run built, through the API", () => {
  it("is null on a run that built none, and reports itself when it did", async () => {
    const { ada, key } = await aCustomer("mocked_world_contract");

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
    expect(before.body.mockedWorld).toBeNull();

    const world: MockedWorld = {
      servingVersion: 105,
      draftVersion: 106,
      engine: {
        type: "conversation-flow",
        engineId: "conversation_flow_2346a0e8367c",
        version: 106,
      },
      numbers: [
        {
          number: "+14155550199",
          pinned: true,
          bindings: [
            {
              agent_id: "agent_in_retell_1",
              agent_version: "latest",
              weight: 2,
              a_field_egma_has_never_heard_of: "keep me",
            },
          ],
        },
      ],
      coverage: {
        mocked: ["get_availability"],
        notInterceptable: ["transfer_to_front_desk"],
        notInThisVersion: ["inventory"],
      },
    };
    await recordMockedWorld(contextFor(ada, "member"), runId, world);

    const after = await ask(api.app, "GET", `/v1/runs/${runId}`, key);
    expect(after.statusCode, JSON.stringify(after.body)).toBe(200);
    // The temporary version, and the routing egma promised to put back —
    // sibling fields it never read included.
    expect(after.body.mockedWorld).toEqual(world);
  });
});
