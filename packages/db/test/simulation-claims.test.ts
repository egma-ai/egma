import { newId } from "@egma/ids";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  addConnection,
  archiveAgent,
  claimSimulations,
  completeSimulation,
  createAgent,
  createPersona,
  createTest,
  getTest,
  setTestAgents,
  failSimulationDispatch,
  getPersonaVersion,
  getRun,
  getSimulation,
  getSimulationTestVersion,
  listGradingJobsForSimulation,
  listRunEvents,
  recordSimulationHeartbeat,
  archiveConnection,
  resolveSimulationConnection,
  startRun,
  startSimulation,
  sweepOrphanedSimulations,
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
  readonly testId: string;
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

  const authored = await createTest(auth, {
    name: "Reschedules",
    scenario: SCENARIO,
    expectedBehaviors: ["confirms the new time back before finishing"],
    personaIds: [personaId],
  });

  return {
    agentId: created.id,
    connectionId: created.connection?.id ?? "",
    personaId,
    testId: authored.id,
    testVersionId: authored.versionId,
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

describe("the instance-wide heartbeat and sweep", () => {
  it("reach every customer's held rows with no context at all, and answer no content", async () => {
    const acmeRun = await oneQueuedSimulation(actingAsAcme(), acmeSeed);
    const globexRun = await oneQueuedSimulation(actingAsGlobex(), globexSeed);
    await claimSimulations({ claimant: "simulator-blue-1", capacity: 50 });

    // A beat for each customer's row, made from nothing but the row's own id
    // and the claimant's name — the two things the wire actually carries.
    for (const simulationId of [acmeRun.simulationId, globexRun.simulationId]) {
      expect(
        await recordSimulationHeartbeat({
          simulationId,
          claimant: "simulator-blue-1",
        }),
      ).toEqual({ cancelRequested: false });
    }

    // Silence both, and one ask accounts for both customers — the sweep
    // stands where the simulator does, behind every organization at once.
    await database.sql(
      "update simulation set heartbeat_at = now() - interval '10 minutes' where id = any($1)",
      [[acmeRun.simulationId, globexRun.simulationId]],
    );
    const swept = await sweepOrphanedSimulations();
    const ids = swept.map((simulation) => simulation.id);
    expect(ids).toContain(acmeRun.simulationId);
    expect(ids).toContain(globexRun.simulationId);

    // Identifiers and no content: the answer names the row and its run so a
    // caller can say what it did, and carries nothing a customer wrote.
    for (const simulation of swept) {
      expect(Object.keys(simulation).sort()).toEqual(["id", "runId"]);
    }

    // And each customer's record landed inside that customer, as their own
    // reads tell it.
    expect(
      (await getSimulation(actingAsAcme(), acmeRun.simulationId))?.endingReason,
    ).toBe("orphaned");
    expect(
      (await getSimulation(actingAsGlobex(), globexRun.simulationId))
        ?.endingReason,
    ).toBe("orphaned");
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

  it("answers nothing once the connection is archived", async () => {
    const { simulationId } = await oneQueuedSimulation(actingAsAcme(), acmeSeed);
    const claim = await claimOne(simulationId);

    await archiveConnection(actingAsAcme(), acmeSeed.agentId, acmeSeed.connectionId);
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
    // The seeded test applied to the agent that has just been left behind, and
    // a run may only pair an agent with a test linked to it — so the coverage
    // moves with the connection.
    await setTestAgents(actingAsAcme(), acmeSeed.testId, {
      agentIds: [restored.id],
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

describe("the dispatch-failure landing", () => {
  it("lands the claim the platform could not hand over: failed, dispatch_failed, judged, counted", async () => {
    const { runId, simulationId } = await oneQueuedSimulation(
      actingAsAcme(),
      acmeSeed,
    );
    const claim = await claimOne(simulationId);

    const landed = await failSimulationDispatch(
      claim.auth,
      claim.id,
      claim.claimedBy,
    );
    expect(landed?.status).toBe("failed");
    expect(landed?.endingReason).toBe("dispatch_failed");
    expect(landed?.endedAt).toBeInstanceOf(Date);

    // Terminal like any other landing. The judgement is minted beside it —
    // a simulation that never ran is judged errored, never left unjudged…
    const jobs = await listGradingJobsForSimulation(actingAsAcme(), simulationId);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.status).toBe("pending");

    // …the run it was the last conversation of settles with counts that say
    // what happened — nothing completed, nothing pretending to have…
    const header = await getRun(actingAsAcme(), runId);
    expect(header?.status).toBe("completed");
    expect(header?.completedCount).toBe(0);
    expect(header?.failedCount).toBe(1);
    expect(header?.canceledCount).toBe(0);
    expect(header?.finishedAt).toBeInstanceOf(Date);

    // …and the record says so in the same words, in the same transaction.
    const feed = await listRunEvents(actingAsAcme(), runId, { after: 0 });
    expect(feed?.events.at(-2)?.status).toBe("failed");
    expect(feed?.events.at(-2)?.reason).toBe("dispatch_failed");
    expect(feed?.events.at(-1)?.status).toBe("completed");
  });

  it("fails one conversation, never the batch's run: the counts stay truthful around it", async () => {
    // A second caller on the same test, so one run holds two conversations —
    // one the platform hands over and one it cannot.
    const rosa = await createPersona(actingAsAcme(), {
      name: "Retired Rosa",
      traits: NEUTRAL_TRAITS,
    });
    const twoCallers = (
      await createTest(actingAsAcme(), {
        name: "Reschedules, twice over",
        scenario: SCENARIO,
        expectedBehaviors: ["confirms the new time back before finishing"],
        personaIds: [acmeSeed.personaId, rosa.id],
      })
    ).versionId;

    const started = await startRun(actingAsAcme(), {
      connectionId: acmeSeed.connectionId,
      testVersionIds: [twoCallers],
    });
    expect(started.simulations).toHaveLength(2);

    const claims = await claimSimulations({
      claimant: "simulator-blue-1",
      capacity: 50,
    });
    const [conducted, unbuildable] = started.simulations.map((simulation) =>
      claims.find((claim) => claim.id === simulation.id),
    );
    if (conducted === undefined || unbuildable === undefined) {
      throw new Error("the claim missed one of the run's simulations");
    }

    // The first conversation happens; the second cannot be handed over. The
    // dispatch landing is the run's last, so it is the one that settles it.
    await startSimulation(conducted.auth, conducted.id, conducted.claimedBy);
    await completeSimulation(conducted.auth, conducted.id, conducted.claimedBy, {
      endingReason: "persona_concluded",
    });
    await failSimulationDispatch(
      unbuildable.auth,
      unbuildable.id,
      unbuildable.claimedBy,
    );

    const header = await getRun(actingAsAcme(), started.id);
    expect(header?.status).toBe("completed");
    expect(header?.completedCount).toBe(1);
    expect(header?.failedCount).toBe(1);
    expect(header?.canceledCount).toBe(0);
  });

  it("refuses every context that did not come from a claim", async () => {
    const { simulationId } = await oneQueuedSimulation(actingAsAcme(), acmeSeed);
    const claim = await claimOne(simulationId);

    // A person's session, a key, and the grading engine: each may fail plenty
    // of its own, and none of them stands where dispatch happens — so none of
    // them may put the platform's confession on a row. The engine falls at
    // the permission gate before the door even asks how it came to exist,
    // because a viewer conducts nothing.
    const session = actingAsAcme();
    const apiKey: AuthContext = { ...session, via: "api_key" };
    const engine: AuthContext = {
      userId: "engine",
      organizationId: acme.organization,
      projectId: acme.project,
      role: "viewer",
      via: "engine",
    };

    for (const auth of [session, apiKey]) {
      await expect(
        failSimulationDispatch(auth, claim.id, claim.claimedBy),
      ).rejects.toThrow(/simulator/);
    }
    await expect(
      failSimulationDispatch(engine, claim.id, claim.claimedBy),
    ).rejects.toThrow(/may not start_and_cancel_runs/);
    expect(
      (await getSimulation(actingAsAcme(), simulationId))?.status,
    ).toBe("claimed");

    // Leave nothing half-open behind for the claims that follow.
    await failSimulationDispatch(claim.auth, claim.id, claim.claimedBy);
  });

  it("moves nothing for a stranger's claim, and nothing past the claimed moment", async () => {
    const { simulationId } = await oneQueuedSimulation(actingAsAcme(), acmeSeed);
    const claim = await claimOne(simulationId);

    // Another claimant's name on the ask: as absent as a row that never was.
    expect(
      await failSimulationDispatch(claim.auth, claim.id, "simulator-green-2"),
    ).toBeUndefined();
    expect(
      (await getSimulation(actingAsAcme(), simulationId))?.status,
    ).toBe("claimed");

    // And once the conversation is underway, dispatch already happened: a
    // failure from here is the simulator's to report, never this landing's.
    await startSimulation(claim.auth, claim.id, claim.claimedBy);
    expect(
      await failSimulationDispatch(claim.auth, claim.id, claim.claimedBy),
    ).toBeUndefined();
    expect(
      (await getSimulation(actingAsAcme(), simulationId))?.status,
    ).toBe("running");
  });
});

/**
 * A livekit connection's credentials come in two shapes, and the claim door is
 * the only place either is ever plaintext again.
 *
 * They live here rather than beside the connection factory's own tests because
 * the resolver those tests once used is gone on purpose — one door, one true
 * story. What the factory proves is that the secret goes in and never comes
 * back out of a read; what this proves is that the simulator, and only the
 * simulator holding a claim, gets it whole.
 */
describe("a livekit connection's two credential shapes, through the claim", () => {
  /** The livekit connection, and one queued simulation dialling through it. */
  async function queuedOverLiveKit(
    connection: Record<string, unknown>,
  ): Promise<string> {
    const added = await addConnection(actingAsAcme(), acmeSeed.agentId, {
      type: "livekit",
      modality: "voice",
      ...connection,
    } as never);
    const { simulationId } = await oneQueuedSimulation(actingAsAcme(), {
      ...acmeSeed,
      connectionId: added?.id ?? "",
    });
    return simulationId;
  }

  it("hands back the key and the secret together, both whole", async () => {
    const simulationId = await queuedOverLiveKit({
      config: { url: "wss://acme.livekit.cloud" },
      credentials: {
        apiKey: "livekit-key-A1B2C3D4WXYZ",
        apiSecret: "livekit-secret-E5F6G7H8QRST",
      },
    });

    const claim = await claimOne(simulationId);
    const reached = await resolveSimulationConnection(claim.auth, claim.id);

    expect(reached?.credentials).toEqual({
      apiKey: "livekit-key-A1B2C3D4WXYZ",
      apiSecret: "livekit-secret-E5F6G7H8QRST",
    });
  });

  it("hands back the endpoint's auth headers, which are a credential like any other", async () => {
    const simulationId = await queuedOverLiveKit({
      config: {
        url: "wss://acme.livekit.cloud",
        tokenEndpoint: "https://acme.example/livekit/token",
      },
      credentials: {
        headers: '{"Authorization":"Bearer acme-endpoint-token-9999"}',
      },
    });

    const claim = await claimOne(simulationId);
    const reached = await resolveSimulationConnection(claim.auth, claim.id);

    expect(reached?.credentials).toEqual({
      headers: '{"Authorization":"Bearer acme-endpoint-token-9999"}',
    });
  });

  it("hands back nothing at all when the endpoint needs no header", async () => {
    const simulationId = await queuedOverLiveKit({
      config: {
        url: "wss://acme.livekit.cloud",
        tokenEndpoint: "https://acme.example/livekit/open",
      },
    });

    const claim = await claimOne(simulationId);
    const reached = await resolveSimulationConnection(claim.auth, claim.id);

    expect(reached?.credentials).toBeNull();
  });
});

/**
 * What Archive does to work that is already moving.
 *
 * **Archiving a target is a decision about work in flight, not an edit to a
 * list**, and the two halves of that decision are settled in different places:
 * a queued conversation ends here, because nothing dispatched it, and a
 * conversation somebody is already having is *asked* to stop and honors it at
 * its next heartbeat. Egma does not reach into a call in progress, and it never
 * writes down that a conversation ended when it has not.
 *
 * Nothing proved the second half. The one cancellation test built a queued
 * simulation, so the branch that stamps a claimed or running row was never
 * entered and no test read the run's own record back — `appendRunEvents` could
 * have been deleted and the suite would have stayed green, leaving a run that
 * was canceled underneath a follower with no event to say so.
 *
 * The claim, the start and the heartbeat here are the product's own, taken
 * through the same door the simulator uses, because a second way of claiming a
 * row would prove something no simulator does.
 */
describe("archiving a target out from under work", () => {
  /**
   * A second way into the agent everything else here runs over, so archiving
   * it settles this test's work and no other test's.
   */
  async function aSpareConnection(name: string): Promise<string> {
    const added = await addConnection(actingAsAcme(), acmeSeed.agentId, {
      name,
      type: "retell",
      modality: "chat",
      config: { retellAgentId: `agent_${name}` },
      credentials: { apiKey: "retell-secret-A1B2C3D4WXYZ" },
    });
    return added?.id ?? "";
  }

  /** An agent of its own, wired once — the thing an agent Archive cascades from. */
  async function anAgentToArchive(
    name: string,
  ): Promise<{ agentId: string; connectionId: string }> {
    const created = await createAgent(actingAsAcme(), {
      name,
      connection: {
        type: "retell",
        modality: "chat",
        config: { retellAgentId: `agent_${name}` },
        credentials: { apiKey: "retell-secret-A1B2C3D4WXYZ" },
      },
    });
    // The seeded test was authored before this agent existed, so nothing yet
    // says it is worth running against it — and a run may only pair the two
    // once somebody has. Added rather than replaced, so the blocks that run
    // against the seed's own agent keep working.
    const applying = await getTest(actingAsAcme(), acmeSeed.testId);
    await setTestAgents(actingAsAcme(), acmeSeed.testId, {
      agentIds: [
        ...(applying?.agents ?? []).map((applies) => applies.id),
        created.id,
      ],
    });

    return { agentId: created.id, connectionId: created.connection?.id ?? "" };
  }

  /**
   * A conversation nobody has stopped: still held by its simulator, cancel
   * asked for, nothing about it ended, and the record saying so.
   *
   * Both live states are checked through this, because the promise is one
   * promise — whatever a claimed conversation gets, a running one gets.
   */
  async function expectAskedToStop(
    runId: string,
    simulationId: string,
    claimant: string,
    status: "claimed" | "running",
  ): Promise<void> {
    const held = await getSimulation(actingAsAcme(), simulationId);
    expect(held?.status).toBe(status);
    expect(held?.cancelRequestedAt).toBeInstanceOf(Date);
    // Not ended, and not judged: the conversation is still somebody's, and
    // what it produced before it stops stays on the record.
    expect(held?.endedAt).toBeNull();

    // Where the ask is actually delivered. A stamp no heartbeat reports is a
    // cancel nobody carries out.
    expect(
      await recordSimulationHeartbeat({ simulationId, claimant }),
    ).toEqual({ cancelRequested: true });

    const feed = await listRunEvents(actingAsAcme(), runId, { after: 0 });
    expect(feed?.events.at(-1)?.kind).toBe("run");
    expect(feed?.events.at(-1)?.status).toBe("canceled");

    // And nothing says the conversation itself is over, because it is not.
    expect(
      feed?.events
        .filter((event) => event.simulationId === simulationId)
        .map((event) => event.status),
    ).not.toContain("canceled");
  }

  /**
   * A queued conversation, settled. This is the shape both Archives have to
   * produce: archiving the agent above a connection may not leave the work
   * under it in a state archiving the connection itself would never leave it.
   */
  async function expectSettled(
    runId: string,
    simulationId: string,
  ): Promise<void> {
    const settled = await getSimulation(actingAsAcme(), simulationId);
    expect(settled?.status).toBe("canceled");
    expect(settled?.cancelRequestedAt).toBeInstanceOf(Date);
    expect(settled?.endedAt).toBeInstanceOf(Date);

    const header = await getRun(actingAsAcme(), runId);
    expect(header?.status).toBe("canceled");
    expect(header?.canceledCount).toBe(1);
    expect(header?.finishedAt).toBeInstanceOf(Date);

    const feed = await listRunEvents(actingAsAcme(), runId, { after: 0 });
    expect(
      feed?.events.map((event) => [event.kind, event.simulationId, event.status]),
    ).toEqual([
      ["simulation", simulationId, "canceled"],
      ["run", null, "canceled"],
    ]);
    expect(feed?.done).toBe(true);
  }

  it("asks a claimed conversation to stop, and says so on the run's record", async () => {
    const connectionId = await aSpareConnection("claimed-work");
    const { runId, simulationId } = await oneQueuedSimulation(actingAsAcme(), {
      ...acmeSeed,
      connectionId,
    });
    const claim = await claimOne(simulationId, "simulator-blue-1");

    const archived = await archiveConnection(
      actingAsAcme(),
      acmeSeed.agentId,
      connectionId,
    );
    expect(archived?.canceledRuns).toEqual([runId]);

    await expectAskedToStop(runId, simulationId, claim.claimedBy, "claimed");
  });

  it("asks a running conversation to stop on the same terms", async () => {
    const connectionId = await aSpareConnection("running-work");
    const { runId, simulationId } = await oneQueuedSimulation(actingAsAcme(), {
      ...acmeSeed,
      connectionId,
    });
    const claim = await claimOne(simulationId, "simulator-green-2");
    await startSimulation(claim.auth, claim.id, claim.claimedBy);

    const archived = await archiveConnection(
      actingAsAcme(),
      acmeSeed.agentId,
      connectionId,
    );
    expect(archived?.canceledRuns).toEqual([runId]);

    await expectAskedToStop(runId, simulationId, claim.claimedBy, "running");
  });

  it("ends the queued conversation where the connection is archived", async () => {
    const connectionId = await aSpareConnection("queued-work");
    const { runId, simulationId } = await oneQueuedSimulation(actingAsAcme(), {
      ...acmeSeed,
      connectionId,
    });

    const archived = await archiveConnection(
      actingAsAcme(),
      acmeSeed.agentId,
      connectionId,
    );
    expect(archived?.canceledRuns).toEqual([runId]);

    await expectSettled(runId, simulationId);
  });

  it("ends it exactly the same way when the agent above it is archived", async () => {
    const { agentId, connectionId } = await anAgentToArchive("cascading-desk");
    const { runId, simulationId } = await oneQueuedSimulation(actingAsAcme(), {
      ...acmeSeed,
      agentId,
      connectionId,
    });

    // The Archive names the agent, and nobody names the connection — the
    // cascade has to find the work under it. Without that, a queued
    // conversation would sit in the claim queue for a target no simulator can
    // resolve a credential for, and would land as a failure the agent never
    // caused.
    const archived = await archiveAgent(actingAsAcme(), agentId);
    expect(archived?.connections).toEqual([connectionId]);
    expect(archived?.canceledRuns).toEqual([runId]);

    await expectSettled(runId, simulationId);
  });
});
