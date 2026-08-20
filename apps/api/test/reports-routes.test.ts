import { newId } from "@egma/ids";
import { createPersona, getSimulation } from "@egma/db";
import { afterEach, describe, expect, it } from "vitest";

import { CLAIMS_PATH } from "../src/routes/claims.ts";
import { reportPathFor } from "../src/routes/reports.ts";
import { fixedWindowRateLimit } from "../src/http/rate-limit.ts";
import {
  createApi,
  type TestApi,
  type TestApiOptions,
} from "./support/api.ts";
import {
  contextFor,
  NEUTRAL_TRAITS,
  projectKeyFor,
  request as ask,
  signUp,
  type Customer,
} from "./support/traces.ts";

/**
 * The report door, over real HTTP against real Postgres: the shipped
 * simulator's one way of saying what happened to a simulation it conducts.
 *
 * What is asserted here is what that simulator observes and what the record
 * then says: the token gate's one sentence, a contract violation answered
 * with the same complaints the simulator's own check would raise, the
 * lifecycle transitions landing with their facts, and the idempotency matrix
 * the client's at-least-once delivery leans on — duplicate 200s, conflicting
 * 409s, unknown 404s. The client resends byte-identical documents until one
 * answer is final, so every 200 here is a resend the record absorbed and
 * every 409 is a document the record refused to be rewritten by.
 */

let api: TestApi;

afterEach(async () => {
  await api?.close();
});

const RESCHEDULING = {
  name: "Reschedules a booked appointment",
  scenario:
    "Their cleaning is booked for Thursday morning and has to move to any afternoon next week.",
  expected_behaviors: ["confirms the new time back before finishing"],
} as const;

const RETELL = {
  agent_platform: "retell",
  connection_kind: "retell_chat_api",
  access_variant: "retell_chat_api.api_key",
  modality: "chat",
  config: { retellAgentId: "agent_in_retell_1" },
  credentials: { apiKey: "retell-secret-A1B2C3D4WXYZ" },
} as const;

/** The direct Retell fixture in this file is a chat agent. */
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

/** The minimum platform settings required to conduct a phone simulation. */
const PHONE_IS_SET_UP = {
  carrier_trunk_address: "egma-simulator-106e37f8.pstn.twilio.com",
  carrier_trunk_number: "+18885550123",
} as const;

/** The claimant every claim in this file conducts under. */
const CONDUCTOR = "sim-under-test";

/** The two moments every terminal fact block reports, fixed so rows can be checked. */
const STARTED_AT = "2026-08-05T09:00:00.000000Z";
const ENDED_AT = "2026-08-05T09:02:10.551000Z";

/** One report as the simulator posts one: a document about one simulation. */
async function report(
  simulationId: string,
  events: readonly Record<string, unknown>[],
  options: { readonly token?: string | undefined; readonly about?: string } = {},
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const token = options.token ?? api.config.simulatorServiceToken;
  const response = await api.app.inject({
    method: "POST",
    url: reportPathFor(simulationId),
    ...(token === "" ? {} : { headers: { authorization: `Bearer ${token}` } }),
    payload: {
      contract_version: 1,
      simulation_id: options.about ?? simulationId,
      events,
    },
  });
  return {
    statusCode: response.statusCode,
    body: response.json() as Record<string, unknown>,
  };
}

let eventNumber = 0;

/** The next event id, unique within the file the way the simulator mints them. */
function eventId(): string {
  eventNumber += 1;
  return `evt-${String(eventNumber).padStart(6, "0")}`;
}

function runningEvent(): Record<string, unknown> {
  return {
    kind: "status",
    event_id: eventId(),
    at: STARTED_AT,
    status: "running",
    reason: null,
  };
}

/** The terminal facts exactly as the contract's fixtures carry them. */
function factsOf(
  ending: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ending,
    started_at: STARTED_AT,
    ended_at: ENDED_AT,
    turn_count: 14,
    audio: null,
    provider_reference: "chat_5d1f9a3b7c",
    ...overrides,
  };
}

function terminalEvent(
  status: "completed" | "failed" | "canceled",
  ending: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    kind: "status",
    event_id: eventId(),
    at: ENDED_AT,
    status,
    reason: status === "failed" ? "the platform refused the exchange" : null,
    facts: factsOf(ending, overrides),
  };
}

/** A customer with an agent, a persona, and a test — everything a run needs. */
async function aCustomerReadyToRun(
  label: string,
  options: TestApiOptions = {},
): Promise<{
  ada: Customer;
  key: string;
  agentId: string;
  connectionId: string;
  versionId: string;
}> {
  api = await createApi(label, {
    ...options,
    retellFetch: options.retellFetch ?? RETELL_CHAT_FETCH,
  });
  const ada = await signUp(api.app, "ada@acme.example", "Acme");
  const key = await projectKeyFor(api.app, ada);

  const registered = await ask(api.app, "POST", "/api/agents", key, {
    name: "Front desk",
    connection: RETELL,
  });
  expect(registered.statusCode, JSON.stringify(registered.body)).toBe(201);
  const agentId = (registered.body.agent as { id: string }).id;
  const connectionId = (registered.body.connection as { id: string }).id;

  await createPersona(contextFor(ada, "member"), {
    name: "Impatient Rita",
    traits: NEUTRAL_TRAITS,
  });
  const pushed = await ask(api.app, "POST", "/api/tests", key, {
    ...RESCHEDULING,
    personas: ["Impatient Rita"],
  });
  expect(pushed.statusCode, JSON.stringify(pushed.body)).toBe(201);

  return {
    ada,
    key,
    agentId,
    connectionId,
    versionId: String(pushed.body.version_id),
  };
}

/** A run whose one simulation has been claimed through the real claim door. */
async function aClaimedSimulation(
  key: string,
  connectionId: string,
  versionId: string,
): Promise<{ runId: string; simulationId: string }> {
  const started = await ask(api.app, "POST", "/api/runs", key, {
    connection: connectionId,
    test_versions: [versionId],
    idempotency_key: newId("run"),
  });
  expect(started.statusCode, JSON.stringify(started.body)).toBe(201);
  const simulations = started.body.simulations as { id: string }[];
  const first = simulations[0];
  if (first === undefined) throw new Error("the run has no simulation");

  const claimed = await api.app.inject({
    method: "POST",
    url: CLAIMS_PATH,
    headers: { authorization: `Bearer ${api.config.simulatorServiceToken}` },
    payload: {
      claimant: CONDUCTOR,
      capacity: 50,
      wait_seconds: 0,
      contract_versions: [3],
    },
  });
  expect(claimed.statusCode).toBe(200);
  const specs = (claimed.json() as { specs: { simulation_id: string }[] }).specs;
  expect(specs.map((spec) => spec.simulation_id)).toContain(first.id);

  return { runId: String(started.body.id), simulationId: first.id };
}

/** The same, walked one transition on: the conversation is underway. */
async function aRunningSimulation(
  key: string,
  connectionId: string,
  versionId: string,
): Promise<{ runId: string; simulationId: string }> {
  const claimed = await aClaimedSimulation(key, connectionId, versionId);
  const answered = await report(claimed.simulationId, [runningEvent()]);
  expect(answered.statusCode, JSON.stringify(answered.body)).toBe(200);
  return claimed;
}

/** What the grading queue holds for one simulation — the minted work. */
async function gradingJobsFor(simulationId: string): Promise<number> {
  const { rows } = await api.database.sql<{ count: string }>(
    "select count(*) as count from grading_job where simulation_id = $1",
    [simulationId],
  );
  return Number(rows[0]?.count);
}

describe("the token gate", () => {
  it("refuses a missing, wrong, or customer token with one actionable sentence", async () => {
    const { key, connectionId, versionId } = await aCustomerReadyToRun(
      "reports_gate",
    );
    const { simulationId } = await aClaimedSimulation(key, connectionId, versionId);

    const refusals = await Promise.all([
      report(simulationId, [runningEvent()], { token: "" }),
      report(simulationId, [runningEvent()], {
        token: "egma_st_not-the-configured-one",
      }),
      // A customer's own real key: a credential for their data, and exactly
      // the thing this door must never take a lifecycle claim from.
      report(simulationId, [runningEvent()], { token: key }),
    ]);

    for (const refused of refusals) {
      expect(refused.statusCode).toBe(401);
      expect(refused.body.error).toBe("not_authenticated");
      expect(String(refused.body.message)).toContain(
        "EGMA_SIMULATOR_SERVICE_TOKEN",
      );
    }

    // And nothing moved: the gate turned every one of them away unread.
    const { rows } = await api.database.sql<{ status: string }>(
      "select status from simulation where id = $1",
      [simulationId],
    );
    expect(rows[0]?.status).toBe("claimed");
  });
});

describe("what the door refuses before believing a word", () => {
  it("refuses a document that does not speak the contract, complaints included", async () => {
    const { key, connectionId, versionId } = await aCustomerReadyToRun(
      "reports_contract",
    );
    const { simulationId } = await aClaimedSimulation(key, connectionId, versionId);

    const refused = await report(simulationId, [
      { kind: "confession", event_id: eventId() },
    ]);
    expect(refused.statusCode).toBe(400);
    expect(refused.body.error).toBe("invalid_request");
    expect(String(refused.body.message)).toContain("/events/0");
  });

  it("refuses the endings that are the platform's own words, never a reporter's", async () => {
    const { key, connectionId, versionId } = await aCustomerReadyToRun(
      "reports_vocabulary",
    );
    const { simulationId } = await aRunningSimulation(key, connectionId, versionId);

    // `orphaned` is the sweep's word, `dispatch_failed` the claim path's,
    // and the row's own vocabulary (`simulator_error`, `capacity`) never
    // rides the wire — the contract's schema is the refusal for all four.
    for (const ending of [
      "orphaned",
      "dispatch_failed",
      "simulator_error",
      "capacity",
    ]) {
      const refused = await report(simulationId, [
        terminalEvent("failed", ending),
      ]);
      expect(refused.statusCode, `ending "${ending}" was believed`).toBe(400);
      expect(refused.body.error).toBe("invalid_request");
    }
  });

  it("refuses a document about another simulation, naming both ids", async () => {
    const { key, connectionId, versionId } = await aCustomerReadyToRun(
      "reports_mismatch",
    );
    const { simulationId } = await aClaimedSimulation(key, connectionId, versionId);

    const refused = await report(simulationId, [runningEvent()], {
      about: "sim_01K3XQ7M4E8YB2FVN0H9TZQWER",
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.body.error).toBe("invalid_request");
    expect(String(refused.body.message)).toContain(simulationId);
    expect(String(refused.body.message)).toContain(
      "sim_01K3XQ7M4E8YB2FVN0H9TZQWER",
    );
  });

  it("answers an unknown simulation with 404, in words a coding agent can act on", async () => {
    api = await createApi("reports_unknown");

    const refused = await report("sim_01K3XQ7M4E8YB2FVN0H9TZQWER", [
      runningEvent(),
    ]);
    expect(refused.statusCode).toBe(404);
    expect(refused.body.error).toBe("not_found");
    expect(String(refused.body.message)).toContain(
      "sim_01K3XQ7M4E8YB2FVN0H9TZQWER",
    );
  });
});

describe("the lifecycle lands", () => {
  it("starts the conversation on a running event, conducted by the row's own claimant", async () => {
    const { ada, key, connectionId, versionId } = await aCustomerReadyToRun(
      "reports_running",
    );
    const { simulationId } = await aClaimedSimulation(key, connectionId, versionId);

    const answered = await report(simulationId, [runningEvent()]);
    expect(answered.statusCode, JSON.stringify(answered.body)).toBe(200);
    expect(answered.body).toEqual({
      simulation_id: simulationId,
      status: "running",
    });

    const row = await getSimulation(contextFor(ada, "member"), simulationId);
    expect(row?.status).toBe("running");
    expect(row?.startedAt).toBeInstanceOf(Date);
    expect(row?.claimedBy).toBe(CONDUCTOR);
  });

  it("lands a completed conversation with its facts, mints grading work, finalizes the run", async () => {
    const { ada, key, connectionId, versionId } = await aCustomerReadyToRun(
      "reports_completed",
    );
    const { runId, simulationId } = await aRunningSimulation(
      key,
      connectionId,
      versionId,
    );

    const answered = await report(simulationId, [
      terminalEvent("completed", "persona_concluded"),
    ]);
    expect(answered.statusCode, JSON.stringify(answered.body)).toBe(200);
    expect(answered.body).toEqual({
      simulation_id: simulationId,
      status: "completed",
    });

    // The row says what the conduction measured, not what the wire clock saw.
    const row = await getSimulation(contextFor(ada, "member"), simulationId);
    expect(row?.status).toBe("completed");
    expect(row?.endingReason).toBe("persona_concluded");
    expect(row?.turnCount).toBe(14);
    expect(row?.providerReference).toBe("chat_5d1f9a3b7c");
    expect(row?.startedAt?.toISOString()).toBe("2026-08-05T09:00:00.000Z");
    expect(row?.endedAt?.toISOString()).toBe("2026-08-05T09:02:10.551Z");

    // The landing minted the judgement and froze the header, exactly as the
    // access layer promises every terminal transition does.
    expect(await gradingJobsFor(simulationId)).toBe(1);
    const header = await ask(api.app, "GET", `/api/runs/${runId}`, key);
    expect(header.body.status).toBe("completed");
    expect(header.body.completed_count).toBe(1);
    expect(header.body.failed_count).toBe(0);
  });

  it("declines reported moments that cannot be true, and lands on its own stamps", async () => {
    const { ada, key, connectionId, versionId } = await aCustomerReadyToRun(
      "reports_skewed_clock",
    );
    const before = new Date();
    const { simulationId } = await aRunningSimulation(key, connectionId, versionId);

    // A skewed clock's confession: contract-valid, impossible on any clock —
    // the exchange ends before it starts. Refusing it would punish delivery
    // for the clock and leave a truthful conversation to the sweep, so the
    // door lands it and simply declines the pair it cannot believe.
    const answered = await report(simulationId, [
      terminalEvent("completed", "persona_concluded", {
        started_at: ENDED_AT,
        ended_at: STARTED_AT,
      }),
    ]);
    expect(answered.statusCode, JSON.stringify(answered.body)).toBe(200);

    const row = await getSimulation(contextFor(ada, "member"), simulationId);
    expect(row?.status).toBe("completed");
    // The server's own stamps stand for both moments: a coherent interval,
    // inside this test's own wall clock — never the reported 2026-08-05 pair.
    expect(row?.startedAt?.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(row?.endedAt?.getTime()).toBeGreaterThanOrEqual(
      row?.startedAt?.getTime() ?? Number.POSITIVE_INFINITY,
    );
    // The facts the pair rode in with still land whole.
    expect(row?.turnCount).toBe(14);
    expect(row?.providerReference).toBe("chat_5d1f9a3b7c");
  });

  it("lands a voice conversation's recording reference", async () => {
    const { ada, key, agentId, versionId } = await aCustomerReadyToRun(
      "reports_voice",
      { platformSettings: PHONE_IS_SET_UP },
    );
    const attached = await ask(api.app, "POST", `/api/agents/${agentId}/connections`, key, {
      agent_platform: null,
      connection_kind: "phone_number",
      access_variant: "phone_number.public_e164",
      modality: "voice",
      config: { phoneNumber: "+15551234567" },
    });
    expect(attached.statusCode, JSON.stringify(attached.body)).toBe(201);
    const voiceConnection = (attached.body.connection as { id: string }).id;

    const { simulationId } = await aRunningSimulation(
      key,
      voiceConnection,
      versionId,
    );

    const answered = await report(simulationId, [
      terminalEvent("completed", "agent_ended", {
        audio: {
          recording: `${simulationId}/dual-channel.wav`,
        },
        provider_reference: "CA7e2b9c1d4f6a8e0b",
        turn_count: 22,
      }),
    ]);
    expect(answered.statusCode, JSON.stringify(answered.body)).toBe(200);

    const row = await getSimulation(contextFor(ada, "member"), simulationId);
    expect(row?.recordingReference).toBe(`${simulationId}/dual-channel.wav`);
    expect(row?.turnCount).toBe(22);
    expect(row?.providerReference).toBe("CA7e2b9c1d4f6a8e0b");
  });

  /**
   * The stamp is what says whether two simulations' numbers may be compared at
   * all, so it has to survive the whole way: off the report, onto the row, and
   * out of the run's own read with nothing else to fetch.
   */
  it("lands the coverage stamp and serves it back on the run's simulations", async () => {
    const { ada, key, connectionId, versionId } = await aCustomerReadyToRun(
      "reports_coverage",
    );
    const { runId, simulationId } = await aRunningSimulation(
      key,
      connectionId,
      versionId,
    );

    const answered = await report(simulationId, [
      terminalEvent("completed", "persona_concluded", {
        mock_tool_coverage: {
          discovered: ["check_calendar", "send_confirmation"],
          covered: ["check_calendar"],
          uncovered: ["send_confirmation"],
        },
      }),
    ]);
    expect(answered.statusCode, JSON.stringify(answered.body)).toBe(200);

    const row = await getSimulation(contextFor(ada, "member"), simulationId);
    expect(row?.mockToolCoverage).toEqual({
      discovered: ["check_calendar", "send_confirmation"],
      covered: ["check_calendar"],
      uncovered: ["send_confirmation"],
    });

    // And readable by whoever asks for the run — the different-units rule
    // answered off the conversation itself, without joining anything.
    const read = await ask(api.app, "GET", `/api/runs/${runId}`, key);
    const [served] = read.body.simulations as {
      readonly mock_tool_coverage: unknown;
    }[];
    expect(served?.mock_tool_coverage).toEqual({
      discovered: ["check_calendar", "send_confirmation"],
      covered: ["check_calendar"],
      uncovered: ["send_confirmation"],
    });
  });

  /**
   * The two silences, which are two different facts. A report with no stamp is
   * a conversation whose agent was never asked what tools it has; a stamp of
   * three empty lists is the asking happening and nothing coming back. Landing
   * either as the other would put a claim on the record the simulator declined
   * to make.
   */
  it("keeps a report with no stamp apart from one whose stamp is empty", async () => {
    const { ada, key, connectionId, versionId } = await aCustomerReadyToRun(
      "reports_coverage_absent",
    );

    const silent = await aRunningSimulation(key, connectionId, versionId);
    expect(
      (await report(silent.simulationId, [
        terminalEvent("completed", "persona_concluded"),
      ])).statusCode,
    ).toBe(200);
    expect(
      (await getSimulation(contextFor(ada, "member"), silent.simulationId))
        ?.mockToolCoverage,
    ).toBeNull();

    const asked = await aRunningSimulation(key, connectionId, versionId);
    expect(
      (await report(asked.simulationId, [
        terminalEvent("completed", "persona_concluded", {
          mock_tool_coverage: { discovered: [], covered: [], uncovered: [] },
        }),
      ])).statusCode,
    ).toBe(200);
    expect(
      (await getSimulation(contextFor(ada, "member"), asked.simulationId))
        ?.mockToolCoverage,
    ).toEqual({ discovered: [], covered: [], uncovered: [] });
  });

  it("refuses recording facts for a chat conversation", async () => {
    const { key, connectionId, versionId } = await aCustomerReadyToRun(
      "reports_chat_audio",
    );
    const { simulationId } = await aRunningSimulation(key, connectionId, versionId);

    const refused = await report(simulationId, [
      terminalEvent("completed", "persona_concluded", {
        audio: {
          recording: "somewhere/dual-channel.wav",
        },
      }),
    ]);
    expect(refused.statusCode).toBe(422);
    expect(refused.body.error).toBe("unprocessable");
    expect(String(refused.body.message)).toContain("chat");
  });

  it("lands a failed conversation's honest reason, the wire's `error` as the row's own word", async () => {
    const { ada, key, connectionId, versionId } = await aCustomerReadyToRun(
      "reports_failed",
    );
    const { runId, simulationId } = await aRunningSimulation(
      key,
      connectionId,
      versionId,
    );

    const answered = await report(simulationId, [
      terminalEvent("failed", "error", { turn_count: 3 }),
    ]);
    expect(answered.statusCode, JSON.stringify(answered.body)).toBe(200);

    const row = await getSimulation(contextFor(ada, "member"), simulationId);
    expect(row?.status).toBe("failed");
    expect(row?.endingReason).toBe("simulator_error");
    expect(row?.turnCount).toBe(3);

    // A failed conversation is judged too — errored, never left unjudged.
    expect(await gradingJobsFor(simulationId)).toBe(1);
    const header = await ask(api.app, "GET", `/api/runs/${runId}`, key);
    expect(header.body.status).toBe("completed");
    expect(header.body.failed_count).toBe(1);
  });

  it("lands agent_never_joined from the claimed state, where nothing ever ran", async () => {
    const { ada, key, connectionId, versionId } = await aCustomerReadyToRun(
      "reports_never_joined",
    );
    // Deliberately never reported running: a failed landing is legal from
    // `claimed` at the access seam — the way in opened and nothing tested —
    // and the door keeps exactly that discipline rather than inventing a
    // stricter one.
    const { simulationId } = await aClaimedSimulation(key, connectionId, versionId);

    const answered = await report(simulationId, [
      terminalEvent("failed", "agent_never_joined", { turn_count: 0 }),
    ]);
    expect(answered.statusCode, JSON.stringify(answered.body)).toBe(200);

    const row = await getSimulation(contextFor(ada, "member"), simulationId);
    expect(row?.status).toBe("failed");
    expect(row?.endingReason).toBe("agent_never_joined");
    expect(row?.turnCount).toBe(0);
  });

  it("lands a canceled conversation once cancellation was actually requested", async () => {
    const { ada, key, connectionId, versionId } = await aCustomerReadyToRun(
      "reports_canceled",
    );
    const { runId, simulationId } = await aRunningSimulation(
      key,
      connectionId,
      versionId,
    );

    const asked = await ask(api.app, "POST", `/api/runs/${runId}/cancel`, key);
    expect(asked.statusCode, JSON.stringify(asked.body)).toBe(200);

    const answered = await report(simulationId, [
      terminalEvent("canceled", "canceled", { turn_count: 6 }),
    ]);
    expect(answered.statusCode, JSON.stringify(answered.body)).toBe(200);

    const row = await getSimulation(contextFor(ada, "member"), simulationId);
    expect(row?.status).toBe("canceled");
    // The cancel intent is its own record; the reason column stays empty.
    expect(row?.endingReason).toBeNull();
    expect(row?.turnCount).toBe(6);

    // A canceled conversation was never judged — no grading work minted.
    expect(await gradingJobsFor(simulationId)).toBe(0);
    const header = await ask(api.app, "GET", `/api/runs/${runId}`, key);
    expect(header.body.status).toBe("canceled");
    expect(header.body.canceled_count).toBe(1);
  });

  it("retries once when the cancellation lands between the attempt and the answer", async () => {
    const { ada, key, connectionId, versionId } = await aCustomerReadyToRun(
      "reports_cancel_race",
    );
    const { runId, simulationId } = await aRunningSimulation(
      key,
      connectionId,
      versionId,
    );
    const asked = await ask(api.app, "POST", `/api/runs/${runId}/cancel`, key);
    expect(asked.statusCode, JSON.stringify(asked.body)).toBe(200);

    // The race, held open deterministically: a trigger suppresses the first
    // canceled landing on this row — the update reports no row moved, which
    // is exactly what the route sees when a cancelRun commits between its
    // attempt and its re-read — and every later attempt passes. The route
    // cannot tell this window from the real one; what it must do about it
    // is the same: read again, see a live row whose cancellation stands,
    // and retry once rather than refuse a transition that is valid at the
    // moment it answers.
    await api.database.sql(
      "create table report_race_window (id text primary key)",
    );
    await api.database.sql(
      `create function report_race_suppress_once() returns trigger
       language plpgsql as $$
       begin
         if new.status = 'canceled' and old.status <> 'canceled'
            and not exists (select 1 from report_race_window where id = old.id)
         then
           insert into report_race_window values (old.id);
           return null; -- the attempt sees what a lost race sees: nothing moved
         end if;
         return new;
       end $$`,
    );
    await api.database.sql(
      `create trigger report_race_suppress before update on simulation
       for each row execute function report_race_suppress_once()`,
    );

    try {
      const answered = await report(simulationId, [
        terminalEvent("canceled", "canceled", { turn_count: 6 }),
      ]);
      expect(answered.statusCode, JSON.stringify(answered.body)).toBe(200);
      expect(answered.body).toEqual({
        simulation_id: simulationId,
        status: "canceled",
      });

      // The one attempt the window swallowed, and the one retry that landed.
      const { rows } = await api.database.sql<{ id: string }>(
        "select id from report_race_window",
      );
      expect(rows).toEqual([{ id: simulationId }]);

      const row = await getSimulation(contextFor(ada, "member"), simulationId);
      expect(row?.status).toBe("canceled");
      expect(row?.turnCount).toBe(6);
    } finally {
      await api.database.sql(
        "drop trigger report_race_suppress on simulation",
      );
      await api.database.sql("drop function report_race_suppress_once()");
      await api.database.sql("drop table report_race_window");
    }
  });

  it("refuses to call a conversation canceled that nobody asked to cancel", async () => {
    const { ada, key, connectionId, versionId } = await aCustomerReadyToRun(
      "reports_uninvited_cancel",
    );
    const { simulationId } = await aRunningSimulation(key, connectionId, versionId);

    const refused = await report(simulationId, [
      terminalEvent("canceled", "canceled"),
    ]);
    expect(refused.statusCode).toBe(409);
    expect(refused.body.error).toBe("conflict");
    expect(String(refused.body.message)).toContain("cancel");

    // The row stands exactly where it stood: still running, still honest.
    const row = await getSimulation(contextFor(ada, "member"), simulationId);
    expect(row?.status).toBe("running");
  });
});

describe("idempotency without a ledger", () => {
  it("absorbs a duplicate running event with 200", async () => {
    const { key, connectionId, versionId } = await aCustomerReadyToRun(
      "reports_duplicate_running",
    );
    const { simulationId } = await aRunningSimulation(key, connectionId, versionId);

    const again = await report(simulationId, [runningEvent()]);
    expect(again.statusCode).toBe(200);
    expect(again.body).toEqual({
      simulation_id: simulationId,
      status: "running",
    });
  });

  it("absorbs a terminal resend that matches the row's terminal state", async () => {
    const { key, connectionId, versionId } = await aCustomerReadyToRun(
      "reports_terminal_resend",
    );
    const { simulationId } = await aRunningSimulation(key, connectionId, versionId);

    const landed = terminalEvent("completed", "persona_concluded");
    expect((await report(simulationId, [landed])).statusCode).toBe(200);

    // The client resends the same bytes; the record absorbs them.
    const resent = await report(simulationId, [landed]);
    expect(resent.statusCode).toBe(200);
    expect(resent.body).toEqual({
      simulation_id: simulationId,
      status: "completed",
    });
  });

  it("refuses a terminal document that conflicts with the terminal row, 409, saying both sides", async () => {
    const { key, connectionId, versionId } = await aCustomerReadyToRun(
      "reports_conflict",
    );
    const { simulationId } = await aRunningSimulation(key, connectionId, versionId);

    expect(
      (
        await report(simulationId, [
          terminalEvent("completed", "persona_concluded"),
        ])
      ).statusCode,
    ).toBe(200);

    // A different ending for the same conversation: the record already says
    // how it ended, and it is not rewritten by a later document.
    const differentEnding = await report(simulationId, [
      terminalEvent("completed", "agent_ended"),
    ]);
    expect(differentEnding.statusCode).toBe(409);
    expect(differentEnding.body.error).toBe("conflict");
    expect(String(differentEnding.body.message)).toContain("persona_concluded");

    const differentStatus = await report(simulationId, [
      terminalEvent("failed", "error"),
    ]);
    expect(differentStatus.statusCode).toBe(409);

    const runningAgain = await report(simulationId, [runningEvent()]);
    expect(runningAgain.statusCode).toBe(409);
    expect(runningAgain.body.error).toBe("conflict");
  });

  it("refuses a completed landing for a conversation that never reported running", async () => {
    const { key, connectionId, versionId } = await aCustomerReadyToRun(
      "reports_never_ran",
    );
    const { simulationId } = await aClaimedSimulation(key, connectionId, versionId);

    const refused = await report(simulationId, [
      terminalEvent("completed", "persona_concluded"),
    ]);
    expect(refused.statusCode).toBe(409);
    expect(refused.body.error).toBe("conflict");
  });
});

describe("what this door is not for", () => {
  /**
   * The conversation has one home and this is not it. A turn, a tool call and
   * a measurement arrive as spans at the OTLP ingest — the same door a
   * customer's agent exports to — so a report carrying one would be a second
   * copy of the conversation, free to disagree with the first. The refusal is
   * the contract's rather than this route's, which is what makes it true of
   * both sides at once: the simulator's own check raises the same complaint
   * before such a document could ever be sent.
   */
  it("refuses a report carrying a conversation, whichever kind it claims", async () => {
    const { ada, key, connectionId, versionId } = await aCustomerReadyToRun(
      "reports_conversation",
    );
    const { simulationId } = await aRunningSimulation(key, connectionId, versionId);

    const carrying: Record<string, unknown>[] = [
      {
        kind: "turn",
        event_id: eventId(),
        speaker: "human",
        text: "I need to move my Tuesday cleaning to Thursday.",
        started_at: STARTED_AT,
        ended_at: null,
      },
      {
        kind: "timing",
        event_id: eventId(),
        at: STARTED_AT,
        measure: "first_response_latency",
        milliseconds: 1214,
      },
      {
        kind: "tool_call",
        event_id: eventId(),
        at: STARTED_AT,
        name: "reschedule_appointment",
        arguments: null,
      },
    ];

    for (const event of carrying) {
      const refused = await report(simulationId, [event]);
      expect(
        refused.statusCode,
        `a "${String(event.kind)}" event was believed`,
      ).toBe(400);
      expect(refused.body.error).toBe("invalid_request");
      expect(String(refused.body.message)).toContain("/events/0");
    }

    // And the record is exactly where it was: a refused document moves
    // nothing, so the conversation is still running and still only in spans.
    const row = await getSimulation(contextFor(ada, "member"), simulationId);
    expect(row?.status).toBe("running");
  });
});

describe("what the report door never touches", () => {
  it("spends no organization's request budget, and no budget stops a report", async () => {
    api = await createApi("reports_budget", {
      rateLimit: fixedWindowRateLimit({ limit: 3, windowMilliseconds: 60_000 }),
    });
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const key = await projectKeyFor(api.app, ada);

    // Spend the organization's whole budget…
    let refused = 0;
    for (let i = 0; i < 8; i += 1) {
      const answer = await ask(api.app, "GET", "/api/agents", key);
      if (answer.statusCode === 429) refused += 1;
    }
    expect(refused).toBeGreaterThan(0);

    // …and the report door is unmoved: its answer is a 404 about the row,
    // never a 429 about anybody's budget.
    const answered = await report("sim_01K3XQ7M4E8YB2FVN0H9TZQWER", [
      runningEvent(),
    ]);
    expect(answered.statusCode).toBe(404);
  });
});
