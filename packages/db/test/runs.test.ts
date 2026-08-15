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
  PREDEFINED_GRADERS,
  readAssertionWords,
  recordSimulationHeartbeat,
  resolveSimulationStanding,
  startRun,
  startSimulation,
  sweepOrphanedSimulations,
  updateConnection,
  useLibraryEntry,
  type AuthContext,
  type NewRun,
  type Role,
  type SimulationClaim,
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
 * of the whole deployment, and earlier tests leave some behind on purpose, so
 * every test names its own run and fishes its own simulation out.
 */
async function claimOwn(
  runId: string,
  claimant = "simulator-blue-1",
): Promise<SimulationClaim> {
  const claimed = await claimSimulations({ claimant, capacity: 50 });
  const ours = claimed.find((claim) => claim.runId === runId);
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

  /**
   * The other half of a key-only verdict row.
   *
   * A row files its assertion by key — the behavior's position in the pinned
   * version — because a key derived from what a person typed would make an
   * edited sentence a *second* assertion, counted beside the first forever. The
   * words are therefore read back at display time, and this is that read: from
   * the version the conversation was executed against, never from the test as
   * it now stands.
   */
  describe("resolving an assertion key back into its sentence", () => {
    /** A running copy of the entry whose keys are behavior positions. */
    async function anExpectedBehaviorsCopy(name: string): Promise<string> {
      const copy = await useLibraryEntry(actingAsAcme(), {
        libraryId: PREDEFINED_GRADERS.expectedBehaviors,
        name,
      });
      return copy.id;
    }

    /** A copy of the entry that makes exactly one assertion. */
    async function aLatencyCopy(name: string): Promise<string> {
      const copy = await useLibraryEntry(actingAsAcme(), {
        libraryId: PREDEFINED_GRADERS.latency,
        name,
        params: { metric: "turn_response_latency", bound: 2_000 },
      });
      return copy.id;
    }

    it("answers the pinned version's sentence for each position", async () => {
      const versionId = await seedTestVersion(actingAsAcme(), "Reads back", [
        rita,
      ]);
      const pinned = await getTest(actingAsAcme(), await testOf(versionId));
      const simulationId = await conducted(versionId);
      const graderId = await anExpectedBehaviorsCopy("Reads back");

      const words = await readAssertionWords(actingAsAcme(), simulationId, [
        graderId,
      ]);

      expect(words.of(graderId, "behavior_1")).toBe(
        pinned?.expectedBehaviors[0],
      );
      expect(words.of(graderId, "behavior_2")).toBe(
        pinned?.expectedBehaviors[1],
      );
    });

    /**
     * The rule the whole join exists to keep. A test reworded this morning must
     * not put this morning's words on last night's judgment — that is exactly
     * the rewriting of history the pin exists to prevent, and a plausible wrong
     * sentence is worse than a bare key because nobody can tell it is wrong.
     */
    it("answers the version's words, never the test's as it now stands", async () => {
      const versionId = await seedTestVersion(actingAsAcme(), "Moves later", [
        rita,
      ]);
      const testId = await testOf(versionId);
      const before = await getTest(actingAsAcme(), testId);
      const simulationId = await conducted(versionId);
      const graderId = await anExpectedBehaviorsCopy("Moves later");

      await editTest(actingAsAcme(), testId, {
        expectedBehaviors: ["says something else entirely"],
      });

      const words = await readAssertionWords(actingAsAcme(), simulationId, [
        graderId,
      ]);
      expect(words.of(graderId, "behavior_1")).toBe(
        before?.expectedBehaviors[0],
      );
      expect(words.of(graderId, "behavior_1")).not.toBe(
        "says something else entirely",
      );
    });

    /**
     * Every way a key cannot be placed comes back absent, and a reader shows
     * the key. Inventing a sentence for any of these would be egma being
     * confidently wrong about what it judged.
     */
    it("answers nothing rather than guessing, wherever it cannot say", async () => {
      const versionId = await seedTestVersion(actingAsAcme(), "Cannot say", [
        rita,
      ]);
      const simulationId = await conducted(versionId);
      const graderId = await anExpectedBehaviorsCopy("Cannot say");
      const words = await readAssertionWords(actingAsAcme(), simulationId, [
        graderId,
      ]);

      // Past the end of a version holding two sentences.
      expect(words.of(graderId, "behavior_9")).toBeUndefined();
      // Nought, which no key ever is: positions count from one.
      expect(words.of(graderId, "behavior_0")).toBeUndefined();
      // A key in a shape this grader never mints.
      expect(words.of(graderId, "turn_response_latency")).toBeUndefined();
      // A grader nobody asked about, and one that is not this customer's.
      expect(words.of(newId("grd"), "behavior_1")).toBeUndefined();
    });

    /**
     * A copy that makes exactly one assertion names it by its entry's own
     * identifier — fixed for the entry's life, so no catalog rename can rekey a
     * verdict. What a person reads for it is that entry's name, resolved here
     * for the same reason a behavior's sentence is.
     */
    it("answers a whole-grader key with the entry's name", async () => {
      const versionId = await seedTestVersion(actingAsAcme(), "One check", [
        rita,
      ]);
      const simulationId = await conducted(versionId);
      const latency = await aLatencyCopy("Answers quickly");

      const words = await readAssertionWords(actingAsAcme(), simulationId, [
        latency,
      ]);

      expect(words.of(latency, PREDEFINED_GRADERS.latency)).toBe("latency");
      // And a behavior key off that copy means nothing: a key means whatever
      // the grader that wrote it says it means, and this one writes no such key.
      expect(words.of(latency, "behavior_1")).toBeUndefined();
    });

    /**
     * **What a latency copy actually writes, and why it needs nothing from
     * here.**
     *
     * Its keys are the measures its checks bound — `turn_response_latency` — and
     * not the whole-grader key above, which is what an entry egma cannot execute
     * files under. A measure is already the name of the thing the judgment is
     * about, so there is nothing to resolve and this answers absent, which a
     * reader renders as the key itself: "Turn response latency".
     *
     * That is the honest answer rather than a gap. Resolving it to the *copy's*
     * name would put "Answers quickly" on every one of its rows, and a copy
     * bounding two measures would then have two rows reading identically.
     */
    it("leaves a latency key alone, because the measure is already its own name", async () => {
      const versionId = await seedTestVersion(actingAsAcme(), "Two measures", [
        rita,
      ]);
      const simulationId = await conducted(versionId);
      const latency = await aLatencyCopy("Answers quickly enough");

      const words = await readAssertionWords(actingAsAcme(), simulationId, [
        latency,
      ]);

      expect(words.of(latency, "turn_response_latency")).toBeUndefined();
      expect(words.of(latency, "first_response_latency")).toBeUndefined();
      // And it is not accidentally caught by the whole-grader arm, which would
      // put the entry's name on a row about one particular measure.
      expect(words.of(latency, "turn_response_latency")).not.toBe("latency");
    });

    /**
     * A conversation with no test still resolves what does not need one. There
     * are no behaviors to look up, and that is not the same as having nothing
     * at all to say.
     */
    it("still names a whole-grader key for a conversation that pinned no test", async () => {
      const simulationId = await conducted(oneCaller, true);
      const graderId = await anExpectedBehaviorsCopy("No test behind it");
      const latency = await aLatencyCopy("Answers quickly, unpinned");

      const words = await readAssertionWords(actingAsAcme(), simulationId, [
        graderId,
        latency,
      ]);

      expect(words.of(graderId, "behavior_1")).toBeUndefined();
      expect(words.of(latency, PREDEFINED_GRADERS.latency)).toBe("latency");
    });

    it("answers another customer nothing, exactly as the version read does", async () => {
      const versionId = await seedTestVersion(actingAsAcme(), "Not theirs", [
        rita,
      ]);
      const simulationId = await conducted(versionId);
      const graderId = await anExpectedBehaviorsCopy("Not theirs");

      const words = await readAssertionWords(actingAsGlobex(), simulationId, [
        graderId,
      ]);
      expect(words.of(graderId, "behavior_1")).toBeUndefined();
    });
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

    const beat = await recordSimulationHeartbeat({
      simulationId,
      claimant: simulator,
    });
    expect(beat).toEqual({ cancelRequested: false });

    // A chat simulation reports no audio facts — the row would refuse them.
    const completed = await completeSimulation(actingAsAcme(), simulationId, simulator, {
      endingReason: "persona_concluded",
      turnCount: 6,
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

  it("refuses the reasons that belong to the other class, and the platform's own words", async () => {
    const { simulationId } = await claimedOne();
    await startSimulation(actingAsAcme(), simulationId, simulator);

    await expect(
      completeSimulation(actingAsAcme(), simulationId, simulator, {
        endingReason: "agent_never_joined" as never,
      }),
    ).rejects.toThrow(/not a way a conversation ends/);

    // The sweep's word and the claim path's: each is the platform's account
    // of its own failure, and a simulator still reporting can claim neither.
    for (const platformsOwn of ["orphaned", "dispatch_failed"] as const) {
      await expect(
        failSimulation(actingAsAcme(), simulationId, simulator, {
          reason: platformsOwn as never,
        }),
      ).rejects.toThrow(/not a way a simulation fails/);
    }
  });

  it("answers a stranger's report with undefined and moves nothing", async () => {
    const { simulationId } = await claimedOne();
    const before = await getSimulation(actingAsAcme(), simulationId);

    expect(
      await startSimulation(actingAsAcme(), simulationId, "simulator-green-2"),
    ).toBeUndefined();
    expect(
      await recordSimulationHeartbeat({
        simulationId,
        claimant: "simulator-green-2",
      }),
    ).toBeUndefined();

    // Not moved, and not stamped either: a stranger's beat must not keep a
    // row alive that its own claimant has gone silent on.
    const after = await getSimulation(actingAsAcme(), simulationId);
    expect(after?.status).toBe("claimed");
    expect(after?.heartbeatAt).toEqual(before?.heartbeatAt);
  });

  it("narrows the claimant's writes to the acting project, like every other verb", async () => {
    const { simulationId } = await claimedOne();

    // The right claimant, the wrong project: a credential acting in the
    // sibling reaches nothing, even inside its own organization.
    const actingInSibling = { ...actingAsAcme(), projectId: acme.outbound };
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

  it("stamps the row on a healthy beat, which is what keeps the sweep away", async () => {
    const { simulationId } = await claimedOne();

    // An old stamp, then a beat: the row's heartbeat has to move forward,
    // because the stamp is the one fact the orphan sweep reads.
    await database.sql(
      "update simulation set heartbeat_at = now() - interval '120 seconds' where id = $1",
      [simulationId],
    );
    const before = await getSimulation(actingAsAcme(), simulationId);

    const beat = await recordSimulationHeartbeat({
      simulationId,
      claimant: simulator,
    });
    expect(beat).toEqual({ cancelRequested: false });

    const after = await getSimulation(actingAsAcme(), simulationId);
    expect(after?.heartbeatAt?.getTime() ?? 0).toBeGreaterThan(
      before?.heartbeatAt?.getTime() ?? 0,
    );

    // Leave nothing claimed behind for the claim-shaped tests that follow.
    await failSimulation(actingAsAcme(), simulationId, simulator, {
      reason: "simulator_error",
    });
  });

  it("answers a heartbeat for a simulation beyond help with nothing under it", async () => {
    // Unknown: an id this egma never issued a row for.
    expect(
      await recordSimulationHeartbeat({
        simulationId: newId("sim"),
        claimant: simulator,
      }),
    ).toBeUndefined();

    // Queued: a row nobody holds, so there is no claimant to stamp for.
    const queued = await startRun(actingAsAcme(), aRun());
    const queuedId = queued.simulations[0]?.id ?? "";
    expect(
      await recordSimulationHeartbeat({
        simulationId: queuedId,
        claimant: simulator,
      }),
    ).toBeUndefined();
    await cancelRun(actingAsAcme(), queued.id);

    // Terminal: the conversation is over, even for the claimant that
    // conducted it — a late beat after landing is a signal to stop, not a
    // row to revive.
    const { simulationId } = await claimedOne();
    await startSimulation(actingAsAcme(), simulationId, simulator);
    await completeSimulation(actingAsAcme(), simulationId, simulator, {
      endingReason: "persona_concluded",
    });
    expect(
      await recordSimulationHeartbeat({
        simulationId,
        claimant: simulator,
      }),
    ).toBeUndefined();
  });

  it("keeps a completed simulation's terminal facts readable exactly as reported", async () => {
    const { simulationId } = await claimedOne();
    await startSimulation(actingAsAcme(), simulationId, simulator);
    await completeSimulation(actingAsAcme(), simulationId, simulator, {
      endingReason: "agent_ended",
      turnCount: 4,
    });

    // What the row keeps is the lifecycle and the summary facts. What was
    // said is not among them and has no column to be in: the conversation
    // is its spans, in the trace store.
    const kept = await getSimulation(actingAsAcme(), simulationId);
    expect(kept?.endingReason).toBe("agent_ended");
    expect(kept?.turnCount).toBe(4);
    expect(kept?.measuredAudioBandHertz).toBeNull();
  });
});

describe("the summary facts a terminal landing carries", () => {
  const simulator = "simulator-blue-1";

  async function runningOne(): Promise<{
    started: StartedRun;
    simulationId: string;
  }> {
    const started = await startRun(actingAsAcme(), aRun());
    const simulationId = (await claimOwn(started.id)).id;
    await startSimulation(actingAsAcme(), simulationId, simulator);
    return { started, simulationId };
  }

  it("lands the turn count, the provider's reference, and the reported moments", async () => {
    const { simulationId } = await runningOne();

    const startedAt = new Date("2026-08-05T09:00:00.000Z");
    const endedAt = new Date("2026-08-05T09:02:10.551Z");
    const landed = await completeSimulation(actingAsAcme(), simulationId, simulator, {
      endingReason: "persona_concluded",
      turnCount: 14,
      providerReference: "chat_5d1f9a3b7c",
      startedAt,
      endedAt,
    });

    expect(landed?.turnCount).toBe(14);
    expect(landed?.providerReference).toBe("chat_5d1f9a3b7c");
    // The moments the conduction measured, not the moments the report
    // happened to arrive: a retried report must not stretch the record.
    expect(landed?.startedAt).toEqual(startedAt);
    expect(landed?.endedAt).toEqual(endedAt);

    const kept = await getSimulation(actingAsAcme(), simulationId);
    expect(kept?.turnCount).toBe(14);
    expect(kept?.providerReference).toBe("chat_5d1f9a3b7c");
  });

  it("keeps the stamps it made when a report brings no moments of its own", async () => {
    const { simulationId } = await runningOne();

    const landed = await completeSimulation(actingAsAcme(), simulationId, simulator, {
      endingReason: "agent_ended",
    });

    expect(landed?.turnCount).toBeNull();
    expect(landed?.providerReference).toBeNull();
    expect(landed?.startedAt).toBeInstanceOf(Date);
    expect(landed?.endedAt).toBeInstanceOf(Date);
  });

  it("lands what a failed simulation still measured before it broke", async () => {
    const { simulationId } = await runningOne();

    const landed = await failSimulation(actingAsAcme(), simulationId, simulator, {
      reason: "simulator_error",
      turnCount: 3,
      providerReference: "chat_9e8d7c6b5a",
    });

    expect(landed?.status).toBe("failed");
    expect(landed?.turnCount).toBe(3);
    expect(landed?.providerReference).toBe("chat_9e8d7c6b5a");
  });

  it("lands what a canceled conversation had by the time it stopped", async () => {
    const { started, simulationId } = await runningOne();
    await cancelRun(actingAsAcme(), started.id);

    const landed = await markSimulationCanceled(
      actingAsAcme(),
      simulationId,
      simulator,
      { turnCount: 6, providerReference: "chat_1a2b3c4d5e" },
    );

    expect(landed?.status).toBe("canceled");
    // The cancel intent is its own record; the reason column stays empty.
    expect(landed?.endingReason).toBeNull();
    expect(landed?.turnCount).toBe(6);
    expect(landed?.providerReference).toBe("chat_1a2b3c4d5e");
  });

  it("lands a voice conversation's band and recording beside them", async () => {
    // The seeded connection speaks chat, and the row would refuse audio facts
    // on it — so the voice landing gets a voice connection of its own.
    const voice = await addConnection(actingAsAcme(), agentId, {
      type: "retell",
      modality: "voice",
      config: { retellAgentId: "agent_in_retell_voice" },
      credentials: { apiKey: "retell-secret-A1B2C3D4WXYZ" },
    });
    if (voice === undefined) throw new Error("the voice connection was not attached");
    const started = await startRun(
      actingAsAcme(),
      aRun({ connectionId: voice.id }),
    );
    const simulationId = (await claimOwn(started.id)).id;
    await startSimulation(actingAsAcme(), simulationId, simulator);

    const landed = await completeSimulation(actingAsAcme(), simulationId, simulator, {
      endingReason: "agent_ended",
      measuredAudioBandHertz: 48_000,
      recordingReference: `${simulationId}/dual-channel.wav`,
      turnCount: 22,
      providerReference: "CA7e2b9c1d4f6a8e0b",
    });

    expect(landed?.measuredAudioBandHertz).toBe(48_000);
    expect(landed?.recordingReference).toBe(`${simulationId}/dual-channel.wav`);
    expect(landed?.turnCount).toBe(22);
  });

  /**
   * The coverage stamp is what makes two runs' numbers comparable or not, so
   * it is held to the same standard as the measured audio band: landed off the
   * report, kept verbatim, and read back off the one simulation.
   */
  it("lands the coverage stamp, and reads it back off the simulation alone", async () => {
    const { simulationId } = await runningOne();

    const landed = await completeSimulation(actingAsAcme(), simulationId, simulator, {
      endingReason: "persona_concluded",
      turnCount: 8,
      mockToolCoverage: {
        discovered: ["check_calendar", "send_confirmation"],
        covered: ["check_calendar"],
        uncovered: ["send_confirmation"],
      },
    });

    expect(landed?.mockToolCoverage).toEqual({
      discovered: ["check_calendar", "send_confirmation"],
      covered: ["check_calendar"],
      uncovered: ["send_confirmation"],
    });

    const kept = await getSimulation(actingAsAcme(), simulationId);
    expect(kept?.mockToolCoverage).toEqual({
      discovered: ["check_calendar", "send_confirmation"],
      covered: ["check_calendar"],
      uncovered: ["send_confirmation"],
    });
  });

  /**
   * The two absences, which are two different facts. Null is "the agent was
   * never asked what tools it has"; three empty lists is "the asking happened
   * and nothing came back". A landing that turned either into the other would
   * be the record claiming something the simulator declined to claim.
   */
  it("keeps a report's silence about tools as silence, and its empty stamp as empty", async () => {
    const { simulationId: silent } = await runningOne();
    const landedSilent = await completeSimulation(
      actingAsAcme(),
      silent,
      simulator,
      { endingReason: "agent_ended" },
    );
    expect(landedSilent?.mockToolCoverage).toBeNull();

    const { simulationId: asked } = await runningOne();
    const landedAsked = await completeSimulation(
      actingAsAcme(),
      asked,
      simulator,
      {
        endingReason: "agent_ended",
        mockToolCoverage: { discovered: [], covered: [], uncovered: [] },
      },
    );
    expect(landedAsked?.mockToolCoverage).toEqual({
      discovered: [],
      covered: [],
      uncovered: [],
    });
  });

  it("lands the stamp on a failed and on a canceled conversation too", async () => {
    const { simulationId: broke } = await runningOne();
    const failed = await failSimulation(actingAsAcme(), broke, simulator, {
      reason: "simulator_error",
      mockToolCoverage: {
        discovered: ["check_calendar"],
        covered: ["check_calendar"],
        uncovered: [],
      },
    });
    expect(failed?.mockToolCoverage?.covered).toEqual(["check_calendar"]);

    const { started, simulationId: stopped } = await runningOne();
    await cancelRun(actingAsAcme(), started.id);
    const canceled = await markSimulationCanceled(
      actingAsAcme(),
      stopped,
      simulator,
      {
        mockToolCoverage: {
          discovered: ["check_calendar"],
          covered: [],
          uncovered: ["check_calendar"],
        },
      },
    );
    expect(canceled?.mockToolCoverage?.uncovered).toEqual(["check_calendar"]);
  });

  it("refuses a turn count that is not a count", async () => {
    const { simulationId } = await runningOne();

    for (const turnCount of [-1, 2.5]) {
      await expect(
        completeSimulation(actingAsAcme(), simulationId, simulator, {
          endingReason: "persona_concluded",
          turnCount,
        }),
      ).rejects.toThrow(/turn count/);
    }

    await failSimulation(actingAsAcme(), simulationId, simulator, {
      reason: "simulator_error",
    });
  });
});

describe("where a simulation stands, answered for the service's own routes", () => {
  const simulator = "simulator-blue-1";

  it("answers the lifecycle stamps and a context narrowed to the row's own tenancy", async () => {
    const started = await startRun(actingAsAcme(), aRun());
    const claimed = await claimOwn(started.id);

    const standing = await resolveSimulationStanding(claimed.id);
    expect(standing?.id).toBe(claimed.id);
    expect(standing?.runId).toBe(started.id);
    expect(standing?.status).toBe("claimed");
    expect(standing?.claimedBy).toBe(simulator);
    expect(standing?.endingReason).toBeNull();
    expect(standing?.cancelRequestedAt).toBeNull();
    expect(standing?.modality).toBe("chat");
    // Built from the row and from nothing the caller said — the same context
    // the claim itself would have handed over.
    expect(standing?.auth).toEqual({
      userId: "simulator",
      organizationId: acme.organization,
      projectId: acme.project,
      role: "member",
      via: "simulator",
    });

    // Lifecycle stamps and identifiers, and no content: what a customer
    // wrote is read afterwards, through the scoped surface, under `auth`.
    expect(standing).not.toHaveProperty("transcript");
    expect(standing).not.toHaveProperty("events");
    expect(standing).not.toHaveProperty("metrics");

    await failSimulation(standing?.auth ?? actingAsAcme(), claimed.id, simulator, {
      reason: "simulator_error",
    });
  });

  it("follows the row as it moves, terminal facts included", async () => {
    const started = await startRun(actingAsAcme(), aRun());
    const claimed = await claimOwn(started.id);
    await startSimulation(actingAsAcme(), claimed.id, simulator);
    await completeSimulation(actingAsAcme(), claimed.id, simulator, {
      endingReason: "limit_reached",
    });

    const standing = await resolveSimulationStanding(claimed.id);
    expect(standing?.status).toBe("completed");
    expect(standing?.endingReason).toBe("limit_reached");
  });

  it("answers undefined for an id this deployment never issued", async () => {
    expect(await resolveSimulationStanding(newId("sim"))).toBeUndefined();
    expect(await resolveSimulationStanding("not-an-id-at-all")).toBeUndefined();
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

    const claimed = await claimSimulations({
      claimant: simulator,
      capacity: 50,
    });
    expect(claimed.filter((claim) => claim.runId === started.id)).toEqual([]);
  });

  it("stamps the intent on a claimed simulation, and the next heartbeat carries it", async () => {
    const started = await startRun(actingAsAcme(), aRun());
    const claimed = await claimOwn(started.id);

    const canceled = await cancelRun(actingAsAcme(), started.id);
    expect(canceled?.status).toBe("canceled");
    // The claimed conversation is still the simulator's until it hears; the
    // counts wait for the straggler.
    expect(canceled?.finishedAt).toBeNull();

    const beat = await recordSimulationHeartbeat({
      simulationId: claimed.id,
      claimant: simulator,
    });
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

    // The one write no seam should offer: a heartbeat three minutes into the
    // past, which is what a dead simulator leaves behind.
    await database.sql(
      "update simulation set heartbeat_at = now() - interval '180 seconds' where id = $1",
      [claimed.id],
    );

    const swept = await sweepOrphanedSimulations({ staleAfterSeconds: 60 });
    expect(swept.map((simulation) => simulation.id)).toContain(claimed.id);

    const orphaned = await getSimulation(actingAsAcme(), claimed.id);
    expect(orphaned?.status).toBe("failed");
    expect(orphaned?.endingReason).toBe("orphaned");

    const header = await getRun(actingAsAcme(), started.id);
    expect(header?.status).toBe("completed");
    expect(header?.failedCount).toBe(1);
  });

  it("answers what it swept as identifiers, and nothing a customer wrote", async () => {
    const started = await startRun(actingAsAcme(), aRun());
    const claimed = await claimOwn(started.id);
    await database.sql(
      "update simulation set heartbeat_at = now() - interval '180 seconds' where id = $1",
      [claimed.id],
    );

    const swept = await sweepOrphanedSimulations({ staleAfterSeconds: 60 });
    const ours = swept.find((simulation) => simulation.id === claimed.id);
    expect(ours).toEqual({ id: claimed.id, runId: started.id });
  });

  it("calls nothing dead inside 150 seconds of silence, and everything past it", async () => {
    // The window under test is the default one, so neither sweep names a
    // window here — what this pins is the shipped number itself, one second
    // each side of it.
    const slow = await claimOwn((await startRun(actingAsAcme(), aRun())).id);
    const dead = await claimOwn((await startRun(actingAsAcme(), aRun())).id);
    await database.sql(
      "update simulation set heartbeat_at = now() - interval '149 seconds' where id = $1",
      [slow.id],
    );
    await database.sql(
      "update simulation set heartbeat_at = now() - interval '151 seconds' where id = $1",
      [dead.id],
    );

    const swept = await sweepOrphanedSimulations();
    const ids = swept.map((simulation) => simulation.id);
    expect(ids).toContain(dead.id);
    expect(ids).not.toContain(slow.id);

    // The slow-but-alive one is untouched, not merely unreported.
    expect((await getSimulation(actingAsAcme(), slow.id))?.status).toBe(
      "claimed",
    );
    expect((await getSimulation(actingAsAcme(), dead.id))?.endingReason).toBe(
      "orphaned",
    );

    // Leave nothing claimed behind for the claim-shaped tests that follow.
    await failSimulation(actingAsAcme(), slow.id, simulator, {
      reason: "simulator_error",
    });
  });

  it("leaves a simulator that is still talking alone", async () => {
    const started = await startRun(actingAsAcme(), aRun());
    const claimed = await claimOwn(started.id);

    const swept = await sweepOrphanedSimulations({ staleAfterSeconds: 60 });
    expect(swept.map((simulation) => simulation.id)).not.toContain(claimed.id);
    expect((await getSimulation(actingAsAcme(), claimed.id))?.status).toBe(
      "claimed",
    );

    await cancelRun(actingAsAcme(), started.id);
    await markSimulationCanceled(actingAsAcme(), claimed.id, simulator);
  });
});
