import { newId } from "@egma/ids";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  claimSimulations,
  createAgent,
  createPersona,
  createTest,
  createTestSuite,
  getSimulation,
  listSimulations,
  startRun,
  type AuthContext,
} from "@egma/db";

import {
  createConnectedDatabase,
  type MigratedDatabase,
} from "./support/database.ts";
import { seedOrganization, seedUser } from "./support/tenancy.ts";

/**
 * Two simulators, one queue — the deployment's whole queue, because the claim
 * is instance-wide. The claim is atomic — `SKIP LOCKED` underneath — so racing
 * claimants split it between them and never take the same conversation twice.
 * These tests race real transactions on a real Postgres, because the guarantee
 * under test is Postgres's locking, not egma's code.
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
let suiteId: string;

async function oneQueuedSimulation(): Promise<string> {
  const started = await startRun(auth, {
    suiteId,
    agentId,
    connectionId,
    idempotencyKey: newId("run"),
  });
  const simulation = (await listSimulations(auth, started.id))?.items[0];
  if (simulation === undefined) throw new Error("the run has no simulation");
  return simulation.id;
}

beforeAll(async () => {
  database = await createConnectedDatabase("runs_claim");

  await seedOrganization(database, organizationId, [
    { id: projectId, slug: "default" },
  ]);
  await seedUser(database, ada, "ada@acme.example");
  // No project grader is needed: what races here is two claimants over one
  // queue, and the guarantee under test is Postgres's locking. Nothing in this
  // file reaches grading.

  const created = await createAgent(auth, {
    name: "Front desk",
    connection: {
      agentPlatform: "retell",
      connectionKind: "retell_chat_api",
      accessVariant: "retell_chat_api.api_key",
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
      traits: { personality: "Speaks plainly.", language: "en-US" },
    })
  ).id;

  suiteId = (await createTestSuite(auth, { name: "Claim race" })).id;
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

describe("two claimants on one queued simulation", () => {
  it("exactly one wins, and the loser walks away empty-handed", async () => {
    const simulationId = await oneQueuedSimulation();

    const [blue, green] = await Promise.all([
      claimSimulations({ claimant: "simulator-blue-1", capacity: 1 }),
      claimSimulations({ claimant: "simulator-green-2", capacity: 1 }),
    ]);

    const claims = [...blue, ...green].filter(
      (claim) => claim.id === simulationId,
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
        claimSimulations({ claimant, capacity: 2 }),
      ),
    );

    const taken = fleet.flat().map((claim) => claim.id);
    // No conversation twice, and every claimed one was really queued.
    expect(new Set(taken).size).toBe(taken.length);
    for (const id of taken) {
      expect(queued.has(id)).toBe(true);
    }
    // Three claimants of capacity two drain all six between them.
    expect(taken.length).toBe(6);

    // And each claim says who holds it, on the answer and on the row.
    for (const [index, claims] of fleet.entries()) {
      const claimant = ["simulator-a", "simulator-b", "simulator-c"][index];
      for (const claim of claims) {
        expect(claim.claimedBy).toBe(claimant);
        expect((await getSimulation(auth, claim.id))?.status).toBe("claimed");
      }
    }
  });
});
