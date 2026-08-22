import {
  claimDueMonitoringPull,
  createAgent,
  enablePullProductionCalls,
  finishMonitoringScan,
  listMonitoringFailures,
  readAgentPullState,
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
      agents: [
        {
          id: "agent_voice_1",
          name: "Front desk from Retell",
          // Nothing in this project registers it yet, so a tick would.
          registeredAgentId: null,
          registeredAgentName: null,
          pullProductionCalls: false,
        },
      ],
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

/**
 * **Starting monitoring, which is the whole of what the flow commits.**
 *
 * Three things happen in one request and each is asserted for itself: the key
 * is sealed onto the agent, the switch is flipped, and the notebook opens on
 * the 30-day historical window. A platform agent this project does not
 * register yet is registered on the spot, because watching one *means*
 * registering it.
 */
describe("starting monitoring", () => {
  it("seals the key on the picked agent, flips the switch, and opens the window", async () => {
    const retell = provider();
    api = await createApi("monitoring_routes_start_existing", {
      retellFetch: retell.fetchImpl,
    });
    const ada = await signUp(api.app, "ada-start@acme.example", "Acme");
    const created = await createAgent(at(ada), { name: "Front desk" });

    const started = await api.app.inject({
      method: "POST",
      url: `/v1/monitoring/start?projectId=${ada.projectId}`,
      headers: { cookie: ada.cookie },
      payload: {
        agentPlatform: "retell",
        apiKey: RETELL_KEY,
        watch: [{ platformAgentId: "agent_voice_1", agentId: created.id }],
      },
    });

    expect(started.statusCode, started.body).toBe(200);
    expect(started.json()).toEqual({
      watching: [
        {
          agentId: created.id,
          agentName: "Front desk",
          platformAgentId: "agent_voice_1",
          created: false,
          pullProductionCalls: true,
        },
      ],
      refused: [],
    });
    // The key never comes back out, in the answer or in a log.
    expect(started.body).not.toContain(RETELL_KEY);

    const state = await readAgentPullState(at(ada), created.id);
    expect(state?.pullProductionCalls).toBe(true);
    expect(state?.agentPlatform).toBe("retell");
    expect(state?.platformAgentId).toBe("agent_voice_1");
    expect(state?.monitoringApiKeyHint).toBe(RETELL_KEY.slice(-4));
    // The notebook opened on the historical import rather than on regular work.
    expect(state?.scanKind).toBe("historical_import");
  });

  it("registers an unregistered platform agent on the spot", async () => {
    const retell = provider();
    api = await createApi("monitoring_routes_start_new", {
      retellFetch: retell.fetchImpl,
    });
    const ada = await signUp(api.app, "ada-register@acme.example", "Acme");

    const started = await api.app.inject({
      method: "POST",
      url: `/v1/monitoring/start?projectId=${ada.projectId}`,
      headers: { cookie: ada.cookie },
      payload: {
        agentPlatform: "retell",
        apiKey: RETELL_KEY,
        watch: [
          { platformAgentId: "agent_voice_1", name: "Front desk from Retell" },
        ],
      },
    });

    expect(started.statusCode, started.body).toBe(200);
    const [watching] = started.json().watching as {
      agentId: string;
      agentName: string;
      created: boolean;
    }[];
    expect(watching?.created).toBe(true);
    expect(watching?.agentName).toBe("Front desk from Retell");

    const state = await readAgentPullState(at(ada), watching?.agentId ?? "");
    expect(state?.pullProductionCalls).toBe(true);
    expect(state?.platformAgentId).toBe("agent_voice_1");
  });

  /**
   * **One Egma agent watches one platform agent, and the database says so.**
   *
   * The refusal is the partial unique index's own answer, caught and dressed
   * in a sentence. Nothing reads the roster first to decide: a check before
   * the write would be a race with the very next request, and the index exists
   * to make the fight unrepresentable rather than usually avoided.
   */
  it("refuses a second agent on one platform agent, in plain words", async () => {
    const retell = provider();
    api = await createApi("monitoring_routes_start_contested", {
      retellFetch: retell.fetchImpl,
    });
    const ada = await signUp(api.app, "ada-contested@acme.example", "Acme");
    await pulling(ada);
    const second = await createAgent(at(ada), { name: "Second desk" });

    const answered = await api.app.inject({
      method: "POST",
      url: `/v1/monitoring/start?projectId=${ada.projectId}`,
      headers: { cookie: ada.cookie },
      payload: {
        agentPlatform: "retell",
        apiKey: RETELL_KEY,
        watch: [{ platformAgentId: "agent_voice_1", agentId: second.id }],
      },
    });

    expect(answered.statusCode, answered.body).toBe(200);
    const outcome = answered.json() as {
      watching: unknown[];
      refused: { platformAgentId: string; reason: string; message: string }[];
    };
    expect(outcome.watching).toEqual([]);
    expect(outcome.refused).toHaveLength(1);
    expect(outcome.refused[0]?.reason).toBe("contested");
    // Plain words, naming the platform agent and the agent already watching it.
    expect(outcome.refused[0]?.message).toContain("agent_voice_1");
    expect(outcome.refused[0]?.message).toContain("Front desk");
    expect(outcome.refused[0]?.message).not.toContain(
      "agent_pulled_platform_agent_unique",
    );
    // And the loser's switch stayed off.
    expect((await readAgentPullState(at(ada), second.id))?.pullProductionCalls).toBe(
      false,
    );
  });

  /**
   * **A refusal never hides what started beside it.**
   *
   * Starting an agent is a whole act on its own, so the entries around a
   * contested tick still start and the answer says so. A request answered with
   * only the refusal would leave switches on that nothing on screen mentions,
   * and the obvious next move — press it again — would start them twice.
   */
  it("starts the ticks beside a contested one and answers both", async () => {
    const retell = provider();
    api = await createApi("monitoring_routes_start_mixed", {
      retellFetch: retell.fetchImpl,
    });
    const ada = await signUp(api.app, "ada-mixed@acme.example", "Acme");
    await pulling(ada);
    const second = await createAgent(at(ada), { name: "Second desk" });

    const answered = await api.app.inject({
      method: "POST",
      url: `/v1/monitoring/start?projectId=${ada.projectId}`,
      headers: { cookie: ada.cookie },
      payload: {
        agentPlatform: "retell",
        apiKey: RETELL_KEY,
        watch: [
          // Contested: "Front desk" already watches this one.
          { platformAgentId: "agent_voice_1", agentId: second.id },
          // Unregistered, and named only by the platform.
          { platformAgentId: "agent_voice_9", name: "Billing" },
          // A missing agent id, which is this tick's own answer.
          { platformAgentId: "agent_voice_8", agentId: "agt_does_not_exist" },
        ],
      },
    });

    expect(answered.statusCode, answered.body).toBe(200);
    const outcome = answered.json() as {
      watching: { agentName: string; platformAgentId: string; created: boolean }[];
      refused: { platformAgentId: string; reason: string }[];
    };

    expect(outcome.watching).toHaveLength(1);
    expect(outcome.watching[0]?.platformAgentId).toBe("agent_voice_9");
    expect(outcome.watching[0]?.agentName).toBe("Billing");
    expect(outcome.watching[0]?.created).toBe(true);

    expect(
      outcome.refused.map((one) => [one.platformAgentId, one.reason]),
    ).toEqual([
      ["agent_voice_1", "contested"],
      ["agent_voice_8", "not_found"],
    ]);

    // The agent registered mid-list really is watching, and the loser is not.
    const registered = await api.database.sql<{ watched: string }>(
      "select count(*) as watched from agent where pull_production_calls",
    );
    expect(registered.rows[0]).toEqual({ watched: "2" });
  });

  it("refuses a viewer before starting anything", async () => {
    const retell = provider();
    api = await createApi("monitoring_routes_start_viewer", {
      retellFetch: retell.fetchImpl,
    });
    const ada = await signUp(api.app, "ada-start-viewer@acme.example", "Acme");
    const viewer = await colleagueOf(
      api.app,
      ada,
      "grace-start@acme.example",
      "viewer",
    );

    const refused = await api.app.inject({
      method: "POST",
      url: `/v1/monitoring/start?projectId=${ada.projectId}`,
      headers: { cookie: viewer.cookie },
      payload: {
        agentPlatform: "retell",
        apiKey: RETELL_KEY,
        watch: [{ platformAgentId: "agent_voice_1", name: "Front desk" }],
      },
    });

    expect(refused.statusCode, refused.body).toBe(403);
    const written = await api.database.sql<{ agents: string }>(
      "select count(*) as agents from agent",
    );
    expect(written.rows[0]).toEqual({ agents: "0" });
  });

  it("refuses a LiveKit start, because push is not configured anywhere", async () => {
    api = await createApi("monitoring_routes_start_livekit");
    const ada = await signUp(api.app, "ada-livekit@acme.example", "Acme");

    const refused = await api.app.inject({
      method: "POST",
      url: `/v1/monitoring/start?projectId=${ada.projectId}`,
      headers: { cookie: ada.cookie },
      payload: {
        agentPlatform: "livekit_agents",
        apiKey: RETELL_KEY,
        watch: [{ platformAgentId: "whatever" }],
      },
    });

    expect(refused.statusCode, refused.body).toBe(422);
  });

  it("tells the picker which account agents this project already registers", async () => {
    const retell = provider();
    api = await createApi("monitoring_routes_discover_known", {
      retellFetch: retell.fetchImpl,
    });
    const ada = await signUp(api.app, "ada-known@acme.example", "Acme");
    const agentId = await pulling(ada);

    const discovered = await api.app.inject({
      method: "POST",
      url: `/v1/monitoring/retell/discover?projectId=${ada.projectId}`,
      headers: { cookie: ada.cookie },
      payload: { apiKey: RETELL_KEY },
    });

    expect(discovered.statusCode, discovered.body).toBe(200);
    expect(discovered.json()).toEqual({
      agents: [
        {
          id: "agent_voice_1",
          name: "Front desk from Retell",
          registeredAgentId: agentId,
          registeredAgentName: "Front desk",
          pullProductionCalls: true,
        },
      ],
    });
  });
});

describe("stopping monitoring", () => {
  it("refuses a viewer, leaving the switch on", async () => {
    const retell = provider();
    api = await createApi("monitoring_routes_stop_viewer", {
      retellFetch: retell.fetchImpl,
    });
    const ada = await signUp(api.app, "ada-stop-viewer@acme.example", "Acme");
    const agentId = await pulling(ada);
    const viewer = await colleagueOf(
      api.app,
      ada,
      "grace-stop@acme.example",
      "viewer",
    );

    const refused = await api.app.inject({
      method: "POST",
      url: `/v1/monitoring/agents/${agentId}/stop?projectId=${ada.projectId}`,
      headers: { cookie: viewer.cookie },
    });

    expect(refused.statusCode, refused.body).toBe(403);
    expect((await readAgentPullState(at(ada), agentId))?.pullProductionCalls).toBe(
      true,
    );
  });

  it("turns the switch off and keeps everything stored", async () => {
    const retell = provider();
    api = await createApi("monitoring_routes_stop", {
      retellFetch: retell.fetchImpl,
    });
    const ada = await signUp(api.app, "ada-stop@acme.example", "Acme");
    const agentId = await pulling(ada);

    const stopped = await api.app.inject({
      method: "POST",
      url: `/v1/monitoring/agents/${agentId}/stop?projectId=${ada.projectId}`,
      headers: { cookie: ada.cookie },
    });

    expect(stopped.statusCode, stopped.body).toBe(200);
    expect(stopped.json()).toEqual({
      monitoring: {
        agentId,
        pullProductionCalls: false,
        agentPlatform: "retell",
        platformAgentId: "agent_voice_1",
        monitoringApiKeyHint: RETELL_KEY.slice(-4),
        lastReceivedAt: null,
      },
    });

    // The notebook survives: its cursor is what a later start resumes from.
    const kept = await api.database.sql<{ states: string }>(
      "select count(*) as states from monitoring_state",
    );
    expect(kept.rows[0]).toEqual({ states: "1" });
    // And nothing is due any more, because the switch is what makes it due.
    expect(await claimDueMonitoringPull({ now: new Date() })).toBeUndefined();
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
