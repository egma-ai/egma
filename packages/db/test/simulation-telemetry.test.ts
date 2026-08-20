import { newId } from "@egma/ids";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  claimSimulations,
  createAgent,
  createPersona,
  createTest,
  resolveSimulationStanding,
  startRun,
  sweepOrphanedSimulations,
  type AuthContext,
} from "@egma/db";

import {
  createConnectedDatabase,
  type MigratedDatabase,
} from "./support/database.ts";
import { seedJudge, seedOrganization, seedUser } from "./support/tenancy.ts";

/**
 * The standing resolver's telemetry duty: where a simulation's arriving spans
 * file.
 *
 * The OTLP ingest door meets the simulator's spans holding no customer
 * context at all — the service token resolves to nobody — and each arriving
 * resource names only a simulation. The door asks `resolveSimulationStanding`
 * the same way the report and heartbeat doors do, and files the spans under
 * what it answers. The resolver's own lifecycle answers are proven beside the
 * report machinery in `runs.test.ts`; what this file pins down is the part
 * the telemetry door leans on: the answer carries the row's pins — the run,
 * the agent, the versions the conversation executed — so a span row is
 * stamped from egma's own row and never from the wire; it reaches every
 * customer's simulations, because the evidence door stands behind them all;
 * and it answers for a row the sweep already called orphaned, because a
 * late-returning orphan's spans are evidence and are kept.
 */

let database: MigratedDatabase;

const acme = { organization: newId("org"), project: newId("prj") };
const globex = { organization: newId("org"), project: newId("prj") };

const ada = newId("usr");
const grace = newId("usr");

function actingAsAcme(): AuthContext {
  return {
    userId: ada,
    organizationId: acme.organization,
    projectId: acme.project,
    role: "member",
    via: "session",
  };
}

function actingAsGlobex(): AuthContext {
  return {
    userId: grace,
    organizationId: globex.organization,
    projectId: globex.project,
    role: "member",
    via: "session",
  };
}

const NEUTRAL_TRAITS = {
  personality: "Speaks plainly, stays patient, asks one question at a time.",
  language: "en-US",
  voice: {
    provider: "elevenlabs",
    voiceId: "EXAVITQu4vr4xnSDxMaL",
    speed: 1,
  },
} as const;

type SeededSimulation = {
  readonly runId: string;
  readonly simulationId: string;
  readonly agentId: string;
  readonly testVersionId: string;
  readonly personaVersionId: string;
};

/** One queued conversation, with everything a run needs seeded around it. */
async function oneQueuedSimulation(
  auth: AuthContext,
  label: string,
): Promise<SeededSimulation> {
  const created = await createAgent(auth, {
    name: `Front desk ${label}`,
    connection: {
      agentPlatform: "retell",
      connectionKind: "retell_chat_api",
      accessVariant: "retell_chat_api.api_key",
      modality: "chat",
      config: { retellAgentId: `agent_${label}` },
      credentials: { apiKey: `retell-secret-${label}` },
    },
  });

  const personaId = (
    await createPersona(auth, {
      name: `Impatient Rita ${label}`,
      traits: NEUTRAL_TRAITS,
    })
  ).id;

  const testVersionId = (
    await createTest(auth, {
      name: `Reschedules ${label}`,
      scenario:
        "Their cleaning is booked for Thursday morning and has to move to any afternoon next week.",
      expectedBehaviors: ["confirms the new time back before finishing"],
      personaIds: [personaId],
    })
  ).versionId;

  const started = await startRun(auth, {
    agentId: created.id,
    connectionId: created.connection?.id ?? "",
    testVersionIds: [testVersionId],
  });
  const simulation = started.simulations[0];
  if (simulation === undefined) throw new Error("the run has no simulation");

  return {
    runId: started.id,
    simulationId: simulation.id,
    agentId: created.id,
    testVersionId,
    personaVersionId: simulation.personaVersionId,
  };
}

let ours: SeededSimulation;
let elsewhere: SeededSimulation;

beforeAll(async () => {
  database = await createConnectedDatabase("simulation_telemetry");
  await seedOrganization(database, acme.organization, [
    { id: acme.project, slug: "acme" },
  ]);
  await seedOrganization(database, globex.organization, [
    { id: globex.project, slug: "globex" },
  ]);
  await seedUser(database, ada, "ada@acme.example");
  await seedUser(database, grace, "grace@globex.example");
  await seedJudge({ ...actingAsAcme(), role: "admin" });
  await seedJudge({ ...actingAsGlobex(), role: "admin" });
  // No running graders: this is about where an arriving span files, which is
  // decided by the simulation's own pins long before anything judges it.

  ours = await oneQueuedSimulation(actingAsAcme(), "ours");
  elsewhere = await oneQueuedSimulation(actingAsGlobex(), "elsewhere");
});

afterAll(async () => {
  await database?.drop();
});

describe("where a simulation's telemetry files", () => {
  it("carries the pins a span row is stamped from, beside the narrowed context", async () => {
    const standing = await resolveSimulationStanding(ours.simulationId);

    expect(standing).toMatchObject({
      id: ours.simulationId,
      runId: ours.runId,
      agentId: ours.agentId,
      testVersionId: ours.testVersionId,
      personaVersionId: ours.personaVersionId,
    });
    // The context the spans are then filed under: this row's customer and no
    // more, marked as the simulator's own doing — the claim's context,
    // derived again from the row.
    expect(standing?.auth).toEqual({
      userId: "simulator",
      organizationId: acme.organization,
      projectId: acme.project,
      role: "member",
      via: "simulator",
    });
  });

  it("reaches every customer's simulations, because the evidence door stands behind them all", async () => {
    const here = await resolveSimulationStanding(ours.simulationId);
    const there = await resolveSimulationStanding(elsewhere.simulationId);

    expect(here?.auth.organizationId).toBe(acme.organization);
    expect(there?.auth.organizationId).toBe(globex.organization);
    expect(there?.runId).toBe(elsewhere.runId);
  });

  /**
   * The orphan case, by name: a swept simulator that comes back has its late
   * spans kept as evidence even as its late lifecycle claims are refused —
   * so the row must still answer, whatever the sweep said about it.
   */
  it("answers for a simulation the sweep already called orphaned", async () => {
    const abandoned = await oneQueuedSimulation(actingAsAcme(), "abandoned");
    const claimant = "simulator-telemetry-1";
    const claims = await claimSimulations({ claimant, capacity: 50 });
    const claimed = claims.find((claim) => claim.id === abandoned.simulationId);
    if (claimed === undefined) throw new Error("the claim missed the simulation");

    // Silence long past the window, then the sweep tells the truth about it.
    await database.sql(
      `update simulation set heartbeat_at = now() - interval '1 hour' where id = $1`,
      [abandoned.simulationId],
    );
    const swept = await sweepOrphanedSimulations();
    expect(swept.map((row) => row.id)).toContain(abandoned.simulationId);

    const standing = await resolveSimulationStanding(abandoned.simulationId);
    expect(standing).toMatchObject({
      runId: abandoned.runId,
      status: "failed",
      endingReason: "orphaned",
      testVersionId: abandoned.testVersionId,
    });
  });
});
