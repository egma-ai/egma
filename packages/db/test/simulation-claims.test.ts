import { newId } from "@egma/ids";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  claimSimulations,
  createAgent,
  createPersona,
  createTest,
  getPersonaVersion,
  getRun,
  getSimulation,
  getSimulationTestVersion,
  removeConnection,
  resolveSimulationConnection,
  startRun,
  updateConnection,
  type AuthContext,
  type SimulationClaim,
} from "@egma/db";

import {
  createConnectedDatabase,
  type MigratedDatabase,
} from "./support/database.ts";
import { seedOrganization, seedUser } from "./support/tenancy.ts";

/**
 * The simulator's claim, instance-wide, and the door its credentials come
 * through.
 *
 * The simulator stands behind every organization on the deployment at once
 * and holds no credential, so its claim takes no context and reaches every
 * customer's queue — and what makes that safe is what these tests pin down:
 * a claim carries out identifiers and no content, every claimed simulation
 * arrives with a context narrowed to its own tenancy, and the one door to a
 * connection's plaintext refuses every caller whose context did not come
 * from a claim.
 */

let database: MigratedDatabase;

/** Two customers on one deployment, so "instance-wide" is observable. */
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

const SCENARIO =
  "Their cleaning is booked for Thursday morning and has to move to any afternoon next week.";

type Seeded = {
  readonly agentId: string;
  readonly connectionId: string;
  readonly personaId: string;
  readonly testVersionId: string;
};

/** An agent, somebody to call, and a test — everything one run needs. */
async function seedCustomer(
  auth: AuthContext,
  apiKey: string,
): Promise<Seeded> {
  const created = await createAgent(auth, {
    name: "Front desk",
    connection: {
      type: "retell",
      modality: "chat",
      config: { retellAgentId: `agent_${apiKey}` },
      credentials: { apiKey },
    },
  });

  const personaId = (
    await createPersona(auth, { name: "Impatient Rita", traits: NEUTRAL_TRAITS })
  ).id;

  const testVersionId = (
    await createTest(auth, {
      name: "Reschedules",
      scenario: SCENARIO,
      expectedBehaviors: ["confirms the new time back before finishing"],
      personaIds: [personaId],
    })
  ).versionId;

  return {
    agentId: created.id,
    connectionId: created.connection?.id ?? "",
    personaId,
    testVersionId,
  };
}

let acmeSeed: Seeded;
let globexSeed: Seeded;

async function oneQueuedSimulation(
  auth: AuthContext,
  seed: Seeded,
): Promise<{ runId: string; simulationId: string }> {
  const started = await startRun(auth, {
    agentId: seed.agentId,
    connectionId: seed.connectionId,
    testVersionIds: [seed.testVersionId],
  });
  const simulation = started.simulations[0];
  if (simulation === undefined) throw new Error("the run has no simulation");
  return { runId: started.id, simulationId: simulation.id };
}

/** Claim everything outstanding and hand back the one claim asked about. */
async function claimOne(
  simulationId: string,
  claimant = "simulator-blue-1",
): Promise<SimulationClaim> {
  const claims = await claimSimulations({ claimant, capacity: 50 });
  const ours = claims.find((claim) => claim.id === simulationId);
  if (ours === undefined) throw new Error("the claim missed the simulation under test");
  return ours;
}

beforeAll(async () => {
  database = await createConnectedDatabase("simulation_claims");

  await seedOrganization(database, acme.organization, [
    { id: acme.project, slug: "default" },
  ]);
  await seedOrganization(database, globex.organization, [
    { id: globex.project, slug: "default" },
  ]);
  await seedUser(database, ada, "ada@acme.example");
  await seedUser(database, grace, "grace@globex.example");

  acmeSeed = await seedCustomer(actingAsAcme(), "retell-secret-A1B2C3D4WXYZ");
  globexSeed = await seedCustomer(actingAsGlobex(), "retell-secret-E5F6G7H8UVWX");
});

afterAll(async () => {
  await database.drop();
});

describe("the instance-wide claim", () => {
  it("reaches every customer's queue in one ask, and narrows each claim to its own", async () => {
    const acmeRun = await oneQueuedSimulation(actingAsAcme(), acmeSeed);
    const globexRun = await oneQueuedSimulation(actingAsGlobex(), globexSeed);

    const claims = await claimSimulations({
      claimant: "simulator-blue-1",
      capacity: 50,
    });

    const ours = claims.filter((claim) =>
      [acmeRun.simulationId, globexRun.simulationId].includes(claim.id),
    );
    expect(ours).toHaveLength(2);

    const byId = new Map(ours.map((claim) => [claim.id, claim]));
    const acmeClaim = byId.get(acmeRun.simulationId);
    const globexClaim = byId.get(globexRun.simulationId);

    // Each claim carries the context the work is done under, built from the
    // claimed row and from nothing the claimant said.
    expect(acmeClaim?.organizationId).toBe(acme.organization);
    expect(acmeClaim?.auth).toEqual({
      userId: "simulator",
      organizationId: acme.organization,
      projectId: acme.project,
      role: "member",
      via: "simulator",
    });
    expect(globexClaim?.organizationId).toBe(globex.organization);
    expect(globexClaim?.auth).toEqual({
      userId: "simulator",
      organizationId: globex.organization,
      projectId: globex.project,
      role: "member",
      via: "simulator",
    });
  });

  it("carries out identifiers and claim stamps, and no content", async () => {
    const { runId, simulationId } = await oneQueuedSimulation(
      actingAsAcme(),
      acmeSeed,
    );
    const claim = await claimOne(simulationId);

    expect(claim.runId).toBe(runId);
    expect(claim.agentId).toBe(acmeSeed.agentId);
    expect(claim.connectionId).toBe(acmeSeed.connectionId);
    expect(claim.personaId).toBe(acmeSeed.personaId);
    expect(claim.personaVersionId).toMatch(/^prsv_/);
    expect(claim.testVersionId).toBe(acmeSeed.testVersionId);
    expect(claim.connectionType).toBe("retell");
    expect(claim.modality).toBe("chat");
    expect(claim.claimedBy).toBe("simulator-blue-1");
    expect(claim.claimedAt).toBeInstanceOf(Date);

    // No transcript, no configuration, nothing a customer wrote. The spec is
    // assembled afterwards, through the scoped reads, under the claim's own
    // context — the claim itself hands over nothing to leak.
    expect(claim).not.toHaveProperty("transcript");
    expect(claim).not.toHaveProperty("events");
    expect(claim).not.toHaveProperty("metrics");
  });

  it("stamps the row and starts the run, exactly as the scoped claim did", async () => {
    const { runId, simulationId } = await oneQueuedSimulation(
      actingAsAcme(),
      acmeSeed,
    );
    const claim = await claimOne(simulationId, "simulator-green-2");

    const row = await getSimulation(actingAsAcme(), simulationId);
    expect(row?.status).toBe("claimed");
    expect(row?.claimedBy).toBe("simulator-green-2");
    expect(row?.claimedAt).toBeInstanceOf(Date);
    expect(row?.heartbeatAt).toBeInstanceOf(Date);

    const started = await getRun(actingAsAcme(), runId);
    expect(started?.status).toBe("running");
    expect(started?.startedAt).toBeInstanceOf(Date);

    expect(claim.claimedBy).toBe("simulator-green-2");
  });

  it("hands back a context the whole spec assembly can read through", async () => {
    const { simulationId } = await oneQueuedSimulation(actingAsAcme(), acmeSeed);
    const claim = await claimOne(simulationId);

    const personaVersion = await getPersonaVersion(
      claim.auth,
      claim.personaVersionId,
    );
    expect(personaVersion?.traits.personality).toBe(NEUTRAL_TRAITS.personality);

    const testVersion = await getSimulationTestVersion(claim.auth, claim.id);
    expect(testVersion?.scenario).toBe(SCENARIO);
  });

  it("takes a capacity between one and fifty, and a named claimant", async () => {
    await expect(
      claimSimulations({ claimant: "simulator-blue-1", capacity: 0 }),
    ).rejects.toThrow(/between 1 and 50/);
    await expect(
      claimSimulations({ claimant: "simulator-blue-1", capacity: 51 }),
    ).rejects.toThrow(/between 1 and 50/);
    await expect(
      claimSimulations({ claimant: "   ", capacity: 1 }),
    ).rejects.toThrow(/needs a name/);
  });
});

describe("the connection door", () => {
  it("answers the claimed row's own connection, credentials unsealed", async () => {
    const { simulationId } = await oneQueuedSimulation(actingAsAcme(), acmeSeed);
    const claim = await claimOne(simulationId);

    const reached = await resolveSimulationConnection(claim.auth, claim.id);
    expect(reached?.connectionId).toBe(acmeSeed.connectionId);
    expect(reached?.type).toBe("retell");
    expect(reached?.config).toEqual({
      retellAgentId: "agent_retell-secret-A1B2C3D4WXYZ",
    });
    expect(reached?.credentials).toEqual({ apiKey: "retell-secret-A1B2C3D4WXYZ" });
  });

  it("refuses every context that is not the simulator's own", async () => {
    const { simulationId } = await oneQueuedSimulation(actingAsAcme(), acmeSeed);
    const claim = await claimOne(simulationId);

    // A person's session, a key, and the grading engine — each holds a
    // context that can read plenty, and none of them conducts a simulation,
    // so none of them is answered a live provider secret.
    const session = actingAsAcme();
    const apiKey: AuthContext = { ...session, via: "api_key" };
    const engine: AuthContext = {
      userId: "engine",
      organizationId: acme.organization,
      projectId: acme.project,
      role: "viewer",
      via: "engine",
    };

    for (const auth of [session, apiKey, engine]) {
      await expect(resolveSimulationConnection(auth, claim.id)).rejects.toThrow(
        /simulator/,
      );
    }
  });

  it("cannot be walked out of the claim's own tenancy", async () => {
    const acmeRun = await oneQueuedSimulation(actingAsAcme(), acmeSeed);
    const globexRun = await oneQueuedSimulation(actingAsGlobex(), globexSeed);

    const claims = await claimSimulations({
      claimant: "simulator-blue-1",
      capacity: 50,
    });
    const acmeClaim = claims.find((claim) => claim.id === acmeRun.simulationId);
    if (acmeClaim === undefined) throw new Error("the claim missed acme's row");

    // Acme's context, Globex's simulation: as absent as one that never was.
    expect(
      await resolveSimulationConnection(acmeClaim.auth, globexRun.simulationId),
    ).toBeUndefined();
  });

  it("answers nothing for a simulation nobody has claimed", async () => {
    const { simulationId } = await oneQueuedSimulation(actingAsAcme(), acmeSeed);

    // A context shaped like the claim's, for a row still queued: the door
    // opens during spec assembly, and before the claim there is nobody to
    // hand a secret to.
    const conductor: AuthContext = {
      userId: "simulator",
      organizationId: acme.organization,
      projectId: acme.project,
      role: "member",
      via: "simulator",
    };
    expect(
      await resolveSimulationConnection(conductor, simulationId),
    ).toBeUndefined();

    // Leave nothing queued behind for the claims that follow.
    await claimOne(simulationId);
  });

  it("answers nothing once the connection is gone", async () => {
    const { simulationId } = await oneQueuedSimulation(actingAsAcme(), acmeSeed);
    const claim = await claimOne(simulationId);

    await removeConnection(actingAsAcme(), acmeSeed.agentId, acmeSeed.connectionId);
    expect(
      await resolveSimulationConnection(claim.auth, claim.id),
    ).toBeUndefined();

    // Put the connection back for whatever runs after this file's tests.
    const restored = await createAgent(actingAsAcme(), {
      name: "Front desk restored",
      connection: {
        type: "retell",
        modality: "chat",
        config: { retellAgentId: "agent_restored_1" },
        credentials: { apiKey: "retell-secret-A1B2C3D4WXYZ" },
      },
    });
    acmeSeed = {
      ...acmeSeed,
      agentId: restored.id,
      connectionId: restored.connection?.id ?? "",
    };
  });

  it("unseals what a rotation resealed, trimmed as it was stored", async () => {
    const { simulationId } = await oneQueuedSimulation(actingAsAcme(), acmeSeed);

    // Rotated between the queueing and the claim — with a padded paste, the
    // way a rotation actually arrives — because credentials are the one thing
    // a claim reads live: connections are deliberately unversioned, and a
    // key rotated mid-run must be the key the next conversation dials with.
    await updateConnection(actingAsAcme(), acmeSeed.agentId, acmeSeed.connectionId, {
      credentials: { apiKey: "  retell-secret-rotated-9999ABCD  " },
    });

    const claim = await claimOne(simulationId);
    const reached = await resolveSimulationConnection(claim.auth, claim.id);
    expect(reached?.credentials).toEqual({
      apiKey: "retell-secret-rotated-9999ABCD",
    });
  });
});
