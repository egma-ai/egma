import { newId } from "@egma/ids";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  addConnection,
  cancelRun,
  claimSimulations,
  completeSimulation,
  createAgent,
  createPersona,
  createTest,
  deletePersona,
  deleteTest,
  editPersona,
  editTest,
  failSimulation,
  getPersona,
  getRun,
  getSimulation,
  getSimulationTestVersion,
  getTest,
  listRuns,
  listSimulations,
  markSimulationCanceled,
  NotPermittedError,
  recordSimulationHeartbeat,
  startRun,
  startSimulation,
  sweepOrphanedSimulations,
  updateConnection,
  type AuthContext,
  type NewRun,
  type Role,
  type Simulation,
  type StartedRun,
} from "@egma/db";

import {
  createConnectedDatabase,
  type MigratedDatabase,
} from "./support/database.ts";
import { seedOrganization, seedUser } from "./support/tenancy.ts";

/**
 * The whole lifecycle at the db seam, through the module: a run and its
 * simulations are created together, claimed atomically, moved through the
 * lifecycle by the claimant, canceled where they stand, swept when their
 * simulator goes silent — and the header's counts land once, at the end.
 *
 * Two customers exist throughout, because a test with one organization cannot
 * fail the way that matters. Raw SQL appears only to check what landed in a
 * table, to backdate a heartbeat, and to write the one row no verb writes any
 * more — a conversation with no test pinned, which only an instance upgraded
 * across the pin's migration still holds.
 */

let database: MigratedDatabase;

const acme = {
  organization: newId("org"),
  project: newId("prj"),
  /** A second project of Acme's, so a read can be narrowed past its sibling. */
  outbound: newId("prj"),
};
const globex = { organization: newId("org"), project: newId("prj") };
const ada = newId("usr");
const grace = newId("usr");

function actingAsAcme(role: Role = "member"): AuthContext {
  return {
    userId: ada,
    organizationId: acme.organization,
    projectId: acme.project,
    role,
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

/** Somebody plain, because who the persona is is not under test here. */
const neutralTraits = {
  personality: "Speaks plainly, stays patient, asks one question at a time.",
  language: "en-US",
  voice: { provider: "elevenlabs", voiceId: "EXAVITQu4vr4xnSDxMaL", speed: 1 },
} as const;

/** Acme's wired agent, the personas its runs conduct, and what they check. */
let agentId: string;
let connectionId: string;
let rita: string; // a persona of Acme's default project
let sam: string; // a second one, so a version can hold two simulations
let graceOwn: string; // Globex's persona, for the cross-tenant refusals
let oneCaller: string; // a test version naming rita alone
let twoCallers: string; // a test version naming both, so a run holds two
let globexOwn: string; // a test version of Globex's, for the same refusals

async function seedPersona(auth: AuthContext, name: string): Promise<string> {
  return (await createPersona(auth, { name, traits: neutralTraits })).id;
}

/**
 * A test, authored the way one is, and the frozen version a run pins. The
 * scenario is whole enough that resolving it back off a conversation says
 * something.
 */
async function seedTestVersion(
  auth: AuthContext,
  name: string,
  personaIds: readonly string[],
): Promise<string> {
  const created = await createTest(auth, {
    name,
    scenario:
      "Their cleaning is booked for Thursday morning and has to move to any afternoon next week.",
    expectedBehaviors: [
      "verifies who it is speaking to before discussing the booking",
      "offers at least one afternoon slot next week",
    ],
    personaIds: [...personaIds],
  });
  return created.versionId;
}

function aRun(overrides: Partial<NewRun> = {}): NewRun {
  return {
    agentId,
    connectionId,
    testVersionIds: [oneCaller],
    ...overrides,
  };
}

/**
 * Claim for one run under test. A claim takes the oldest queued simulations
 * of the whole customer, and earlier tests leave some behind on purpose, so
 * every test names its own run and fishes its own simulation out.
 */
async function claimOwn(
  runId: string,
  claimant = "simulator-blue-1",
): Promise<Simulation> {
  const claimed = await claimSimulations(actingAsAcme(), {
    claimant,
    capacity: 50,
  });
  const ours = claimed.find((simulation) => simulation.runId === runId);
  if (ours === undefined) throw new Error("the claim missed the run under test");
  return ours;
}

/** Which test a version belongs to — a fact the seeds above do not hand back. */
async function testOf(versionId: string): Promise<string> {
  const { rows } = await database.sql<{ test_id: string }>(
    "select test_id from test_version where id = $1",
    [versionId],
  );
  const found = rows[0]?.test_id;
  if (found === undefined) throw new Error("no such version");
  return found;
}

/** How many rows the two tables hold, for the proofs a refusal wrote nothing. */
async function rowCounts(): Promise<{ runs: number; simulations: number }> {
  const count = async (table: string): Promise<number> => {
    const { rows } = await database.sql<{ count: string }>(
      `select count(*) as count from ${table}`,
    );
    return Number(rows[0]?.count);
  };
  return { runs: await count("run"), simulations: await count("simulation") };
}

beforeAll(async () => {
  database = await createConnectedDatabase("runs");

  await seedOrganization(database, acme.organization, [
    { id: acme.project, slug: "default" },
    { id: acme.outbound, slug: "outbound" },
  ]);
  await seedOrganization(database, globex.organization, [
    { id: globex.project, slug: "default" },
  ]);
  await seedUser(database, ada, "ada@acme.example");
  await seedUser(database, grace, "grace@globex.example");

  const created = await createAgent(actingAsAcme(), {
    name: "Front desk",
    connection: {
      type: "retell",
      modality: "chat",
      environment: "staging",
      config: { retellAgentId: "agent_in_retell_1" },
      credentials: { apiKey: "retell-secret-A1B2C3D4WXYZ" },
    },
  });
  agentId = created.id;
  connectionId = created.connection?.id ?? "";

  rita = await seedPersona(actingAsAcme(), "Impatient Rita");
  sam = await seedPersona(actingAsAcme(), "Deliberate Sam");
  graceOwn = await seedPersona(actingAsGlobex(), "Careful Grace");

  oneCaller = await seedTestVersion(
    actingAsAcme(),
    "Reschedules a booked appointment",
    [rita],
  );
  twoCallers = await seedTestVersion(actingAsAcme(), "Cancels a booking", [
    rita,
    sam,
  ]);
  globexOwn = await seedTestVersion(actingAsGlobex(), "Reschedules", [graceOwn]);
});

afterAll(async () => {
  await database.drop();
});

describe("starting a run", () => {
  it("creates the run and its simulations together, each born queued", async () => {
    const started = await startRun(
      actingAsAcme(),
      aRun({ testVersionIds: [twoCallers] }),
    );

    expect(started.id).toMatch(/^run_/);
    expect(started.status).toBe("pending");
    expect(started.expectedSimulationCount).toBe(2);
    expect(started.triggeredVia).toBe("manual");
    expect(started.triggeredBy).toBe(ada);
    expect(started.pinnedTestVersionIds).toEqual([twoCallers]);
    expect(started.requestedPersonaIds).toEqual([rita, sam]);
    expect(started.completedCount).toBeNull();
    expect(started.finishedAt).toBeNull();
    expect(started.startedAt).toBeNull();

    expect(started.simulations).toHaveLength(2);
    expect(started.simulations.map((simulation) => simulation.personaId)).toEqual(
      [rita, sam],
    );
    for (const [index, simulation] of started.simulations.entries()) {
      expect(simulation.id).toMatch(/^sim_/);
      expect(simulation.runId).toBe(started.id);
      expect(simulation.status).toBe("queued");
      expect(simulation.position).toBe(index + 1);
      expect(simulation.agentId).toBe(agentId);
      expect(simulation.connectionId).toBe(connectionId);
      expect(simulation.claimedBy).toBeNull();
      expect(simulation.endingReason).toBeNull();
      // Both pins, on every conversation: what is being checked, and who is
      // calling about it.
      expect(simulation.testVersionId).toBe(twoCallers);
      expect(simulation.testName).toBe("Cancels a booking");
    }
  });

  it("pins each simulation to the persona's current version, so later edits change nothing", async () => {
    const before = await getPersona(actingAsAcme(), rita);
    const started = await startRun(actingAsAcme(), aRun());

    await editPersona(actingAsAcme(), rita, {
      traits: { ...neutralTraits, personality: "Now in a tearing hurry." },
    });
    const after = await getPersona(actingAsAcme(), rita);
    expect(after?.versionId).not.toBe(before?.versionId);

    const simulations = await listSimulations(actingAsAcme(), started.id);
    expect(simulations?.[0]?.personaId).toBe(rita);
    expect(simulations?.[0]?.personaVersionId).toBe(before?.versionId);
  });

  it("pins every simulation it creates to the version the run named", async () => {
    const pinnedTest = await testOf(twoCallers);
    const started = await startRun(
      actingAsAcme(),
      aRun({ testVersionIds: [twoCallers] }),
    );

    // Every one of them, not the first: the run is what names the version, so
    // a conversation of it that pinned nothing would be one nothing can judge.
    expect(started.simulations).toHaveLength(2);
    for (const conducted of started.simulations) {
      expect(conducted.testId).toBe(pinnedTest);
      expect(conducted.testVersionId).toBe(twoCallers);
    }

    // And it landed in the table, not only in the answer.
    const { rows } = await database.sql<{
      test_id: string | null;
      test_version_id: string | null;
    }>("select test_id, test_version_id from simulation where run_id = $1", [
      started.id,
    ]);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.test_id).toBe(pinnedTest);
      expect(row.test_version_id).toBe(twoCallers);
    }

    // The header keeps the selection whole beside them, which is what the
    // request asked for rather than what each conversation carries.
    expect(started.pinnedTestVersionIds).toEqual([twoCallers]);
  });

  it("keeps that pin when the test moves on, so a later edit rewrites nothing", async () => {
    const moving = await seedTestVersion(actingAsAcme(), "Moves on", [rita]);
    const movingTest = await testOf(moving);
    const started = await startRun(
      actingAsAcme(),
      aRun({ testVersionIds: [moving] }),
    );

    await editTest(actingAsAcme(), movingTest, {
      expectedBehaviors: [
        "verifies who it is speaking to before discussing the booking",
        "offers at least one afternoon slot next week",
        "confirms the new time back before finishing",
      ],
    });
    const after = await getTest(actingAsAcme(), movingTest);
    expect(after?.versionId).not.toBe(moving);

    const simulations = await listSimulations(actingAsAcme(), started.id);
    expect(simulations?.[0]?.testId).toBe(movingTest);
    expect(simulations?.[0]?.testVersionId).toBe(moving);
  });

  it("executes a version whose test has since been deleted, because the version is what was pinned", async () => {
    const abandoned = await seedTestVersion(actingAsAcme(), "Abandoned", [rita]);
    await deleteTest(actingAsAcme(), await testOf(abandoned));

    const started = await startRun(
      actingAsAcme(),
      aRun({ testVersionIds: [abandoned] }),
    );
    expect(started.simulations[0]?.testVersionId).toBe(abandoned);
  });

  it("stamps the connection's shape at start, so editing the connection rewrites nothing", async () => {
    const started = await startRun(actingAsAcme(), aRun());
    expect(started.connectionSnapshot.type).toBe("retell");
    expect(started.connectionSnapshot.modality).toBe("chat");
    expect(started.connectionSnapshot.environment).toBe("staging");
    expect(started.simulations[0]?.connectionType).toBe("retell");
    expect(started.simulations[0]?.modality).toBe("chat");

    await updateConnection(actingAsAcme(), agentId, connectionId, {
      environment: "production",
    });

    const kept = await getRun(actingAsAcme(), started.id);
    expect(kept?.connectionSnapshot.environment).toBe("staging");
  });

  it("keeps credentials out of the snapshot, which is the one place they could leak", async () => {
    const started = await startRun(actingAsAcme(), aRun());

    const { rows } = await database.sql<{ connection_snapshot: unknown }>(
      "select connection_snapshot from run where id = $1",
      [started.id],
    );
    const snapshot = rows[0]?.connection_snapshot as Record<string, unknown>;
    expect(Object.keys(snapshot).sort()).toEqual([
      "config",
      "environment",
      "modality",
      "topology",
      "type",
    ]);
    expect(JSON.stringify(snapshot)).not.toContain("retell-secret");
  });

  /**
   * The same claim for the credential of the other shape a livekit
   * connection comes in. A connection whose secret is a set of auth headers
   * rather than a key pair must be snapshotted exactly as carefully: the
   * snapshot is what a run carries for the rest of its life, and headers in
   * it would be headers in every read of that run forever.
   */
  it("keeps an endpoint's auth headers out of the snapshot too", async () => {
    const atEndpoint = await createAgent(actingAsAcme(), {
      name: "Front desk in production",
      connection: {
        type: "livekit",
        modality: "voice",
        config: {
          url: "wss://acme.livekit.cloud",
          tokenEndpoint: "https://acme.example/egma/livekit-token",
        },
        credentials: {
          headers: '{"Authorization":"Bearer SENTINEL-endpoint-token-b3f1"}',
        },
      },
    });

    const started = await startRun(
      actingAsAcme(),
      aRun({
        agentId: atEndpoint.id,
        connectionId: atEndpoint.connection?.id ?? "",
      }),
    );

    const { rows } = await database.sql<{ connection_snapshot: unknown }>(
      "select connection_snapshot from run where id = $1",
      [started.id],
    );
    const snapshot = rows[0]?.connection_snapshot as Record<string, unknown>;
    expect(Object.keys(snapshot).sort()).toEqual([
      "config",
      "environment",
      "modality",
      "topology",
      "type",
    ]);
    // The endpoint is configuration and is in there, which is the point of
    // checking: the snapshot really did carry this connection's config.
    expect(JSON.stringify(snapshot)).toContain("egma/livekit-token");
    expect(JSON.stringify(snapshot)).not.toContain("SENTINEL");
    expect(JSON.stringify(started.connectionSnapshot)).not.toContain("SENTINEL");
  });

  it("records a retry as a new run pointing back, never the old run reopened", async () => {
    const first = await startRun(actingAsAcme(), aRun());
    const retry = await startRun(
      actingAsAcme(),
      aRun({ retryOfRunId: first.id }),
    );

    expect(retry.id).not.toBe(first.id);
    expect(retry.retryOfRunId).toBe(first.id);
    expect((await getRun(actingAsAcme(), first.id))?.status).toBe("pending");
  });

  it("is refused to a viewer, because a run spends money and creates data", async () => {
    await expect(startRun(actingAsAcme("viewer"), aRun())).rejects.toThrow(
      NotPermittedError,
    );
  });

  it("is refused to a credential acting in no project", async () => {
    const wholeCustomer = { ...actingAsAcme(), projectId: undefined };
    await expect(startRun(wholeCustomer, aRun())).rejects.toThrow(
      /acting in none/,
    );
  });

  it("refuses a version that is missing, another customer's, or pinned twice — writing nothing", async () => {
    const before = await rowCounts();

    const missing = newId("tstv");
    await expect(
      startRun(actingAsAcme(), aRun({ testVersionIds: [missing] })),
    ).rejects.toThrow(`there is no test version ${missing} on this egma`);

    // Another customer's version is refused in the same words as one that
    // never existed, because confirming somebody else's row exists is a leak.
    await expect(
      startRun(actingAsAcme(), aRun({ testVersionIds: [globexOwn] })),
    ).rejects.toThrow(`there is no test version ${globexOwn} on this egma`);

    await expect(
      startRun(actingAsAcme(), aRun({ testVersionIds: [oneCaller, oneCaller] })),
    ).rejects.toThrow(`test version ${oneCaller} is pinned twice on one run`);

    await expect(
      startRun(actingAsAcme(), aRun({ testVersionIds: [] })),
    ).rejects.toThrow(/at least one test version/);

    // And one good id beside one bad one takes the whole creation with it,
    // rather than running most of what was asked for.
    await expect(
      startRun(actingAsAcme(), aRun({ testVersionIds: [oneCaller, missing] })),
    ).rejects.toThrow(`there is no test version ${missing} on this egma`);

    expect(await rowCounts()).toEqual(before);
  });

  it("refuses a version whose persona has since been deleted, rather than conducting one fewer", async () => {
    const leaving = await seedPersona(actingAsAcme(), "Departing Dara");
    const pinned = await seedTestVersion(actingAsAcme(), "Asks twice", [leaving]);

    // The test moves off them first: a live test naming somebody is what
    // refuses their delete, and the old version goes on naming them.
    await editTest(actingAsAcme(), await testOf(pinned), {
      personaIds: [rita],
    });
    await deletePersona(actingAsAcme(), leaving);

    await expect(
      startRun(actingAsAcme(), aRun({ testVersionIds: [pinned] })),
    ).rejects.toThrow(`persona ${leaving} is deleted`);
  });

  it("refuses a connection that is not the named agent's", async () => {
    const other = await createAgent(actingAsAcme(), {
      name: "Other desk",
      connection: {
        type: "retell",
        modality: "chat",
        config: { retellAgentId: "agent_in_retell_2" },
        credentials: { apiKey: "retell-secret-E5F6G7H8WXYZ" },
      },
    });

    await expect(
      startRun(
        actingAsAcme(),
        aRun({ agentId: other.id, connectionId }),
      ),
    ).rejects.toThrow(
      `connection ${connectionId} is not on agent ${other.id}`,
    );
  });
});

describe("reading runs", () => {
  it("shows another customer nothing, in the words nothing uses", async () => {
    const started = await startRun(actingAsAcme(), aRun());

    expect(await getRun(actingAsGlobex(), started.id)).toBeUndefined();
    expect(await listSimulations(actingAsGlobex(), started.id)).toBeUndefined();
    expect(
      await getSimulation(actingAsGlobex(), started.simulations[0]?.id ?? ""),
    ).toBeUndefined();

    const theirs = await listRuns(actingAsGlobex());
    expect(theirs.items).toEqual([]);
  });

  it("narrows to the acting project, and a credential acting in none reads the customer", async () => {
    const started = await startRun(actingAsAcme(), aRun());

    const actingInSibling = { ...actingAsAcme(), projectId: acme.outbound };
    expect(await getRun(actingInSibling, started.id)).toBeUndefined();

    const wholeCustomer = { ...actingAsAcme(), projectId: undefined };
    expect((await getRun(wholeCustomer, started.id))?.id).toBe(started.id);
  });

  it("pages newest first, the id as the whole cursor", async () => {
    const first = await startRun(actingAsAcme(), aRun());
    const second = await startRun(actingAsAcme(), aRun());

    const page = await listRuns(actingAsAcme(), { limit: 1 });
    expect(page.items[0]?.id).toBe(second.id);
    expect(page.nextCursor).toBe(second.id);

    const next = await listRuns(actingAsAcme(), {
      limit: 1,
      cursor: page.nextCursor,
    });
    expect(next.items[0]?.id).toBe(first.id);
  });
});

/**
 * What the pin is for: a conversation that has happened can say what it was
 * supposed to do. The whole resolution is asked of the simulation, so nothing
 * judging one has to know how the test tables are shaped.
 */
describe("resolving what a simulation was executed against", () => {
  /**
   * One run of the named version, conducted through to a completed
   * conversation. `unpin` clears the pin while the conversation is still
   * running, because a terminal simulation is written once.
   */
  async function conducted(
    versionId: string,
    unpin = false,
  ): Promise<string> {
    const started = await startRun(
      actingAsAcme(),
      aRun({ testVersionIds: [versionId] }),
    );
    const simulationId = (await claimOwn(started.id)).id;
    if (unpin) {
      await database.sql(
        "update simulation set test_id = null, test_version_id = null where id = $1",
        [simulationId],
      );
    }
    await startSimulation(actingAsAcme(), simulationId, "simulator-blue-1");
    await completeSimulation(actingAsAcme(), simulationId, "simulator-blue-1", {
      endingReason: "persona_concluded",
      transcript: [{ speaker: "agent", text: "Booked for Tuesday afternoon." }],
    });
    return simulationId;
  }

  it("answers with the pinned version's expected behaviors, in the order authored", async () => {
    const versionId = await seedTestVersion(actingAsAcme(), "Resolves whole", [
      rita,
    ]);
    const testId = await testOf(versionId);
    const pinned = await getTest(actingAsAcme(), testId);
    const simulationId = await conducted(versionId);

    const version = await getSimulationTestVersion(actingAsAcme(), simulationId);
    expect(version?.id).toBe(versionId);
    expect(version?.testId).toBe(testId);
    expect(version?.expectedBehaviors).toEqual(pinned?.expectedBehaviors);
    expect(version?.scenario).toBe(pinned?.scenario);
    expect(version?.personas.map((who) => who.id)).toEqual([rita]);
  });

  it("answers the version as it was, never the test as it is now", async () => {
    const versionId = await seedTestVersion(actingAsAcme(), "Moves after", [
      rita,
    ]);
    const testId = await testOf(versionId);
    const before = await getTest(actingAsAcme(), testId);
    const simulationId = await conducted(versionId);

    await editTest(actingAsAcme(), testId, {
      expectedBehaviors: ["says nothing about bookings at all"],
    });

    const version = await getSimulationTestVersion(actingAsAcme(), simulationId);
    expect(version?.id).toBe(versionId);
    expect(version?.expectedBehaviors).toEqual(before?.expectedBehaviors);
  });

  it("goes on answering after the test is deleted, because the run outlives it", async () => {
    const versionId = await seedTestVersion(
      actingAsAcme(),
      "Abandoned but run",
      [rita],
    );
    const testId = await testOf(versionId);
    const pinned = await getTest(actingAsAcme(), testId);
    const simulationId = await conducted(versionId);

    await deleteTest(actingAsAcme(), testId);
    expect(await getTest(actingAsAcme(), testId)).toBeUndefined();

    const version = await getSimulationTestVersion(actingAsAcme(), simulationId);
    expect(version?.id).toBe(pinned?.versionId);
    expect(version?.expectedBehaviors).toEqual(pinned?.expectedBehaviors);
  });

  it("answers nothing for a simulation that pinned no test", async () => {
    // No verb can write one: `startRun` names a version for every conversation
    // it creates. The row an instance upgraded across the pin's migration
    // holds is written here by hand, because it is the only shape of the
    // question that still exists and the answer still has to be right.
    const simulationId = await conducted(oneCaller, true);

    expect(
      await getSimulationTestVersion(actingAsAcme(), simulationId),
    ).toBeUndefined();
  });

  it("answers another customer nothing, in the words nothing uses", async () => {
    const simulationId = await conducted(oneCaller);

    expect(
      await getSimulationTestVersion(actingAsGlobex(), simulationId),
    ).toBeUndefined();
  });

  it("is a read, so a viewer gets it like every other read", async () => {
    const simulationId = await conducted(oneCaller);

    const version = await getSimulationTestVersion(
      actingAsAcme("viewer"),
      simulationId,
    );
    expect(version?.testId).toBe(await testOf(oneCaller));
  });
});

describe("the lifecycle, conducted by a claimant", () => {
  const simulator = "simulator-blue-1";

  async function claimedOne(): Promise<{
    started: StartedRun;
    simulationId: string;
  }> {
    const started = await startRun(actingAsAcme(), aRun());
    return { started, simulationId: (await claimOwn(started.id)).id };
  }

  it("claims the queued simulation, stamping the claimant and the first heartbeat", async () => {
    const { started, simulationId } = await claimedOne();

    const claimed = await getSimulation(actingAsAcme(), simulationId);
    expect(claimed?.status).toBe("claimed");
    expect(claimed?.claimedBy).toBe(simulator);
    expect(claimed?.claimedAt).toBeInstanceOf(Date);
    expect(claimed?.heartbeatAt).toBeInstanceOf(Date);

    // A run has started when its first conversation is someone's to conduct.
    const header = await getRun(actingAsAcme(), started.id);
    expect(header?.status).toBe("running");
    expect(header?.startedAt).toBeInstanceOf(Date);
  });

  it("moves through running to completed, and the last landing freezes the counts", async () => {
    const { started, simulationId } = await claimedOne();

    const running = await startSimulation(actingAsAcme(), simulationId, simulator);
    expect(running?.status).toBe("running");
    expect(running?.startedAt).toBeInstanceOf(Date);

    const beat = await recordSimulationHeartbeat(
      actingAsAcme(),
      simulationId,
      simulator,
    );
    expect(beat).toEqual({ cancelRequested: false });

    // A chat simulation reports no audio facts — the row would refuse them.
    const completed = await completeSimulation(actingAsAcme(), simulationId, simulator, {
      endingReason: "persona_concluded",
      transcript: [{ speaker: "human", text: "Thanks, that is everything." }],
      metrics: { turnCount: 6 },
    });
    expect(completed?.status).toBe("completed");
    expect(completed?.endingReason).toBe("persona_concluded");
    expect(completed?.measuredAudioBandHertz).toBeNull();

    const header = await getRun(actingAsAcme(), started.id);
    expect(header?.status).toBe("completed");
    expect(header?.completedCount).toBe(1);
    expect(header?.failedCount).toBe(0);
    expect(header?.canceledCount).toBe(0);
    expect(header?.finishedAt).toBeInstanceOf(Date);
  });

  it("records a simulation that never ran as failed with its reason, never as a bad conversation", async () => {
    const { started, simulationId } = await claimedOne();

    const failed = await failSimulation(actingAsAcme(), simulationId, simulator, {
      reason: "agent_never_joined",
    });
    expect(failed?.status).toBe("failed");
    expect(failed?.endingReason).toBe("agent_never_joined");

    const header = await getRun(actingAsAcme(), started.id);
    expect(header?.status).toBe("completed");
    expect(header?.failedCount).toBe(1);
  });

  it("refuses the reasons that belong to the other class, and the sweep's own word", async () => {
    const { simulationId } = await claimedOne();
    await startSimulation(actingAsAcme(), simulationId, simulator);

    await expect(
      completeSimulation(actingAsAcme(), simulationId, simulator, {
        endingReason: "agent_never_joined" as never,
        transcript: [],
      }),
    ).rejects.toThrow(/not a way a conversation ends/);

    await expect(
      failSimulation(actingAsAcme(), simulationId, simulator, {
        reason: "orphaned" as never,
      }),
    ).rejects.toThrow(/not a way a simulation fails/);
  });

  it("answers a stranger's report with undefined and moves nothing", async () => {
    const { simulationId } = await claimedOne();

    expect(
      await startSimulation(actingAsAcme(), simulationId, "simulator-green-2"),
    ).toBeUndefined();
    expect(
      await recordSimulationHeartbeat(
        actingAsAcme(),
        simulationId,
        "simulator-green-2",
      ),
    ).toBeUndefined();

    expect(
      (await getSimulation(actingAsAcme(), simulationId))?.status,
    ).toBe("claimed");
  });

  it("narrows the claimant's writes to the acting project, like every other verb", async () => {
    const { simulationId } = await claimedOne();

    // The right claimant, the wrong project: a credential acting in the
    // sibling reaches nothing, even inside its own organization.
    const actingInSibling = { ...actingAsAcme(), projectId: acme.outbound };
    expect(
      await recordSimulationHeartbeat(actingInSibling, simulationId, simulator),
    ).toBeUndefined();
    expect(
      await startSimulation(actingInSibling, simulationId, simulator),
    ).toBeUndefined();
    expect(
      await failSimulation(actingInSibling, simulationId, simulator, {
        reason: "simulator_error",
      }),
    ).toBeUndefined();

    expect(
      (await getSimulation(actingAsAcme(), simulationId))?.status,
    ).toBe("claimed");
  });

  it("keeps a completed simulation's report readable exactly as reported", async () => {
    const { simulationId } = await claimedOne();
    await startSimulation(actingAsAcme(), simulationId, simulator);
    await completeSimulation(actingAsAcme(), simulationId, simulator, {
      endingReason: "agent_ended",
      transcript: [{ speaker: "agent", text: "Goodbye." }],
    });

    const kept = await getSimulation(actingAsAcme(), simulationId);
    expect(kept?.transcript).toEqual([{ speaker: "agent", text: "Goodbye." }]);
    expect(kept?.endingReason).toBe("agent_ended");
    expect(kept?.measuredAudioBandHertz).toBeNull();
  });
});

describe("canceling a run", () => {
  const simulator = "simulator-blue-1";

  it("ends queued simulations at once, and they can never be claimed", async () => {
    const started = await startRun(
      actingAsAcme(),
      aRun({ testVersionIds: [twoCallers] }),
    );

    const canceled = await cancelRun(actingAsAcme(), started.id);
    expect(canceled?.status).toBe("canceled");
    expect(canceled?.canceledCount).toBe(2);
    expect(canceled?.completedCount).toBe(0);
    expect(canceled?.finishedAt).toBeInstanceOf(Date);

    for (const simulation of (await listSimulations(actingAsAcme(), started.id)) ??
      []) {
      expect(simulation.status).toBe("canceled");
      expect(simulation.cancelRequestedAt).toBeInstanceOf(Date);
    }

    const claimed = await claimSimulations(actingAsAcme(), {
      claimant: simulator,
      capacity: 50,
    });
    expect(
      claimed.filter((simulation) => simulation.runId === started.id),
    ).toEqual([]);
  });

  it("stamps the intent on a claimed simulation, and the next heartbeat carries it", async () => {
    const started = await startRun(actingAsAcme(), aRun());
    const claimed = await claimOwn(started.id);

    const canceled = await cancelRun(actingAsAcme(), started.id);
    expect(canceled?.status).toBe("canceled");
    // The claimed conversation is still the simulator's until it hears; the
    // counts wait for the straggler.
    expect(canceled?.finishedAt).toBeNull();

    const beat = await recordSimulationHeartbeat(
      actingAsAcme(),
      claimed.id,
      simulator,
    );
    expect(beat).toEqual({ cancelRequested: true });

    const landed = await markSimulationCanceled(
      actingAsAcme(),
      claimed.id,
      simulator,
    );
    expect(landed?.status).toBe("canceled");

    const settled = await getRun(actingAsAcme(), started.id);
    expect(settled?.status).toBe("canceled");
    expect(settled?.canceledCount).toBe(1);
    expect(settled?.finishedAt).toBeInstanceOf(Date);
  });

  it("refuses to call a conversation canceled that nobody asked to cancel", async () => {
    const started = await startRun(actingAsAcme(), aRun());
    const claimed = await claimOwn(started.id);

    expect(
      await markSimulationCanceled(actingAsAcme(), claimed.id, simulator),
    ).toBeUndefined();
    expect((await getSimulation(actingAsAcme(), claimed.id))?.status).toBe(
      "claimed",
    );

    // Leave nothing behind for the claim-shaped tests that follow.
    await failSimulation(actingAsAcme(), claimed.id, simulator, {
      reason: "simulator_error",
    });
  });

  it("cancels a canceled run into the same answer, and a completed run out loud", async () => {
    const started = await startRun(actingAsAcme(), aRun());
    await cancelRun(actingAsAcme(), started.id);
    const again = await cancelRun(actingAsAcme(), started.id);
    expect(again?.status).toBe("canceled");

    const finished = await startRun(actingAsAcme(), aRun());
    const claimed = await claimOwn(finished.id);
    await startSimulation(actingAsAcme(), claimed.id, simulator);
    await completeSimulation(actingAsAcme(), claimed.id, simulator, {
      endingReason: "persona_concluded",
      transcript: [],
    });

    await expect(cancelRun(actingAsAcme(), finished.id)).rejects.toThrow(
      /has nothing left to cancel/,
    );
  });

  it("is out of another customer's reach entirely", async () => {
    const started = await startRun(actingAsAcme(), aRun());
    expect(await cancelRun(actingAsGlobex(), started.id)).toBeUndefined();
    expect((await getRun(actingAsAcme(), started.id))?.status).toBe("pending");
    await cancelRun(actingAsAcme(), started.id);
  });
});

describe("the orphan sweep", () => {
  const simulator = "simulator-blue-1";

  it("marks a silent simulation failed with reason orphaned, and finalizes its run", async () => {
    const started = await startRun(actingAsAcme(), aRun());
    const claimed = await claimOwn(started.id);
    await startSimulation(actingAsAcme(), claimed.id, simulator);

    // The one write no seam should offer: a heartbeat two minutes into the
    // past, which is what a dead simulator leaves behind.
    await database.sql(
      "update simulation set heartbeat_at = now() - interval '120 seconds' where id = $1",
      [claimed.id],
    );

    const swept = await sweepOrphanedSimulations(actingAsAcme(), {
      staleAfterSeconds: 60,
    });
    expect(swept.map((simulation) => simulation.id)).toContain(claimed.id);

    const orphaned = await getSimulation(actingAsAcme(), claimed.id);
    expect(orphaned?.status).toBe("failed");
    expect(orphaned?.endingReason).toBe("orphaned");

    const header = await getRun(actingAsAcme(), started.id);
    expect(header?.status).toBe("completed");
    expect(header?.failedCount).toBe(1);
  });

  it("leaves a simulator that is still talking alone", async () => {
    const started = await startRun(actingAsAcme(), aRun());
    const claimed = await claimOwn(started.id);

    const swept = await sweepOrphanedSimulations(actingAsAcme(), {
      staleAfterSeconds: 60,
    });
    expect(swept.map((simulation) => simulation.id)).not.toContain(claimed.id);
    expect((await getSimulation(actingAsAcme(), claimed.id))?.status).toBe(
      "claimed",
    );

    await cancelRun(actingAsAcme(), started.id);
    await markSimulationCanceled(actingAsAcme(), claimed.id, simulator);
  });
});
