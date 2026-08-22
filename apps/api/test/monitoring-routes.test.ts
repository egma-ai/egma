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

/** One registered agent, unbound, as the start-monitoring flow finds it. */
async function anAgent(
  app: TestApi["app"],
  who: { readonly cookie: string; readonly projectId: string },
  name: string,
): Promise<string> {
  const created = await app.inject({
    method: "POST",
    url: `/v1/agents?projectId=${who.projectId}`,
    headers: { cookie: who.cookie },
    payload: { name },
  });
  expect(created.statusCode, created.body).toBe(201);
  return String((created.json() as { agent: { id: string } }).agent.id);
}

describe("starting and stopping the pull switch", () => {
  it("reads the account, proves call-history access, and seals the key on the agent", async () => {
    const retell = provider();
    const logs: string[] = [];
    api = await createApi("monitoring_routes_retell", {
      retellFetch: retell.fetchImpl,
      logTo: { write: (line) => logs.push(line) },
    });
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const agentId = await anAgent(api.app, ada, "Front desk");

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

    const started = await api.app.inject({
      method: "PUT",
      url: `/v1/agents/${agentId}/production-pull?projectId=${ada.projectId}`,
      headers: { cookie: ada.cookie },
      payload: {
        agentPlatform: "retell",
        platformAgentId: "agent_voice_1",
        apiKey: RETELL_KEY,
      },
    });
    expect(started.statusCode, started.body).toBe(200);
    expect(started.json()).toEqual({
      pullSwitch: {
        agentId,
        agentPlatform: "retell",
        platformAgentId: "agent_voice_1",
        monitoringKeyHint: "QRST",
        pullProductionCalls: true,
      },
    });
    expect(started.body).not.toContain(RETELL_KEY);

    // Both permissions polling needs are proved before anything is sealed.
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

    const stored = await api.database.sql<{ monitoring_api_key: string }>(
      "select monitoring_api_key from agent where id = $1",
      [agentId],
    );
    expect(stored.rows[0]?.monitoring_api_key.startsWith("v1.")).toBe(true);
    expect(stored.rows[0]?.monitoring_api_key).not.toContain(RETELL_KEY);
    expect(logs.join("\n")).not.toContain(RETELL_KEY);

    // The notebook the poller reads opens with the historical import.
    const state = await api.database.sql<{ scan_kind: string }>(
      "select scan_kind from monitoring_state where agent_id = $1",
      [agentId],
    );
    expect(state.rows[0]?.scan_kind).toBe("historical_import");

    const stopped = await api.app.inject({
      method: "DELETE",
      url: `/v1/agents/${agentId}/production-pull?projectId=${ada.projectId}`,
      headers: { cookie: ada.cookie },
    });
    expect(stopped.statusCode, stopped.body).toBe(200);
    expect(stopped.json()).toMatchObject({
      pullSwitch: { pullProductionCalls: false, monitoringKeyHint: "QRST" },
    });
    // Off keeps the notebook, so turning it back on resumes rather than
    // re-reading a customer's history.
    const kept = await api.database.sql<{ count: string }>(
      "select count(*) as count from monitoring_state where agent_id = $1",
      [agentId],
    );
    expect(kept.rows[0]?.count).toBe("1");
  });

  it("does not seal a key that cannot read Retell call history", async () => {
    const retell = provider({ historyStatus: 403 });
    api = await createApi("monitoring_routes_history_scope", {
      retellFetch: retell.fetchImpl,
    });
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const agentId = await anAgent(api.app, ada, "Front desk");

    const started = await api.app.inject({
      method: "PUT",
      url: `/v1/agents/${agentId}/production-pull?projectId=${ada.projectId}`,
      headers: { cookie: ada.cookie },
      payload: {
        agentPlatform: "retell",
        platformAgentId: "agent_voice_1",
        apiKey: RETELL_KEY,
      },
    });

    expect(started.statusCode).toBe(422);
    expect(started.json()).toMatchObject({
      error: "unprocessable",
      message: expect.stringContaining("Monitor or History Read"),
    });
    const stored = await api.database.sql<{ count: string }>(
      "select count(*) as count from monitoring_state",
    );
    expect(stored.rows[0]?.count).toBe("0");
  });

  it("refuses an agent the account does not run", async () => {
    const retell = provider();
    api = await createApi("monitoring_routes_unknown_agent", {
      retellFetch: retell.fetchImpl,
    });
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const agentId = await anAgent(api.app, ada, "Front desk");

    const started = await api.app.inject({
      method: "PUT",
      url: `/v1/agents/${agentId}/production-pull?projectId=${ada.projectId}`,
      headers: { cookie: ada.cookie },
      payload: {
        agentPlatform: "retell",
        platformAgentId: "agent_nobody_runs",
        apiKey: RETELL_KEY,
      },
    });
    expect(started.statusCode, started.body).toBe(422);
    expect(String(started.json().message)).toContain("agent_nobody_runs");
  });

  it("refuses a second switched-on agent for one platform agent", async () => {
    const retell = provider();
    api = await createApi("monitoring_routes_one_watcher", {
      retellFetch: retell.fetchImpl,
    });
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const first = await anAgent(api.app, ada, "Front desk");
    const second = await anAgent(api.app, ada, "Front desk copy");

    const payload = {
      agentPlatform: "retell",
      platformAgentId: "agent_voice_1",
      apiKey: RETELL_KEY,
    };
    const started = await api.app.inject({
      method: "PUT",
      url: `/v1/agents/${first}/production-pull?projectId=${ada.projectId}`,
      headers: { cookie: ada.cookie },
      payload,
    });
    expect(started.statusCode).toBe(200);

    const refused = await api.app.inject({
      method: "PUT",
      url: `/v1/agents/${second}/production-pull?projectId=${ada.projectId}`,
      headers: { cookie: ada.cookie },
      payload,
    });
    expect(refused.statusCode, refused.body).toBe(422);
    expect(String(refused.json().message)).toContain("already pulling");
  });

  it("refuses a viewer before any Retell provider read", async () => {
    const retell = provider();
    api = await createApi("monitoring_routes_viewer", {
      retellFetch: retell.fetchImpl,
    });
    const ada = await signUp(api.app, "ada-owner@acme.example", "Acme");
    const agentId = await anAgent(api.app, ada, "Front desk");
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
        url: `/v1/agents/${agentId}/production-pull?projectId=${ada.projectId}`,
        payload: {
          agentPlatform: "retell",
          platformAgentId: "agent_voice_1",
          apiKey: RETELL_KEY,
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
});
