import { afterAll, afterEach, describe, expect, it } from "vitest";

import { createApi, type TestApi } from "./support/api.ts";
import {
  startObjectStorage,
  type ObjectStorage,
} from "./support/object-storage.ts";
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

/**
 * The one case here that files evidence at the door needs somewhere for that
 * evidence to become durable — Monitoring's "last heard from" is written where
 * a segment is drained. Every other case in this file talks to a Retell-shaped
 * server on loopback and needs no container.
 */
const storage: ObjectStorage = await startObjectStorage("monitoring-routes");

if (!storage.available) {
  process.stderr.write(
    `\nskipping the Monitoring last-received case — ${storage.why}\n\n`,
  );
}

function running(): Extract<ObjectStorage, { available: true }> {
  if (!storage.available) throw new Error("this suite has no object store");
  return storage;
}

afterAll(() => {
  if (storage.available) storage.stop();
});

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
      url: `/v1/monitoring/retell/discover?projectId=${ada.projectId}`,
      headers: { cookie: ada.cookie },
      payload: { apiKey: RETELL_KEY },
    });
    expect(discovered.statusCode, discovered.body).toBe(200);
    expect(discovered.json()).toEqual({
      agents: [{ id: "agent_voice_1", name: "Front desk from Retell" }],
    });

    const configured = await api.app.inject({
      method: "PUT",
      url: `/v1/monitoring/retell?projectId=${ada.projectId}`,
      headers: { cookie: ada.cookie },
      payload: {
        apiKey: RETELL_KEY,
        agents: [{ id: "agent_voice_1", name: "A browser cannot rename it" }],
      },
    });
    expect(configured.statusCode, configured.body).toBe(200);
    expect(configured.json()).toMatchObject({
      monitoringSource: {
        agentPlatform: "retell",
        strategy: "retell_api_polling",
        credentialsHint: "QRST",
        agents: [
          {
            platformAgentId: "agent_voice_1",
            platformAgentName: "Front desk from Retell",
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
      url: `/v1/monitoring?projectId=${ada.projectId}`,
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
      url: `/v1/monitoring/retell?projectId=${ada.projectId}`,
      headers: { cookie: ada.cookie },
      payload: {
        apiKey: RETELL_KEY,
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
        url: `/v1/monitoring/retell/discover?projectId=${ada.projectId}`,
        payload: { apiKey: RETELL_KEY },
      },
      {
        method: "PUT" as const,
        url: `/v1/monitoring/retell?projectId=${ada.projectId}`,
        payload: {
          apiKey: RETELL_KEY,
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

  it("creates and removes the separate LiveKit Agents setup", async () => {
    api = await createApi("monitoring_routes_livekit");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");

    const configured = await api.app.inject({
      method: "PUT",
      url: `/v1/monitoring/livekit-agents?projectId=${ada.projectId}`,
      headers: { cookie: ada.cookie },
    });
    expect(configured.statusCode, configured.body).toBe(200);
    expect(configured.json()).toMatchObject({
      monitoringSource: {
        agentPlatform: "livekit_agents",
        strategy: "livekit_otlp",
        credentialsHint: null,
        agents: [],
      },
    });

    const removed = await api.app.inject({
      method: "DELETE",
      url: `/v1/monitoring/livekit-agents?projectId=${ada.projectId}`,
      headers: { cookie: ada.cookie },
    });
    expect(removed.statusCode).toBe(204);

    const listed = await api.app.inject({
      method: "GET",
      url: `/v1/monitoring?projectId=${ada.projectId}`,
      headers: { cookie: ada.cookie },
    });
    expect(listed.json()).toEqual({ monitoringSources: [] });
  });
});
