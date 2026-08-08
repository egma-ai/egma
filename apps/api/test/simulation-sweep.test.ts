import { claimSimulations, createPersona, getSimulation } from "@egma/db";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  startOrphanSweep,
  SWEEP_INTERVAL_MILLISECONDS,
} from "../src/simulation-sweep.ts";
import { createApi, type TestApi, type TestApiOptions } from "./support/api.ts";
import {
  contextFor,
  NEUTRAL_TRAITS,
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
function capturingLog(): {
  infos: { details: Record<string, unknown>; message: string }[];
  errors: { details: Record<string, unknown>; message: string }[];
  info(details: object, message: string): void;
  error(details: object, message: string): void;
} {
  const infos: { details: Record<string, unknown>; message: string }[] = [];
  const errors: { details: Record<string, unknown>; message: string }[] = [];
  return {
    infos,
    errors,
    info(details, message) {
      infos.push({ details: details as Record<string, unknown>, message });
    },
    error(details, message) {
      errors.push({ details: details as Record<string, unknown>, message });
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

  const registered = await ask(api.app, "POST", "/api/agents", key, {
    name: "Front desk",
    connection: {
      type: "retell",
      modality: "chat",
      config: { retellAgentId: "agent_in_retell_1" },
      credentials: { apiKey: "retell-secret-A1B2C3D4WXYZ" },
    },
  });
  expect(registered.statusCode, JSON.stringify(registered.body)).toBe(201);
  const connectionId = (registered.body.connection as { id: string }).id;

  await createPersona(contextFor(ada, "member"), {
    name: "Impatient Rita",
    traits: NEUTRAL_TRAITS,
  });
  const pushed = await ask(api.app, "POST", "/api/tests", key, {
    name: "Reschedules a booked appointment",
    scenario: "Their cleaning is booked for Thursday and has to move.",
    expected_behaviors: ["confirms the new time back before finishing"],
    personas: ["Impatient Rita"],
  });
  expect(pushed.statusCode, JSON.stringify(pushed.body)).toBe(201);

  const started = await ask(api.app, "POST", "/api/runs", key, {
    connection: connectionId,
    test_versions: [String(pushed.body.version_id)],
  });
  expect(started.statusCode, JSON.stringify(started.body)).toBe(201);
  const simulations = started.body.simulations as { id: string }[];
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

  return { ada, key, runId: String(started.body.id), simulationId, api };
}

describe("the standing sweep", () => {
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
      },
      { timeout: 5_000, interval: 100 },
    );

    const header = await ask(running.app, "GET", `/api/runs/${runId}`, key);
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
      sweep.stop();
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
      sweep.stop();
    }
  });
});
