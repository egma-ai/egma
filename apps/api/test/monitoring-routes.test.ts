import {
  claimDueMonitoringPull,
  createAgent,
  enablePullProductionCalls,
  finishMonitoringScan,
  listMonitoringFailures,
  recordMonitoringFailure,
  type AuthContext,
} from "@egma/db";
import { afterEach, describe, expect, it } from "vitest";

import { createApi, type TestApi } from "./support/api.ts";
import { colleagueOf, signUp } from "./support/traces.ts";

/**
 * What is left of the Monitoring routes once the setup object is gone.
 *
 * The per-platform setup routes went with the tables they named: pull is
 * declared on the agent, and the flow that turns it on is ticket 02's. Two
 * routes survive the change, because neither one is about a setup row —
 * discovery asks Retell what a key can see, and replay is the customer's
 * explicit retry of one poison call.
 */

let api: TestApi;

afterEach(async () => {
  await api?.close();
});

const RETELL_KEY = "key_live_monitoring_route_secret_QRST";

function provider(
  options: {
    readonly getCall?: Record<string, unknown>;
    readonly getCallStatus?: number;
    readonly getCallHeaders?: Readonly<Record<string, string>>;
  } = {},
) {
  const asked: { readonly url: string; readonly init: RequestInit }[] = [];
  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = String(input);
    asked.push({ url, init: init ?? {} });
    if (new URL(url).pathname === "/v2/list-agents") {
      return new Response(
        JSON.stringify({
          items: [
            {
              agent_id: "agent_voice_1",
              agent_name: "Front desk from Retell",
              channel: "voice",
            },
            {
              agent_id: "agent_chat_1",
              agent_name: "Chat support",
              channel: "chat",
            },
          ],
          has_more: false,
        }),
        { status: 200 },
      );
    }
    if (new URL(url).pathname === "/v3/list-calls") {
      return new Response(JSON.stringify({ items: [], has_more: false }), {
        status: 200,
      });
    }
    if (new URL(url).pathname.startsWith("/v2/get-call/")) {
      if (options.getCallStatus !== undefined) {
        return new Response("provider refusal", {
          status: options.getCallStatus,
          ...(options.getCallHeaders === undefined
            ? {}
            : { headers: options.getCallHeaders }),
        });
      }
      return options.getCall === undefined
        ? new Response("not found", { status: 404 })
        : new Response(JSON.stringify(options.getCall), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { asked, fetchImpl };
}

function at(signedUp: {
  readonly userId: string;
  readonly organizationId: string;
  readonly projectId: string;
}): AuthContext {
  return {
    userId: signedUp.userId,
    organizationId: signedUp.organizationId,
    projectId: signedUp.projectId,
    role: "admin",
    via: "session",
  };
}

/** One agent, bound to Retell with its own key and its pull switch on. */
async function pulling(signedUp: Parameters<typeof at>[0]): Promise<string> {
  const auth = at(signedUp);
  const created = await createAgent(auth, { name: "Front desk" });
  await enablePullProductionCalls(auth, {
    agentId: created.id,
    agentPlatform: "retell",
    platformAgentId: "agent_voice_1",
    apiKey: RETELL_KEY,
  });
  return created.id;
}

/** Poll once, record one poison call against it, and let the scan finish. */
async function poisoned(providerCallId: string): Promise<void> {
  const target = await claimDueMonitoringPull({ now: new Date() });
  expect(target).toBeDefined();
  if (target === undefined) return;
  await recordMonitoringFailure(target.auth, target, {
    providerCallId,
    errorKind: "provider_call_not_found",
    now: new Date(),
  });
  await finishMonitoringScan(target.auth, target, { now: new Date() });
}

describe("discovering what a Retell key can see", () => {
  it("answers voice agents only, and never echoes the key", async () => {
    const retell = provider();
    const logs: string[] = [];
    api = await createApi("monitoring_routes_retell", {
      retellFetch: retell.fetchImpl,
      logTo: { write: (line) => logs.push(line) },
    });
    const ada = await signUp(api.app, "ada@acme.example", "Acme");

    const discovered = await api.app.inject({
      method: "POST",
      url: `/v1/monitoring/retell/discover?projectId=${ada.projectId}`,
      headers: { cookie: ada.cookie },
      payload: { apiKey: RETELL_KEY },
    });

    expect(discovered.statusCode, discovered.body).toBe(200);
    expect(discovered.json()).toEqual({
      agents: [{ id: "agent_voice_1", name: "Front desk from Retell" }],
    });
    expect(discovered.body).not.toContain(RETELL_KEY);
    expect(logs.join("\n")).not.toContain(RETELL_KEY);
  });

  it("refuses a viewer before any Retell provider read", async () => {
    const retell = provider();
    api = await createApi("monitoring_routes_viewer", {
      retellFetch: retell.fetchImpl,
    });
    const ada = await signUp(api.app, "ada-owner@acme.example", "Acme");
    const viewer = await colleagueOf(
      api.app,
      ada,
      "grace-viewer@acme.example",
      "viewer",
    );

    const refused = await api.app.inject({
      method: "POST",
      url: `/v1/monitoring/retell/discover?projectId=${ada.projectId}`,
      headers: { cookie: viewer.cookie },
      payload: { apiKey: RETELL_KEY },
    });

    expect(refused.statusCode, refused.body).toBe(403);
    expect(retell.asked).toEqual([]);
  });
});

describe("the setup routes the redesign removed", () => {
  it("are gone: there is no monitoring source to list, save or delete", async () => {
    api = await createApi("monitoring_routes_removed");
    const ada = await signUp(api.app, "ada-removed@acme.example", "Acme");

    for (const request of [
      { method: "GET" as const, url: `/v1/monitoring?projectId=${ada.projectId}` },
      {
        method: "PUT" as const,
        url: `/v1/monitoring/retell?projectId=${ada.projectId}`,
      },
      {
        method: "PUT" as const,
        url: `/v1/monitoring/livekit-agents?projectId=${ada.projectId}`,
      },
      {
        method: "DELETE" as const,
        url: `/v1/monitoring/livekit-agents?projectId=${ada.projectId}`,
      },
    ]) {
      const answered = await api.app.inject({
        ...request,
        headers: { cookie: ada.cookie },
      });
      expect(answered.statusCode, `${request.method} ${request.url}`).toBe(404);
    }
  });
});

describe("replaying one poison call", () => {
  it("fetches the exact call, writes it, and closes the failure", async () => {
    const providerCallId = "call_from_2020_exact_replay";
    const retell = provider({
      getCall: {
        call_id: providerCallId,
        agent_id: "agent_voice_1",
        agent_name: "Historical front desk name",
        agent_version: 2,
        call_status: "ended",
        call_type: "phone_call",
        start_timestamp: Date.parse("2020-01-01T00:00:00.000Z"),
        end_timestamp: Date.parse("2020-01-01T00:01:00.000Z"),
        transcript_with_tool_calls: [
          { role: "agent", content: "Hello" },
          { role: "user", content: "I need help" },
        ],
      },
    });
    api = await createApi("monitoring_routes_exact_replay", {
      retellFetch: retell.fetchImpl,
      traceStore: true,
    });
    const ada = await signUp(api.app, "ada-replay@acme.example", "Acme");
    const agentId = await pulling(ada);
    await poisoned(providerCallId);

    const [failure] = await listMonitoringFailures(at(ada), agentId);
    expect(failure?.providerCallId).toBe(providerCallId);

    const replayUrl =
      `/v1/monitoring/retell/failures/${failure?.id}/replay` +
      `?projectId=${ada.projectId}`;
    const replayed = await api.app.inject({
      method: "POST",
      url: replayUrl,
      headers: { cookie: ada.cookie },
    });
    expect(replayed.statusCode, replayed.body).toBe(200);
    expect(replayed.json()).toMatchObject({
      monitoringImportFailure: { id: failure?.id, status: "resolved" },
      trace: { write: "written" },
    });

    // A resolved failure is nobody's to replay a second time.
    const repeated = await api.app.inject({
      method: "POST",
      url: replayUrl,
      headers: { cookie: ada.cookie },
    });
    expect(repeated.statusCode).toBe(404);

    const paths = retell.asked.map((request) => new URL(request.url).pathname);
    expect(
      paths.filter((path) => path === `/v2/get-call/${providerCallId}`),
    ).toHaveLength(1);

    const stored = await api.database.sql<{
      claims: string;
      open_failures: string;
    }>(
      "select " +
        "(select count(*) from production_trace_claim) as claims, " +
        "(select count(*) from monitoring_failure where status = 'open') as open_failures",
    );
    expect(stored.rows[0]).toEqual({ claims: "1", open_failures: "0" });
    expect(await listMonitoringFailures(at(ada), agentId)).toHaveLength(0);
  });

  it("does not call Retell again while a replay Retry-After gate is active", async () => {
    const providerCallId = "call_rate_limited_exact_replay";
    const retell = provider({
      getCallStatus: 429,
      getCallHeaders: { "retry-after": "60" },
    });
    api = await createApi("monitoring_routes_replay_retry_after", {
      retellFetch: retell.fetchImpl,
    });
    const ada = await signUp(api.app, "ada-retry-after@acme.example", "Acme");
    const agentId = await pulling(ada);
    await poisoned(providerCallId);

    const [failure] = await listMonitoringFailures(at(ada), agentId);
    const replayUrl =
      `/v1/monitoring/retell/failures/${failure?.id}/replay` +
      `?projectId=${ada.projectId}`;

    const first = await api.app.inject({
      method: "POST",
      url: replayUrl,
      headers: { cookie: ada.cookie },
    });
    expect(first.statusCode, first.body).toBe(429);
    const second = await api.app.inject({
      method: "POST",
      url: replayUrl,
      headers: { cookie: ada.cookie },
    });
    expect(second.statusCode, second.body).toBe(429);

    const getCalls = retell.asked.filter(
      (request) =>
        new URL(request.url).pathname === `/v2/get-call/${providerCallId}`,
    );
    expect(getCalls).toHaveLength(1);
  });
});
