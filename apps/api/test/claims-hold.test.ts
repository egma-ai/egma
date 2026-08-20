import { newId } from "@egma/ids";
import { createPersona, type AuthContext } from "@egma/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { NEUTRAL_TRAITS } from "./support/traces.ts";
import { startInstance, type Instance } from "./support/instance.ts";

/**
 * The held claim, over a real socket.
 *
 * The rest of the claim door's suite drives the API in process, and that is
 * the right altitude for everything except the hold — because the hold's one
 * moving part is the connection itself. The route watches the socket to stop
 * claiming for a client that hung up, and a socket is exactly what an
 * injected request does not have: the in-process harness never emits the
 * lifecycle events a real connection does, so only a listening server can
 * prove the hold survives them. A request's own `close` fires when its body
 * has been read — milliseconds in, client still there — and a hold that
 * mistook that for the client leaving would answer every empty-queue claim
 * at once, turning the simulator's patient long poll into a busy loop.
 *
 * So: a real port, a real HTTP client, and the two promises measured on a
 * clock — a short `wait_seconds` really holds, and work arriving mid-hold
 * really answers.
 */

/** The value `startInstance` configures the API with. */
const SERVICE_TOKEN = "egma_st_held-by-this-test-suite-alone";

/** The direct Retell fixture in this socket test is a chat agent. */
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

let instance: Instance;

/** Somebody with a key, an agent, and a test — everything a run needs. */
let key: string;
let connectionId: string;
let versionId: string;

async function api(
  method: "GET" | "POST",
  path: string,
  headers: Record<string, string>,
  payload?: unknown,
): Promise<{ status: number; body: Record<string, unknown>; setCookie: string }> {
  const response = await fetch(`${instance.origin}${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
    setCookie: response.headers.get("set-cookie") ?? "",
  };
}

/** One claim as the simulator makes it: a real request over a real socket. */
async function claim(
  body: Record<string, unknown>,
): Promise<{ elapsed: number; status: number; specs: unknown[] }> {
  const asked = Date.now();
  const response = await fetch(`${instance.origin}/v1/claims`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${SERVICE_TOKEN}`,
    },
    body: JSON.stringify({ contract_versions: [3], ...body }),
  });
  const answered = (await response.json()) as { specs: unknown[] };
  return {
    elapsed: Date.now() - asked,
    status: response.status,
    specs: answered.specs,
  };
}

async function aQueuedRun(): Promise<void> {
  const started = await api(
    "POST",
    "/api/runs",
    { authorization: `Bearer ${key}` },
    {
      connection: connectionId,
      test_versions: [versionId],
      idempotency_key: newId("run"),
    },
  );
  expect(started.status, JSON.stringify(started.body)).toBe(201);
}

beforeAll(async () => {
  instance = await startInstance("claims_hold", {
    web: false,
    retellFetch: RETELL_CHAT_FETCH,
  });

  const signedUp = await api("POST", "/api/signup", {}, {
    email: "ada@acme.example",
    password: "a-long-enough-password",
    organizationName: "Acme",
  });
  expect(signedUp.status, JSON.stringify(signedUp.body)).toBe(201);
  const cookie = signedUp.setCookie.split(";", 1)[0] ?? "";
  const landed = signedUp.body as unknown as {
    userId: string;
    organization: { id: string };
    project: { id: string };
  };

  const minted = await api(
    "POST",
    "/api/keys",
    { cookie },
    { name: "a terminal", project_id: landed.project.id },
  );
  expect(minted.status, JSON.stringify(minted.body)).toBe(201);
  key = String(minted.body.secret);

  const registered = await api(
    "POST",
    "/api/agents",
    { authorization: `Bearer ${key}` },
    {
      name: "Front desk",
      connection: {
        agent_platform: "retell",
        connection_kind: "retell_chat_api",
        access_variant: "retell_chat_api.api_key",
        modality: "chat",
        config: { retellAgentId: "agent_in_retell_1" },
        credentials: { apiKey: "retell-secret-A1B2C3D4WXYZ" },
      },
    },
  );
  expect(registered.status, JSON.stringify(registered.body)).toBe(201);
  connectionId = (registered.body.connection as { id: string }).id;

  // The persona is authored at the seam — no route ships for one — which the
  // in-process half of this instance makes reachable.
  const author: AuthContext = {
    userId: landed.userId,
    organizationId: landed.organization.id,
    projectId: landed.project.id,
    role: "member",
    via: "session",
  };
  await createPersona(author, {
    name: "Impatient Rita",
    traits: NEUTRAL_TRAITS,
  });

  const pushed = await api(
    "POST",
    "/api/tests",
    { authorization: `Bearer ${key}` },
    {
      name: "Reschedules a booked appointment",
      scenario:
        "Their cleaning is booked for Thursday morning and has to move to any afternoon next week.",
      expected_behaviors: ["confirms the new time back before finishing"],
      personas: ["Impatient Rita"],
    },
  );
  expect(pushed.status, JSON.stringify(pushed.body)).toBe(201);
  versionId = String(pushed.body.version_id);
});

afterAll(async () => {
  await instance?.close();
});

describe("the held claim, over a real socket", () => {
  it("holds an empty-queue claim for the client's own wait, and no less", async () => {
    const answered = await claim({
      claimant: "sim-under-test",
      capacity: 1,
      wait_seconds: 2,
    });

    expect(answered.status).toBe(200);
    expect(answered.specs).toEqual([]);
    // The whole point of asking over a real connection: a hold that mistook
    // the request finishing for the client leaving answers in milliseconds,
    // and this is where that reads as a failure rather than as speed.
    expect(answered.elapsed).toBeGreaterThanOrEqual(1_900);
    expect(answered.elapsed).toBeLessThan(8_000);
  });

  it("answers a patient client within about a second of work arriving", async () => {
    const holding = claim({
      claimant: "sim-under-test",
      capacity: 4,
      wait_seconds: 20,
    });

    // Work arrives while the claim is being held open.
    await new Promise((resume) => setTimeout(resume, 400));
    await aQueuedRun();

    const answered = await holding;
    expect(answered.status).toBe(200);
    expect(answered.specs).toHaveLength(1);
    // Held until the queue filled — never answered empty before it did —
    // and answered on the ~1s re-check rather than sitting out the twenty
    // seconds asked for.
    expect(answered.elapsed).toBeGreaterThanOrEqual(400);
    expect(answered.elapsed).toBeLessThan(8_000);
  });
});
