import { newId } from "@egma/ids";
import {
  createPersona,
  discardingUsageSink,
  openBillingPlugIn,
  openEntitlementSource,
  type EntitlementSource,
  type StartRequest,
} from "@egma/db";
import { afterEach, describe, expect, it } from "vitest";

import { CLAIMS_PATH } from "../src/routes/claims.ts";
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
 * What the claim door asks the deployment before it hands work out.
 *
 * The rule the spec sets for this path is about *shape* rather than about any
 * answer: once per organization per batch, never per simulation, never in a
 * way that serialises claims. So the adapters here are written in the test —
 * one that writes down what it was asked, one that refuses a kind of work, and
 * one that will not answer for the first customer until the second customer's
 * question has arrived, which is a deadlock unless the questions really are
 * asked at the same time.
 */

let api: TestApi;

afterEach(async () => {
  await api?.close();
});

const RESCHEDULING = {
  name: "Reschedules a booked appointment",
  scenario:
    "Their cleaning is booked for Thursday morning and has to move to any afternoon next week.",
  expectedBehaviors: ["confirms the new time back before finishing"],
} as const;

const RETELL_CHAT = {
  agentPlatform: "retell",
  connectionType: "retell_chat_api",
  accessVariant: "retell_chat_api.api_key",
  modality: "chat",
  config: { retellAgentId: "agent_in_retell_1" },
  credentials: { apiKey: "retell-secret-A1B2C3D4WXYZ" },
} as const;

const LIVEKIT_ROOM = {
  agentPlatform: "livekit",
  connectionType: "livekit_room",
  accessVariant: "livekit_room.project_credentials",
  modality: "voice",
  config: { url: "wss://acme.livekit.cloud", agentName: "front-desk" },
  credentials: {
    apiKey: "livekit-key-A1B2C3D4WXYZ",
    apiSecret: "livekit-secret-E5F6G7H8QRST",
  },
} as const;

/** The Retell chat target these tests conduct against. */
const RETELL_CHAT_FETCH: typeof fetch = async (input) => {
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

/** An entitlement source that writes down every question it was asked. */
function recording(
  answer: (request: StartRequest) => Awaited<
    ReturnType<EntitlementSource["mayStart"]>
  > = () => ({ allowed: true }),
): { readonly asked: StartRequest[]; readonly source: EntitlementSource } {
  const asked: StartRequest[] = [];
  return {
    asked,
    source: {
      mayStart(request) {
        asked.push(request);
        return Promise.resolve(answer(request));
      },
      mayPlatformKeyFund: openEntitlementSource().mayPlatformKeyFund,
    },
  };
}

/** One customer with a queued conversation on each lane the test names. */
async function aCustomerWithQueuedWork(
  email: string,
  organizationName: string,
  lanes: readonly (typeof RETELL_CHAT | typeof LIVEKIT_ROOM)[],
): Promise<{ customer: Customer; simulations: string[] }> {
  const customer = await signUp(api.app, email, organizationName);
  const key = await projectKeyFor(api.app, customer);
  await createPersona(contextFor(customer, "member"), {
    name: "Impatient Rita",
    ...NEUTRAL_PERSON,
  });

  const simulations: string[] = [];
  for (const [index, connection] of lanes.entries()) {
    const registered = await ask(api.app, "POST", "/v1/agents", key, {
      agentPlatform: connection.agentPlatform,
      name: `Desk ${index + 1}`,
      connection,
    });
    expect(registered.statusCode, JSON.stringify(registered.body)).toBe(201);
    const agentId = (registered.body.agent as { id: string }).id;
    const connectionId = (registered.body.connection as { id: string }).id;

    const suite = await ask(api.app, "POST", "/v1/test-suites", key, {
      name: `Appointment changes ${index + 1}`,
    });
    expect(suite.statusCode, JSON.stringify(suite.body)).toBe(201);
    const pushed = await ask(api.app, "POST", "/v1/tests", key, {
      ...RESCHEDULING,
      suiteId: String(suite.body.id),
      personas: ["Impatient Rita"],
    });
    expect(pushed.statusCode, JSON.stringify(pushed.body)).toBe(201);

    const started = await ask(api.app, "POST", "/v1/runs", key, {
      suiteId: String(suite.body.id),
      agentId,
      connectionId,
    });
    expect(started.statusCode, JSON.stringify(started.body)).toBe(201);

    const page = await ask(
      api.app,
      "GET",
      `/v1/runs/${String(started.body.id)}/simulations?pageSize=10`,
      key,
    );
    expect(page.statusCode, JSON.stringify(page.body)).toBe(200);
    for (const one of page.body.simulations as { id: string }[]) {
      simulations.push(one.id);
    }
  }
  return { customer, simulations };
}

/** One claim, as the simulator makes it. */
async function claim(capacity: number): Promise<Record<string, unknown>> {
  const response = await api.app.inject({
    method: "POST",
    url: CLAIMS_PATH,
    headers: { authorization: `Bearer ${api.config.simulatorServiceToken}` },
    payload: {
      contract_versions: [5],
      claimant: "sim-1",
      capacity,
      wait_seconds: 0,
    },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json() as Record<string, unknown>;
}

async function statusOf(
  api_: TestApi,
  simulationId: string,
): Promise<{ status: string; claimed_by: string | null }> {
  const { rows } = await api_.database.sql<{
    status: string;
    claimed_by: string | null;
  }>("select status, claimed_by from simulation where id = $1", [simulationId]);
  const row = rows[0];
  if (row === undefined) throw new Error("no such simulation");
  return row;
}

describe("what the claim door asks the deployment", () => {
  it("asks once for the customer, naming every kind of work in the batch", async () => {
    const listener = recording();
    api = await createApi("claims_entitlement_once", {
      retellFetch: RETELL_CHAT_FETCH,
      billing: { ...openBillingPlugIn(), entitlements: listener.source, usage: discardingUsageSink() },
    });
    const ada = await aCustomerWithQueuedWork("ada@acme.example", "Acme", [
      RETELL_CHAT,
      LIVEKIT_ROOM,
    ]);

    const answer = await claim(10);
    expect(answer.specs).toHaveLength(2);

    // One question, not one per conversation, naming both kinds of work.
    expect(listener.asked).toEqual([
      {
        organizationId: ada.customer.organizationId,
        allowances: ["chat_simulations", "web_call_minutes"],
      },
    ]);
  });

  it("asks once per customer when a batch spans several of them", async () => {
    const listener = recording();
    api = await createApi("claims_entitlement_per_customer", {
      retellFetch: RETELL_CHAT_FETCH,
      billing: { ...openBillingPlugIn(), entitlements: listener.source, usage: discardingUsageSink() },
    });
    const ada = await aCustomerWithQueuedWork("ada@acme.example", "Acme", [
      RETELL_CHAT,
    ]);
    const bob = await aCustomerWithQueuedWork("bob@globex.example", "Globex", [
      RETELL_CHAT,
    ]);

    const answer = await claim(10);
    expect(answer.specs).toHaveLength(2);

    expect(listener.asked).toHaveLength(2);
    expect(
      listener.asked.map((request) => request.organizationId).sort(),
    ).toEqual(
      [ada.customer.organizationId, bob.customer.organizationId].sort(),
    );
  });

  it("puts a refused conversation back on the queue and hands out the rest", async () => {
    api = await createApi("claims_entitlement_withheld", {
      retellFetch: RETELL_CHAT_FETCH,
      billing: {
        ...openBillingPlugIn(),
        entitlements: {
          mayStart: () =>
            Promise.resolve({
              allowed: false,
              refusals: [
                {
                  allowance: "web_call_minutes",
                  resetsAt: new Date("2026-10-15T08:00:00.000Z"),
                  message:
                    "This organization has used all of its web-call minutes.",
                },
              ],
            }),
          mayPlatformKeyFund: openEntitlementSource().mayPlatformKeyFund,
        },
        usage: discardingUsageSink(),
      },
    });
    const ada = await aCustomerWithQueuedWork("ada@acme.example", "Acme", [
      RETELL_CHAT,
      LIVEKIT_ROOM,
    ]);

    const answer = await claim(10);
    const specs = answer.specs as { simulation_id: string }[];

    // The chat conversation went out; the web call did not. A refusal of one
    // kind never withholds another.
    expect(specs).toHaveLength(1);
    const handedOut = specs[0]?.simulation_id ?? "";
    const withheldId = ada.simulations.find((id) => id !== handedOut) ?? "";

    // **Queued, not failed.** Nothing is wrong with it: it runs when the month
    // resets, the plan changes or credit arrives.
    expect(await statusOf(api, withheldId)).toEqual({
      status: "queued",
      claimed_by: null,
    });
    expect((await statusOf(api, handedOut)).status).toBe("claimed");

    // And the next claim finds it still there to be offered again.
    const again = await claim(10);
    expect(again.specs).toHaveLength(0);
    expect((await statusOf(api, withheldId)).status).toBe("queued");
  });

  it("does not serialise one customer's claims behind another's answer", async () => {
    // **The proof is a deadlock that does not happen.** Acme's question is not
    // answered until Globex's has arrived. If the door asked one customer at a
    // time — a lock, a loop, a round trip each — this would never finish.
    const arrived = new Map<string, () => void>();
    const bothAsked = new Set<string>();
    let releaseAll: (() => void) | undefined;
    const everybodyHasAsked = new Promise<void>((resolve) => {
      releaseAll = resolve;
    });

    const entitlements: EntitlementSource = {
      async mayStart(request) {
        bothAsked.add(request.organizationId);
        arrived.get(request.organizationId)?.();
        if (bothAsked.size >= 2) releaseAll?.();
        await everybodyHasAsked;
        return { allowed: true };
      },
      mayPlatformKeyFund: openEntitlementSource().mayPlatformKeyFund,
    };

    api = await createApi("claims_entitlement_concurrent", {
      retellFetch: RETELL_CHAT_FETCH,
      billing: { ...openBillingPlugIn(), entitlements, usage: discardingUsageSink() },
    });
    await aCustomerWithQueuedWork("ada@acme.example", "Acme", [RETELL_CHAT]);
    await aCustomerWithQueuedWork("bob@globex.example", "Globex", [
      RETELL_CHAT,
    ]);

    const answer = await claim(10);

    // Both customers' conversations went out in the one batch, so the capacity
    // a simulator declares is still the whole of what decides how many run at
    // once.
    expect(answer.specs).toHaveLength(2);
    expect(bothAsked.size).toBe(2);
  });

  it("hands work out exactly as before when the deployment does not bill", async () => {
    // The acceptance criterion, stated: no billing configured, nothing asked
    // of anybody, and the claim is the claim it always was.
    api = await createApi("claims_entitlement_absent", {
      retellFetch: RETELL_CHAT_FETCH,
    });
    const ada = await aCustomerWithQueuedWork("ada@acme.example", "Acme", [
      RETELL_CHAT,
    ]);

    const answer = await claim(10);
    expect(answer.specs).toHaveLength(1);
    expect((await statusOf(api, ada.simulations[0] ?? "")).status).toBe(
      "claimed",
    );
  });
});

it("hands out claimed work when both billing checks fail", async () => {
  api = await createApi("claims_billing_outage", {
    retellFetch: RETELL_CHAT_FETCH,
    billing: { ...openBillingPlugIn(), entitlements: {
      mayStart: () => Promise.reject(new Error("billing unavailable")),
      mayPlatformKeyFund: () => Promise.reject(new Error("billing unavailable")),
    } },
  });
  await aCustomerWithQueuedWork("outage@acme.example", "Acme", [RETELL_CHAT]);
  expect((await claim(10)).specs).toHaveLength(1);
});
