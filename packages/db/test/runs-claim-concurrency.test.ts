import { newId } from "@egma/ids";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  claimSimulations,
  createAgent,
  createPersona,
  startRun,
  type AuthContext,
} from "@egma/db";

import {
  createConnectedDatabase,
  type MigratedDatabase,
} from "./support/database.ts";
import { seedOrganization, seedUser } from "./support/tenancy.ts";

/**
 * Two simulators, one queue. The claim is atomic — `SKIP LOCKED` underneath —
 * so racing claimants split the queue between them and never take the same
 * conversation twice. These tests race real transactions on a real Postgres,
 * because the guarantee under test is Postgres's locking, not egma's code.
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
let personaId: string;

async function oneQueuedSimulation(): Promise<string> {
  const started = await startRun(auth, {
    agentId,
    connectionId,
    personaIds: [personaId],
  });
  const simulation = started.simulations[0];
  if (simulation === undefined) throw new Error("the run has no simulation");
  return simulation.id;
}

beforeAll(async () => {
  database = await createConnectedDatabase("runs_claim");

  await seedOrganization(database, organizationId, [
    { id: projectId, slug: "default" },
  ]);
  await seedUser(database, ada, "ada@acme.example");

  const created = await createAgent(auth, {
    name: "Front desk",
    connection: {
      type: "retell",
      modality: "chat",
      config: { retellAgentId: "agent_in_retell_1" },
      credentials: { apiKey: "retell-secret-A1B2C3D4WXYZ" },
    },
  });
  agentId = created.id;
  connectionId = created.connection?.id ?? "";

  personaId = (
    await createPersona(auth, {
      name: "Impatient Rita",
      traits: {
        personality: "Speaks plainly.",
        language: "en-US",
        voice: {
          provider: "elevenlabs",
          voiceId: "EXAVITQu4vr4xnSDxMaL",
          speed: 1,
        },
      },
    })
  ).id;
});

afterAll(async () => {
  await database.drop();
});

describe("two claimants on one queued simulation", () => {
  it("exactly one wins, and the loser walks away empty-handed", async () => {
    const simulationId = await oneQueuedSimulation();

    const [blue, green] = await Promise.all([
      claimSimulations(auth, { claimant: "simulator-blue-1", capacity: 1 }),
      claimSimulations(auth, { claimant: "simulator-green-2", capacity: 1 }),
    ]);

    const claims = [...blue, ...green].filter(
      (simulation) => simulation.id === simulationId,
    );
    expect(claims).toHaveLength(1);
    expect([blue.length, green.length].sort()).toEqual([0, 1]);
  });
});

describe("a fleet draining a queue", () => {
  it("splits it without overlap and without loss", async () => {
    const queued = new Set<string>();
    for (let i = 0; i < 6; i += 1) {
      queued.add(await oneQueuedSimulation());
    }

    const fleet = await Promise.all(
      ["simulator-a", "simulator-b", "simulator-c"].map((claimant) =>
        claimSimulations(auth, { claimant, capacity: 2 }),
      ),
    );

    const taken = fleet.flat().map((simulation) => simulation.id);
    // No conversation twice, and every claimed one was really queued.
    expect(new Set(taken).size).toBe(taken.length);
    for (const id of taken) {
      expect(queued.has(id)).toBe(true);
    }
    // Three claimants of capacity two drain all six between them.
    expect(taken.length).toBe(6);

    // And each claimed row says who holds it.
    for (const [index, claims] of fleet.entries()) {
      const claimant = ["simulator-a", "simulator-b", "simulator-c"][index];
      for (const simulation of claims) {
        expect(simulation.claimedBy).toBe(claimant);
        expect(simulation.status).toBe("claimed");
      }
    }
  });
});
