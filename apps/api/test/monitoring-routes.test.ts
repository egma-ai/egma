import {
  addConnection,
  archiveAgent,
  claimDueMonitoringPull,
  createAgent,
  disablePullProductionCalls,
  enablePullProductionCalls,
  readAgentPullState,
  type AuthContext,
} from "@egma/db";
import { afterEach, describe, expect, it } from "vitest";

import { createApi, type TestApi } from "./support/api.ts";
import { colleagueOf, signUp } from "./support/traces.ts";

/**
 * What is left of the Monitoring routes once the setup object is gone.
 *
 * The per-platform setup routes went with the tables they named: pull is
 * declared on the agent, and three routes are the whole surface — discovery
 * asks Retell what a key can see, start seals the key and flips the switch,
 * and stop turns it off. A call egma cannot import is given up on silently;
 * there is nothing here to retry it with.
 */

let api: TestApi;

afterEach(async () => {
  await api?.close();
});

const RETELL_KEY = "key_live_monitoring_route_secret_QRST";

function provider() {
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
  const created = await createAgent(auth, { agentPlatform: "retell", name: "Front desk" });
  await enablePullProductionCalls(auth, {
    agentId: created.id,
    agentPlatform: "retell",
    platformAgentId: "agent_voice_1",
    apiKey: RETELL_KEY,
  });
  return created.id;
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
    const created = await createAgent(at(ada), { agentPlatform: "retell", name: "Front desk" });

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

  it("resumes with the stored key without adding another connection", async () => {
    api = await createApi("monitoring_routes_resume_stored_key");
    const ada = await signUp(api.app, "ada-resume@acme.example", "Acme");
    const agentId = await pulling(ada);
    await addConnection(at(ada), agentId, {
      name: "phone",
      agentPlatform: "retell",
      connectionType: "phone_number",
      accessVariant: "phone_number.public_e164",
      modality: "voice",
      config: { phoneNumber: "+14155550100" },
    });

    for (let turn = 0; turn < 2; turn += 1) {
      const stopped = await api.app.inject({
        method: "POST",
        url: `/v1/monitoring/agents/${agentId}/stop?projectId=${ada.projectId}`,
        headers: { cookie: ada.cookie },
      });
      expect(stopped.statusCode, stopped.body).toBe(200);

      const resumed = await api.app.inject({
        method: "POST",
        url: `/v1/monitoring/start?projectId=${ada.projectId}`,
        headers: { cookie: ada.cookie },
        payload: {
          agentPlatform: "retell",
          watch: [{ platformAgentId: "agent_voice_1", agentId }],
        },
      });
      expect(resumed.statusCode, resumed.body).toBe(200);
      expect(resumed.json()).toMatchObject({
        watching: [
          {
            agentId,
            platformAgentId: "agent_voice_1",
            created: false,
            pullProductionCalls: true,
          },
        ],
        refused: [],
      });
    }

    const rows = await api.database.sql<{
      agents: string;
      connections: string;
    }>(
      "select (select count(*) from agent) as agents, " +
        "(select count(*) from connection) as connections",
    );
    expect(rows.rows[0]).toEqual({ agents: "1", connections: "1" });
    const state = await readAgentPullState(at(ada), agentId);
    expect(state?.pullProductionCalls).toBe(true);
    expect(state?.monitoringApiKeyHint).toBe(RETELL_KEY.slice(-4));
  });

  it("does not spend a stored key on a different Retell agent", async () => {
    api = await createApi("monitoring_routes_resume_wrong_platform_agent");
    const ada = await signUp(api.app, "ada-wrong-agent@acme.example", "Acme");
    const agentId = await pulling(ada);
    await disablePullProductionCalls(at(ada), agentId);

    const refused = await api.app.inject({
      method: "POST",
      url: `/v1/monitoring/start?projectId=${ada.projectId}`,
      headers: { cookie: ada.cookie },
      payload: {
        agentPlatform: "retell",
        watch: [{ platformAgentId: "agent_voice_2", agentId }],
      },
    });

    expect(refused.statusCode, refused.body).toBe(422);
    const state = await readAgentPullState(at(ada), agentId);
    expect(state?.pullProductionCalls).toBe(false);
    expect(state?.platformAgentId).toBe("agent_voice_1");
    expect(state?.monitoringApiKeyHint).toBe(RETELL_KEY.slice(-4));
  });

  it("refuses a supplied key that tries to rebind an existing agent", async () => {
    api = await createApi("monitoring_routes_supplied_key_rebind");
    const ada = await signUp(api.app, "ada-supplied-rebind@acme.example", "Acme");
    const agentId = await pulling(ada);
    await disablePullProductionCalls(at(ada), agentId);

    const answered = await api.app.inject({
      method: "POST",
      url: `/v1/monitoring/start?projectId=${ada.projectId}`,
      headers: { cookie: ada.cookie },
      payload: {
        agentPlatform: "retell",
        apiKey: "key_live_monitoring_other_agent_WXYZ",
        watch: [{ platformAgentId: "agent_voice_2", agentId }],
      },
    });

    expect(answered.statusCode, answered.body).toBe(200);
    expect(answered.json()).toEqual({
      watching: [],
      refused: [
        {
          platformAgentId: "agent_voice_2",
          reason: "contested",
          message:
            "Front desk is Retell agent agent_voice_1. Register agent_voice_2 as its own agent.",
        },
      ],
    });
    expect(await readAgentPullState(at(ada), agentId)).toMatchObject({
      pullProductionCalls: false,
      platformAgentId: "agent_voice_1",
      monitoringApiKeyHint: RETELL_KEY.slice(-4),
    });
  });

  it("refuses an omitted key before changing any agent when one entry has no stored key", async () => {
    api = await createApi("monitoring_routes_resume_missing_key");
    const ada = await signUp(api.app, "ada-mixed-resume@acme.example", "Acme");
    const storedAgentId = await pulling(ada);
    await disablePullProductionCalls(at(ada), storedAgentId);
    const missing = await createAgent(at(ada), {
      agentPlatform: "retell",
      name: "Second desk",
    });

    const refused = await api.app.inject({
      method: "POST",
      url: `/v1/monitoring/start?projectId=${ada.projectId}`,
      headers: { cookie: ada.cookie },
      payload: {
        agentPlatform: "retell",
        watch: [
          { platformAgentId: "agent_voice_1", agentId: storedAgentId },
          { platformAgentId: "agent_voice_2", agentId: missing.id },
        ],
      },
    });

    expect(refused.statusCode, refused.body).toBe(422);
    expect(refused.json()).toMatchObject({
      message:
        "Enter a Retell API key. Without one, every selected agent must already have a stored monitoring key.",
    });
    expect(
      (await readAgentPullState(at(ada), storedAgentId))?.pullProductionCalls,
    ).toBe(false);
    expect(
      (await readAgentPullState(at(ada), missing.id))?.pullProductionCalls,
    ).toBe(false);
  });

  it("does not treat a supplied blank key as permission to use the stored key", async () => {
    api = await createApi("monitoring_routes_resume_blank_key");
    const ada = await signUp(api.app, "ada-blank-resume@acme.example", "Acme");
    const agentId = await pulling(ada);
    await disablePullProductionCalls(at(ada), agentId);

    const refused = await api.app.inject({
      method: "POST",
      url: `/v1/monitoring/start?projectId=${ada.projectId}`,
      headers: { cookie: ada.cookie },
      payload: {
        agentPlatform: "retell",
        apiKey: " ",
        watch: [{ platformAgentId: "agent_voice_1", agentId }],
      },
    });

    expect(refused.statusCode, refused.body).toBe(422);
    expect((await readAgentPullState(at(ada), agentId))?.pullProductionCalls).toBe(
      false,
    );
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
    const second = await createAgent(at(ada), { agentPlatform: "retell", name: "Second desk" });

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
    const second = await createAgent(at(ada), { agentPlatform: "retell", name: "Second desk" });

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

  /**
   * **A refused start leaves nothing behind.**
   *
   * Registering an unregistered platform agent and flipping its switch are one
   * transaction, so a refused switch takes the agent row with it. Split in
   * two — create, then enable — the loser of the race writes its agent row,
   * loses the uniqueness-enforced switch, and leaves that row in the roster
   * bound to nothing, belonging to a request that was told it had failed.
   *
   * Two requests ticking the same unregistered platform agent at once is how
   * that happens. Whichever way the two interleave, the invariant is the same
   * and it is what this asserts: one agent row for one Retell agent, and no
   * live agent left unbound.
   */
  it("writes no orphan agent when two starts race for one platform agent", async () => {
    const retell = provider();
    api = await createApi("monitoring_routes_start_no_orphan", {
      retellFetch: retell.fetchImpl,
    });
    const ada = await signUp(api.app, "ada-orphan@acme.example", "Acme");

    const start = (name: string) =>
      api.app.inject({
        method: "POST",
        url: `/v1/monitoring/start?projectId=${ada.projectId}`,
        headers: { cookie: ada.cookie },
        payload: {
          agentPlatform: "retell",
          apiKey: RETELL_KEY,
          // No agent id, so each request registers what it does not find.
          watch: [{ platformAgentId: "agent_voice_1", name }],
        },
      });

    const [first, second] = await Promise.all([
      start("Front desk"),
      start("Front desk copy"),
    ]);

    expect(first.statusCode, first.body).toBe(200);
    expect(second.statusCode, second.body).toBe(200);

    // Exactly one agent watches the Retell agent, and nothing is left unbound.
    const rows = await api.database.sql<{
      agents: string;
      unbound: string;
      watching: string;
    }>(
      "select " +
        "(select count(*) from agent) as agents, " +
        "(select count(*) from agent where platform_agent_id is null) as unbound, " +
        "(select count(*) from agent where pull_production_calls) as watching",
    );
    expect(rows.rows[0]).toEqual({ agents: "1", unbound: "0", watching: "1" });
  });

  /**
   * The same invariant with the race's timing removed: an agent is already
   * switched on for this Retell agent, and the tick names no Egma agent — so
   * the commit resolves it to the agent that already holds it rather than
   * writing a second one.
   */
  it("recognizes a platform agent this project already watches", async () => {
    const retell = provider();
    api = await createApi("monitoring_routes_start_recognized", {
      retellFetch: retell.fetchImpl,
    });
    const ada = await signUp(api.app, "ada-recognized@acme.example", "Acme");
    const agentId = await pulling(ada);

    const answered = await api.app.inject({
      method: "POST",
      url: `/v1/monitoring/start?projectId=${ada.projectId}`,
      headers: { cookie: ada.cookie },
      payload: {
        agentPlatform: "retell",
        apiKey: RETELL_KEY,
        watch: [{ platformAgentId: "agent_voice_1", name: "A second desk" }],
      },
    });

    expect(answered.statusCode, answered.body).toBe(200);
    const outcome = answered.json() as {
      watching: { agentId: string; agentName: string; created: boolean }[];
      refused: unknown[];
    };
    expect(outcome.refused).toEqual([]);
    expect(outcome.watching).toHaveLength(1);
    expect(outcome.watching[0]?.agentId).toBe(agentId);
    expect(outcome.watching[0]?.created).toBe(false);

    const named = await api.database.sql<{ name: string }>(
      "select name from agent",
    );
    expect(named.rows.map((row) => row.name)).toEqual(["Front desk"]);
  });

  /**
   * **An archived agent is one tick's answer, never the request's.**
   *
   * The roster keeps an archived agent readable — a run that names it has to
   * keep opening — so it is found, and the switch refuses it. Letting that
   * refusal end the request would stop a batch after earlier entries had
   * started and before later ones were tried, which is the one thing the
   * per-entry contract promises never happens.
   */
  it("refuses an archived agent by name and starts the ticks around it", async () => {
    const retell = provider();
    api = await createApi("monitoring_routes_start_archived", {
      retellFetch: retell.fetchImpl,
    });
    const ada = await signUp(api.app, "ada-archived@acme.example", "Acme");
    const first = await createAgent(at(ada), { agentPlatform: "retell", name: "Front desk" });
    const gone = await createAgent(at(ada), { agentPlatform: "retell", name: "Retired desk" });
    await archiveAgent(at(ada), gone.id);

    const answered = await api.app.inject({
      method: "POST",
      url: `/v1/monitoring/start?projectId=${ada.projectId}`,
      headers: { cookie: ada.cookie },
      payload: {
        agentPlatform: "retell",
        apiKey: RETELL_KEY,
        watch: [
          { platformAgentId: "agent_voice_1", agentId: first.id },
          // Archived, in the middle, where an abort would be most visible.
          { platformAgentId: "agent_voice_2", agentId: gone.id },
          { platformAgentId: "agent_voice_3", name: "Billing" },
        ],
      },
    });

    expect(answered.statusCode, answered.body).toBe(200);
    const outcome = answered.json() as {
      watching: { platformAgentId: string }[];
      refused: { platformAgentId: string; reason: string; message: string }[];
    };

    // The entries around it started, including the one after it.
    expect(outcome.watching.map((one) => one.platformAgentId)).toEqual([
      "agent_voice_1",
      "agent_voice_3",
    ]);
    expect(outcome.refused).toHaveLength(1);
    expect(outcome.refused[0]?.platformAgentId).toBe("agent_voice_2");
    expect(outcome.refused[0]?.reason).toBe("archived");
    expect(outcome.refused[0]?.message).toContain("Retired desk");

    // And the archived agent's switch is still off.
    expect((await readAgentPullState(at(ada), gone.id))?.pullProductionCalls).toBe(
      false,
    );
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
        agentPlatform: "livekit",
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

    // The notebook survives, for what a later start does to it rather than
    // for anything it carries: bump the generation, set the floor at that
    // moment. No cursor crosses the gap.
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
