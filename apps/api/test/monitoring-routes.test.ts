import {
  claimDueRetellMonitoringAgent,
  finishRetellMonitoringScan,
  recordRetellIngestionFailure,
} from "@egma/db";
import { afterEach, describe, expect, it } from "vitest";

import { createApi, type TestApi } from "./support/api.ts";
import { colleagueOf, signUp } from "./support/traces.ts";

let api: TestApi;

afterEach(async () => {
  await api?.close();
});

const RETELL_KEY = "key_live_monitoring_route_secret_QRST";

function provider(
  options: {
    readonly historyStatus?: number;
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
      return new Response(
        options.historyStatus === undefined
          ? JSON.stringify({ items: [], has_more: false })
          : JSON.stringify({ message: `do not log ${RETELL_KEY}` }),
        { status: options.historyStatus ?? 200 },
      );
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

describe("platform-first Monitoring setup", () => {
  it("discovers voice agents, proves call-history access, and stores one sealed key", async () => {
    const retell = provider();
    const logs: string[] = [];
    api = await createApi("monitoring_routes_retell", {
      retellFetch: retell.fetchImpl,
      logTo: { write: (line) => logs.push(line) },
    });
    const ada = await signUp(api.app, "ada@acme.example", "Acme");

    const discovered = await api.app.inject({
      method: "POST",
      url: `/api/monitoring/retell/discover?project=${ada.projectId}`,
      headers: { cookie: ada.cookie },
      payload: { api_key: RETELL_KEY },
    });
    expect(discovered.statusCode, discovered.body).toBe(200);
    expect(discovered.json()).toEqual({
      agents: [{ id: "agent_voice_1", name: "Front desk from Retell" }],
    });

    const configured = await api.app.inject({
      method: "PUT",
      url: `/api/monitoring/retell?project=${ada.projectId}`,
      headers: { cookie: ada.cookie },
      payload: {
        api_key: RETELL_KEY,
        agents: [{ id: "agent_voice_1", name: "A browser cannot rename it" }],
      },
    });
    expect(configured.statusCode, configured.body).toBe(200);
    expect(configured.json()).toMatchObject({
      setup: {
        agent_platform: "retell",
        strategy: "retell_api_polling",
        credentials_hint: "QRST",
        agents: [
          {
            platform_agent_id: "agent_voice_1",
            platform_agent_name: "Front desk from Retell",
            state: "importing",
          },
        ],
      },
    });
    expect(configured.body).not.toContain(RETELL_KEY);

    const calls = retell.asked.filter(
      (request) => new URL(request.url).pathname === "/v3/list-calls",
    );
    expect(calls).toHaveLength(1);
    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({
      filter_criteria: {
        agent: [{ agent_id: "agent_voice_1" }],
        call_status: {
          value: ["ended", "error", "not_connected"],
        },
      },
      limit: 1,
    });

    const listed = await api.app.inject({
      method: "GET",
      url: `/api/monitoring?project=${ada.projectId}`,
      headers: { cookie: ada.cookie },
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.body).not.toContain(RETELL_KEY);

    const stored = await api.database.sql<{ credentials: string }>(
      "select credentials from monitoring_setup",
    );
    expect(stored.rows[0]?.credentials.startsWith("v1.")).toBe(true);
    expect(stored.rows[0]?.credentials).not.toContain(RETELL_KEY);
    expect(logs.join("\n")).not.toContain(RETELL_KEY);
  });

  it("does not save a key that cannot read Retell call history", async () => {
    const retell = provider({ historyStatus: 403 });
    api = await createApi("monitoring_routes_history_scope", {
      retellFetch: retell.fetchImpl,
    });
    const ada = await signUp(api.app, "ada@acme.example", "Acme");

    const configured = await api.app.inject({
      method: "PUT",
      url: `/api/monitoring/retell?project=${ada.projectId}`,
      headers: { cookie: ada.cookie },
      payload: {
        api_key: RETELL_KEY,
        agents: [{ id: "agent_voice_1", name: "Front desk" }],
      },
    });

    expect(configured.statusCode).toBe(422);
    expect(configured.json()).toMatchObject({
      error: "unprocessable",
      message: expect.stringContaining("Monitor or History Read"),
    });
    const stored = await api.database.sql<{ count: string }>(
      "select count(*) as count from monitoring_setup",
    );
    expect(stored.rows[0]?.count).toBe("0");
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

    for (const request of [
      {
        method: "POST" as const,
        url: `/api/monitoring/retell/discover?project=${ada.projectId}`,
        payload: { api_key: RETELL_KEY },
      },
      {
        method: "PUT" as const,
        url: `/api/monitoring/retell?project=${ada.projectId}`,
        payload: {
          api_key: RETELL_KEY,
          agents: [{ id: "agent_voice_1", name: "Front desk" }],
        },
      },
    ]) {
      const refused = await api.app.inject({
        ...request,
        headers: { cookie: viewer.cookie },
      });
      expect(refused.statusCode, refused.body).toBe(403);
    }
    expect(retell.asked).toEqual([]);
  });

  it("replays one exact durable Retell failure outside the list window", async () => {
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
    const configured = await api.app.inject({
      method: "PUT",
      url: `/api/monitoring/retell?project=${ada.projectId}`,
      headers: { cookie: ada.cookie },
      payload: {
        api_key: RETELL_KEY,
        agents: [{ id: "agent_voice_1", name: "Front desk" }],
      },
    });
    expect(configured.statusCode, configured.body).toBe(200);

    const target = await claimDueRetellMonitoringAgent({ now: new Date() });
    expect(target).toBeDefined();
    if (target === undefined) return;
    await recordRetellIngestionFailure(target.auth, target, {
      providerCallId,
      errorKind: "provider_call_not_found",
      now: new Date(),
    });
    await finishRetellMonitoringScan(target.auth, target, { now: new Date() });

    const before = await api.app.inject({
      method: "GET",
      url: `/api/monitoring?project=${ada.projectId}`,
      headers: { cookie: ada.cookie },
    });
    const failure = before.json().setups[0].agents[0].failures[0] as {
      id: string;
      provider_call_id: string;
    };
    expect(failure.provider_call_id).toBe(providerCallId);

    const replayed = await api.app.inject({
      method: "POST",
      url:
        `/api/monitoring/retell/failures/${failure.id}/replay` +
        `?project=${ada.projectId}`,
      headers: { cookie: ada.cookie },
    });
    expect(replayed.statusCode, replayed.body).toBe(200);
    expect(replayed.json()).toMatchObject({
      failure: { id: failure.id, status: "resolved" },
      trace: { write: "written" },
    });
    const repeated = await api.app.inject({
      method: "POST",
      url:
        `/api/monitoring/retell/failures/${failure.id}/replay` +
        `?project=${ada.projectId}`,
      headers: { cookie: ada.cookie },
    });
    expect(repeated.statusCode).toBe(404);

    const paths = retell.asked.map((request) => new URL(request.url).pathname);
    expect(paths.filter((path) => path === "/v3/list-calls")).toHaveLength(1);
    expect(
      paths.filter((path) => path === `/v2/get-call/${providerCallId}`),
    ).toHaveLength(1);
    const stored = await api.database.sql<{
      claims: string;
      open_failures: string;
    }>(
      "select " +
        "(select count(*) from production_trace_claim) as claims, " +
        "(select count(*) from retell_ingestion_failure where status = 'open') as open_failures",
    );
    expect(stored.rows[0]).toEqual({ claims: "1", open_failures: "0" });

    const after = await api.app.inject({
      method: "GET",
      url: `/api/monitoring?project=${ada.projectId}`,
      headers: { cookie: ada.cookie },
    });
    expect(after.json().setups[0].agents[0]).toMatchObject({
      state: "active",
      failures: [],
    });
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
    const configured = await api.app.inject({
      method: "PUT",
      url: `/api/monitoring/retell?project=${ada.projectId}`,
      headers: { cookie: ada.cookie },
      payload: {
        api_key: RETELL_KEY,
        agents: [{ id: "agent_voice_1", name: "Front desk" }],
      },
    });
    expect(configured.statusCode, configured.body).toBe(200);

    const target = await claimDueRetellMonitoringAgent({ now: new Date() });
    expect(target).toBeDefined();
    if (target === undefined) return;
    await recordRetellIngestionFailure(target.auth, target, {
      providerCallId,
      errorKind: "provider_call_not_found",
      now: new Date(),
    });
    await finishRetellMonitoringScan(target.auth, target, { now: new Date() });
    const listed = await api.app.inject({
      method: "GET",
      url: `/api/monitoring?project=${ada.projectId}`,
      headers: { cookie: ada.cookie },
    });
    const failureId = listed.json().setups[0].agents[0].failures[0].id as string;
    const replayUrl =
      `/api/monitoring/retell/failures/${failureId}/replay` +
      `?project=${ada.projectId}`;

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

  it("creates and removes the separate LiveKit Agents setup", async () => {
    api = await createApi("monitoring_routes_livekit");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");

    const configured = await api.app.inject({
      method: "PUT",
      url: `/api/monitoring/livekit-agents?project=${ada.projectId}`,
      headers: { cookie: ada.cookie },
    });
    expect(configured.statusCode, configured.body).toBe(200);
    expect(configured.json()).toMatchObject({
      setup: {
        agent_platform: "livekit_agents",
        strategy: "livekit_otlp",
        credentials_hint: null,
        agents: [],
      },
    });

    const removed = await api.app.inject({
      method: "DELETE",
      url: `/api/monitoring/livekit-agents?project=${ada.projectId}`,
      headers: { cookie: ada.cookie },
    });
    expect(removed.statusCode).toBe(204);

    const listed = await api.app.inject({
      method: "GET",
      url: `/api/monitoring?project=${ada.projectId}`,
      headers: { cookie: ada.cookie },
    });
    expect(listed.json()).toEqual({ setups: [] });
  });
});
