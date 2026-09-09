import { newId } from "@egma/ids";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  claimSimulations,
  createAgent,
  createPersona,
  createTest,
  createTestSuite,
  getRun,
  getSimulation,
  listSimulations,
  startRun,
  sweepOrphanedSimulations,
  type AuthContext,
} from "@egma/db";

import {
  createConnectedDatabase,
  type MigratedDatabase,
} from "./support/database.ts";
import { seedOrganization, seedUser } from "./support/tenancy.ts";

/**
 * Race real PostgreSQL sweeps over the same orphaned simulations. Guarded
 * updates and ordered run processing must prevent duplicate finalization
 * and deadlocks in these cases.
 */

let database: MigratedDatabase;

const organizationId = newId("org");
const projectId = newId("prj");
const ada = newId("usr");

const auth: AuthContext = {
  userId: ada,
  organizationId,
  projectId,
  role: "member",
  via: "session",
};

let agentId: string;
let connectionId: string;
let suiteId: string;

async function oneQueuedSimulation(): Promise<{
  runId: string;
  simulationId: string;
}> {
  const started = await startRun(auth, {
    suiteId,
    agentId,
    connectionId,
  });
  const simulation = (await listSimulations(auth, started.id))?.items[0];
  if (simulation === undefined) throw new Error("the run has no simulation");
  return { runId: started.id, simulationId: simulation.id };
}

beforeAll(async () => {
  database = await createConnectedDatabase("sweep_race");

  await seedOrganization(database, organizationId, [
    { id: projectId, slug: "default" },
  ]);
  await seedUser(database, ada, "ada@acme.example");
  // What races here is two sweeps over one set of orphans. Failed simulations
  // create no grading work, so the guarantee under test is only Postgres's
  // guarded lifecycle update and run finalization.

  const created = await createAgent(auth, {
    agentPlatform: "livekit",
    name: "Front desk",
    connection: {
      agentPlatform: "livekit",
      connectionType: "livekit_room",
      accessVariant: "livekit_room.project_credentials",
      modality: "chat",
      config: { url: "wss://test.livekit.cloud", agentName: "agent_in_retell_1" },
      credentials: { apiKey: "retell-secret-A1B2C3D4WXYZ", apiSecret: "livekit-secret-A1B2C3D4WXYZ" },
    },
  });
  agentId = created.id;
  connectionId = created.connection?.id ?? "";

  const personaId = (
    await createPersona(auth, {
      name: "Impatient Rita",
      identityName: "Sam Poole",
      personality: "Speaks plainly.",
      language: "en-US",
    })
  ).id;

  suiteId = (await createTestSuite(auth, { name: "Sweep concurrency" })).id;
  await createTest(auth, {
    suiteId,
    name: "Reschedules",
    scenario: "Their cleaning is booked for Thursday and has to move.",
    expectedBehaviors: ["confirms the new time back before finishing"],
    personaIds: [personaId],
  });
});

afterAll(async () => {
  await database.drop();
});

describe("two sweepers racing over one set of orphans", () => {
  it("end every orphan exactly once between them, and neither breaks", async () => {
    const orphans = [
      await oneQueuedSimulation(),
      await oneQueuedSimulation(),
      await oneQueuedSimulation(),
    ];
    await claimSimulations({ claimant: "simulator-that-died", capacity: 50 });
    await database.sql(
      "update simulation set heartbeat_at = now() - interval '10 minutes' where id = any($1)",
      [orphans.map((orphan) => orphan.simulationId)],
    );

    const [first, second] = await Promise.all([
      sweepOrphanedSimulations(),
      sweepOrphanedSimulations(),
    ]);

    // Between the two answers, each orphan appears exactly once: whichever
    // sweep reached a row second re-read it as already failed and left it
    // alone, so nothing was ended twice and nothing was missed.
    const taken = [...first, ...second]
      .map((simulation) => simulation.id)
      .filter((id) => orphans.some((orphan) => orphan.simulationId === id));
    expect(new Set(taken).size).toBe(taken.length);
    expect(taken).toHaveLength(orphans.length);

    for (const orphan of orphans) {
      const row = await getSimulation(auth, orphan.simulationId);
      expect(row?.status).toBe("failed");
      expect(row?.endingReason).toBe("orphaned");

      // And each run finalized once, its counts written by whichever sweep
      // ended its last conversation — the header's trigger refuses a second
      // write, so a double finalization would also have broken a sweep.
      const header = await getRun(auth, orphan.runId);
      expect(header?.status).toBe("completed");
      expect(header?.failedCount).toBe(1);
      expect(header?.finishedAt).toBeInstanceOf(Date);
    }
  });
});
