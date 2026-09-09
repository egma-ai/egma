import { claimSimulations, createPersona, getSimulation } from "@egma/db";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  startOrphanSweep,
  SWEEP_INTERVAL_MILLISECONDS,
  type OrphanSweepFailureLogDetails,
  type OrphanSweepLog,
  type SweptSimulationsLogDetails,
} from "../src/simulation-sweep.ts";
import { createApi, type TestApi, type TestApiOptions } from "./support/api.ts";
import {
  contextFor,
  NEUTRAL_PERSON,
  projectKeyFor,
  request as ask,
  signUp,
  type Customer,
} from "./support/traces.ts";

/**
 * The standing orphan sweep: the loop the API runs so a dead simulator's
 * rows land `failed` without anybody asking. What is pinned here is the
 * loop's own conduct — it starts with the server, it says what it swept and
 * only when it swept something, and a sweep that fails leaves the loop
 * standing — because the sweeping itself is the db seam's, proven where it
 * lives.
 */

let api: TestApi | undefined;

afterEach(async () => {
  await api?.close();
  api = undefined;
});

/** What one test's loop said, in order, without a real logger in the way. */
function capturingLog(): OrphanSweepLog & {
  infos: { details: SweptSimulationsLogDetails; message: string }[];
  errors: { details: OrphanSweepFailureLogDetails; message: string }[];
} {
  const infos: { details: SweptSimulationsLogDetails; message: string }[] = [];
  const errors: { details: OrphanSweepFailureLogDetails; message: string }[] = [];
  return {
    infos,
    errors,
    info(details, message) {
      infos.push({ details, message });
    },
    error(details, message) {
      errors.push({ details, message });
    },
  };
}

/** A customer, a claimed simulation, and a heartbeat far in the past. */
async function anOrphan(
  label: string,
  options: TestApiOptions = {},
): Promise<{
  ada: Customer;
  key: string;
  runId: string;
  simulationId: string;
  api: TestApi;
}> {
  api = await createApi(label, options);
  const ada = await signUp(api.app, "ada@acme.example", "Acme");
  const key = await projectKeyFor(api.app, ada);

  const registered = await ask(api.app, "POST", "/v1/agents", key, {
    agentPlatform: "livekit",
    name: "Front desk",
    connection: {
      agentPlatform: "livekit",
      connectionType: "livekit_room",
      accessVariant: "livekit_room.project_credentials",
      modality: "chat",
      config: { url: "wss://sweep.livekit.cloud", agentName: "front-desk" },
      credentials: { apiKey: "APIsweep12345678", apiSecret: "livekit-secret-sweep" },
    },
  });
  expect(registered.statusCode, JSON.stringify(registered.body)).toBe(201);
  const agentId = (registered.body.agent as { id: string }).id;
  const connectionId = (registered.body.connection as { id: string }).id;

  await createPersona(contextFor(ada, "member"), {
    name: "Impatient Rita",
    ...NEUTRAL_PERSON,
  });
  const suite = await ask(api.app, "POST", "/v1/test-suites", key, {
    name: "Appointment changes",
  });
  expect(suite.statusCode, JSON.stringify(suite.body)).toBe(201);
  const suiteId = String(suite.body.id);

  const pushed = await ask(api.app, "POST", "/v1/tests", key, {
    suiteId,
    name: "Reschedules a booked appointment",
    scenario: "Their cleaning is booked for Thursday and has to move.",
    expectedBehaviors: ["confirms the new time back before finishing"],
    personas: ["Impatient Rita"],
  });
  expect(pushed.statusCode, JSON.stringify(pushed.body)).toBe(201);

  const started = await ask(api.app, "POST", "/v1/runs", key, {
    suiteId,
    agentId,
    connectionId,
  });
  expect(started.statusCode, JSON.stringify(started.body)).toBe(201);
  const runId = String(started.body.id);
  const page = await ask(
    api.app,
    "GET",
    `/v1/runs/${runId}/simulations?pageSize=1`,
    key,
  );
  expect(page.statusCode, JSON.stringify(page.body)).toBe(200);
  const simulations = page.body.simulations as { id: string }[];
  const simulationId = simulations[0]?.id ?? "";

  const claims = await claimSimulations({
    claimant: "simulator-that-died",
    capacity: 50,
  });
  expect(claims.map((claim) => claim.id)).toContain(simulationId);

  // The one write no seam should offer: the silence a dead simulator
  // actually leaves behind.
  await api.database.sql(
    "update simulation set heartbeat_at = now() - interval '10 minutes' where id = $1",
    [simulationId],
  );

  return { ada, key, runId, simulationId, api };
}

describe("the standing sweep", () => {
  it("wakes the voice fleet after a run is ready", async () => {
    let wakes = 0;
    const made = await anOrphan("voice-fleet-run-trigger", {
      orphanSweepIntervalMilliseconds: 60 * 60_000,
      wakeVoiceFleet: () => { wakes += 1; },
    });
    api = made.api;

    expect(wakes).toBe(2);
  });

  it("wakes the voice fleet at startup and on cadence while a sweep is held", async () => {
    vi.useFakeTimers();
    let wakes = 0;
    let release: (() => void) | undefined;
    const sweep = startOrphanSweep({
      log: capturingLog(),
      intervalMilliseconds: 20,
      sweep: () => new Promise((resolve) => {
        release = () => resolve([]);
      }),
      settleAgentPovBound: async () => [],
      wakeVoiceFleet: () => { wakes += 1; },
    });
    try {
      expect(wakes).toBe(1);
      await vi.advanceTimersByTimeAsync(20);
      expect(wakes).toBe(2);
      await vi.advanceTimersByTimeAsync(60);
      expect(wakes).toBe(5);
    } finally {
      release?.();
      await sweep.stop();
      vi.useRealTimers();
    }
  });

  it("reports exhausted agent evidence as a collection error", async () => {
    vi.useFakeTimers();
    const log = capturingLog();
    const sweep = startOrphanSweep({
      log,
      intervalMilliseconds: 20,
      sweep: async () => [],
      settleAgentPovBound: async () => [{
        id: "sim_evidence_error",
        runId: "run_evidence_error",
        agentPovFiled: false,
        outcome: "evidence_error",
      }],
    });
    try {
      await vi.advanceTimersByTimeAsync(20);
      expect(log.infos).toHaveLength(1);
      expect(log.infos[0]?.message).toContain(
        "filed an evidence collection error",
      );
    } finally {
      await sweep.stop();
      vi.useRealTimers();
    }
  });

  it("runs with the server, so an orphan lands without anybody asking", async () => {
    const { ada, key, runId, simulationId, api: running } = await anOrphan(
      "sweep_wired",
      { orphanSweepIntervalMilliseconds: 100 },
    );

    // Nothing calls anything from here: the loop the server started is the
    // only mover, on the shortened cadence the test asked the server for.
    await vi.waitFor(
      async () => {
        const row = await getSimulation(contextFor(ada, "member"), simulationId);
        expect(row?.status).toBe("failed");
        expect(row?.endingReason).toBe("orphaned");
        expect(row?.executionFailure).toBe(
          "The simulator stopped reporting before this simulation finished.",
        );
      },
      { timeout: 5_000, interval: 100 },
    );

    const header = await ask(running.app, "GET", `/v1/runs/${runId}`, key);
    expect(header.body.status).toBe("completed");
  });

  it("ships with a cadence near thirty seconds, inside the staleness window", () => {
    // The window is 150s of silence; a sweep every ~30s means an orphan is
    // named within about three minutes of its simulator dying, and a live
    // simulator restarting after an API outage has a whole interval of
    // landing heartbeats before the first sweep reads its silence.
    expect(SWEEP_INTERVAL_MILLISECONDS).toBe(30_000);
  });

  it("says what it swept when it swept something, and nothing otherwise", async () => {
    const { simulationId, runId } = await anOrphan("sweep_speaks");

    const log = capturingLog();
    const sweep = startOrphanSweep({ log, intervalMilliseconds: 50 });
    try {
      await vi.waitFor(() => expect(log.infos.length).toBeGreaterThan(0), {
        timeout: 5_000,
        interval: 25,
      });

      const said = log.infos[0];
      expect(said?.message).toContain("orphaned");
      expect(said?.details.simulationIds).toContain(simulationId);
      expect(said?.details.runIds).toContain(runId);

      // Later ticks find nothing, and a quiet queue is not news.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(log.infos).toHaveLength(1);
      expect(log.errors).toHaveLength(0);
    } finally {
      await sweep.stop();
    }
  });

  it("holds stop for a sweep that outlives the cadence, starting nothing beside it", async () => {
    // A sweep held open from the seam, the way a stalled store would hold
    // one — the one condition a real store cannot produce on cue.
    const log = capturingLog();
    let release: (() => void) | undefined;
    let started = 0;
    const sweep = startOrphanSweep({
      log,
      intervalMilliseconds: 25,
      sweep: () => {
        started += 1;
        return new Promise((resolve) => {
          release = () => resolve([]);
        });
      },
    });
    try {
      // The first tick starts and holds; the cadence keeps firing meanwhile
      // and must start no second sweep beside the stalled one.
      await vi.waitFor(() => expect(started).toBe(1), {
        timeout: 5_000,
        interval: 10,
      });
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(started).toBe(1);

      // stop() during the held sweep settles only once the sweep does: the
      // skipped ticks in between must not have handed stop an
      // already-settled promise to await instead of the running one.
      let stopped = false;
      const stopping = sweep.stop().then(() => {
        stopped = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(stopped).toBe(false);

      release?.();
      await stopping;
      expect(stopped).toBe(true);
    } finally {
      release?.();
      await sweep.stop();
    }
  });

  it("outlives a sweep that fails, saying so instead of dying", async () => {
    // No store at all — the sharpest form of the one Tuesday this loop will
    // actually meet. Every tick fails, and every failure must cost that tick
    // and nothing after it.
    const log = capturingLog();
    const sweep = startOrphanSweep({ log, intervalMilliseconds: 50 });
    try {
      await vi.waitFor(() => expect(log.errors.length).toBeGreaterThan(1), {
        timeout: 5_000,
        interval: 25,
      });
      expect(log.errors[0]?.message).toContain("sweep");
      expect(log.infos).toHaveLength(0);
    } finally {
      await sweep.stop();
    }
  });
});
