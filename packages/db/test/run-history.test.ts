import { newId } from "@egma/ids";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  addConnection,
  appendVerdicts,
  archiveAgent,
  archiveConnection,
  archivePersona,
  archiveTest,
  cancelRun,
  claimSimulations,
  completeSimulation,
  connectClickHouse,
  createAgent,
  createPersona,
  createTest,
  disconnectClickHouse,
  editPersona,
  editTest,
  failSimulation,
  foldRun,
  foldSimulation,
  getRun,
  IdempotencyConflictError,
  listSimulations,
  listRunHistory,
  markSimulationCanceled,
  readRunFold,
  restoreTest,
  rerunSimulation,
  simulationRerunAlreadyStarted,
  retryRun,
  RunRetryRefusedError,
  RunWriteRefusedError,
  SimulationRerunRefusedError,
  setTestAgents,
  startRun,
  startSimulation,
  type AuthContext,
  type NewVerdict,
  type Role,
  type SimulationClaim,
} from "@egma/db";

import {
  createMigratedTraceStore,
  type MigratedTraceStore,
} from "./support/clickhouse.ts";
import {
  createConnectedDatabase,
  type MigratedDatabase,
} from "./support/database.ts";
import { seedJudge, seedOrganization, seedUser } from "./support/tenancy.ts";

/**
 * Reading a project's run history, and retrying one run under today's
 * conditions.
 *
 * **Two stores, because the subject genuinely spans two.** A run's machinery
 * lives in Postgres and its judgment lives in the trace store, and the whole
 * point of this area is that the two are never confused for each other — so the
 * fold that reads them together is tested against both for real.
 *
 * The guards worth having here are the ones a page cannot be trusted to get
 * right on its own: that a `skipped` conversation never reads as a failure, that
 * a run still being judged has no verdict rather than an early one, that a
 * completed run may hold failed verdicts, and that Retry refuses rather than
 * substituting anything that has since been archived or unlinked.
 */

let database: MigratedDatabase;
let store: MigratedTraceStore;

const acme = { organization: newId("org"), project: newId("prj") };
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

const auth = actingAsAcme();

const neutralTraits = {
  personality: "Speaks plainly, stays patient, asks one question at a time.",
  language: "en-US",
  voice: { provider: "elevenlabs", voiceId: "EXAVITQu4vr4xnSDxMaL", speed: 1 },
} as const;

let agentId: string;
let connectionId: string;
/** A second way to reach the same agent, so a connection filter has two answers. */
let secondConnectionId: string;
let rita: string;
let sam: string;
let reschedules: string; // a test, and its current frozen version
let reschedulesVersion: string;
let cancels: string;
let cancelsVersion: string;
/** A version whose requirement this connection has never been measured for. */
let needsAudioVersion: string;

async function seedPersona(name: string): Promise<string> {
  return (await createPersona(auth, { name, traits: neutralTraits })).id;
}

async function seedTest(
  name: string,
  personaIds: readonly string[],
): Promise<{ id: string; versionId: string }> {
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
  return { id: created.id, versionId: created.versionId };
}

/** Claim the simulations of one run, oldest first, as a simulator would. */
async function claimOwn(runId: string): Promise<readonly SimulationClaim[]> {
  const claimed = await claimSimulations({
    claimant: "simulator-blue-1",
    capacity: 50,
  });
  return claimed.filter((claim) => claim.runId === runId);
}

/** One judgment, filed under the conversation and the run it belongs to. */
function verdictOn(input: {
  readonly simulationId: string;
  readonly runId: string;
  readonly assertion: string;
  readonly verdict: NewVerdict["verdict"];
}): NewVerdict {
  return {
    traceId: input.simulationId,
    graderId: newId("grd"),
    graderVersionId: newId("grv"),
    assertion: input.assertion,
    source: "simulation",
    verdict: input.verdict,
    score: input.verdict === "passed" ? 1 : 0,
    rationale: "because that is what happened",
    citedSpanIds: [],
    runId: input.runId,
    agentId,
    // The agent version this judgment was about. These fixtures never mint one
    // through the agent factory, so a stable stand-in is enough — nothing here
    // reads it back.
    agentVersionId: "agv_stand_in_for_a_version",
    judgedAtMicroseconds: BigInt(Date.now()) * 1000n,
  };
}

beforeAll(async () => {
  database = await createConnectedDatabase("run_history");
  store = await createMigratedTraceStore("run_history");
  connectClickHouse({ clickhouseUrl: store.url, maxOpenConnections: 4 });

  await seedOrganization(database, acme.organization, [
    { id: acme.project, slug: "default" },
  ]);
  await seedOrganization(database, globex.organization, [
    { id: globex.project, slug: "default" },
  ]);
  await seedUser(database, ada, "ada@acme.example");
  await seedUser(database, grace, "grace@globex.example");
  await seedJudge(actingAsAcme("admin"));
  await seedJudge({ ...actingAsGlobex(), role: "admin" });
  // **No running graders here, and this file genuinely does not want any.**
  // Every verdict below is appended by hand under an invented grader id, which
  // is what lets one test write a passed row and a failed row and read the fold
  // that comes of them. A seeded copy would put an item in each run's frozen
  // plan that no verdict here ever names, and would prove nothing extra: what a
  // run freezes is `run-planning.test.ts`'s subject, and what a fold makes of
  // rows is this one's.

  const created = await createAgent(auth, {
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
  const production = await addConnection(auth, agentId, {
    name: "retell-production",
    type: "retell",
    modality: "chat",
    environment: "production",
    config: { retellAgentId: "agent_in_retell_2" },
    credentials: { apiKey: "retell-secret-Z9Y8X7W6WXYZ" },
  });
  if (production === undefined) throw new Error("the second connection is needed");
  secondConnectionId = production.id;

  rita = await seedPersona("Impatient Rita");
  sam = await seedPersona("Deliberate Sam");

  const one = await seedTest("Reschedules a booked appointment", [rita]);
  reschedules = one.id;
  reschedulesVersion = one.versionId;
  const two = await seedTest("Cancels a booking", [rita, sam]);
  cancels = two.id;
  cancelsVersion = two.versionId;

  // Nobody has measured this connection, so a version requiring raw audio is
  // written off before it begins — terminal, unclaimed, and never a failure.
  needsAudioVersion = (
    await createTest(auth, {
      name: "Reads a card number back over audio",
      scenario: "Something that only makes sense over a real audio channel.",
      expectedBehaviors: ["reads the digits back"],
      personaIds: [rita],
      requiredCapabilities: ["raw_audio"],
    })
  ).versionId;
});

afterAll(async () => {
  await disconnectClickHouse();
  await store.drop();
  await database.drop();
});

/* ------------------------------------------------------------------------ *
 * The fold itself, with nothing else in the way.
 * ------------------------------------------------------------------------ */

describe("the read fold, which keeps machinery and judgment apart", () => {
  it("never lets a skipped or canceled conversation become a failure", () => {
    for (const status of ["skipped", "canceled"] as const) {
      const fold = foldSimulation(status, undefined);
      expect(fold.verdict).toBe("skipped");
      expect(fold.grading).toBe("not_required");
      expect(fold.counts).toBeNull();
    }
  });

  it("reads an execution failure as errored, never as failed", () => {
    // Egma could not conduct the conversation. Saying `failed` here would put a
    // red mark against an agent that was never spoken to.
    expect(foldSimulation("failed", undefined).verdict).toBe("errored");
  });

  it("says nothing at all about a conversation nobody has judged yet", () => {
    const fold = foldSimulation("completed", undefined);
    expect(fold.verdict).toBeNull();
    expect(fold.grading).toBe("pending");
  });

  it("gives a run no verdict while any conversation is still being judged", () => {
    const fold = foldRun("running", 2, [
      foldSimulation("completed", {
        verdict: "passed",
        score: 1,
        counts: { passed: 1, failed: 0, skipped: 0, errored: 0, total: 1 },
      }),
      foldSimulation("running", undefined),
    ]);
    expect(fold.verdict).toBeNull();
  });

  it("lets a completed run hold a failed verdict, which is the whole point", () => {
    const fold = foldRun("completed", 2, [
      foldSimulation("completed", {
        verdict: "passed",
        score: 1,
        counts: { passed: 1, failed: 0, skipped: 0, errored: 0, total: 1 },
      }),
      foldSimulation("completed", {
        verdict: "failed",
        score: 0,
        counts: { passed: 0, failed: 1, skipped: 0, errored: 0, total: 1 },
      }),
    ]);
    expect(fold.status).toBe("completed");
    expect(fold.verdict).toBe("failed");
  });

  it("completes an all-skipped run with no passing headline", () => {
    const fold = foldRun("completed", 2, [
      foldSimulation("skipped", undefined),
      foldSimulation("skipped", undefined),
    ]);
    expect(fold.verdict).toBe("skipped");
    expect(fold.simulations.skipped).toBe(2);
    expect(fold.gradable).toBe(0);
    expect(fold.moving).toBe(false);
  });
});

/* ------------------------------------------------------------------------ *
 * The history, over both stores.
 * ------------------------------------------------------------------------ */

describe("a run conducted to a mixed ending", () => {
  let runId: string;

  beforeAll(async () => {
    /*
     * Four endings in one run, because the four must never read alike:
     *
     * - a conversation that happened and was judged badly,
     * - a conversation egma tried and could not conduct,
     * - a conversation egma declined to conduct at all,
     *
     * and the run header that has to finish `completed` while holding a failed
     * verdict. Folding any of the three into "failed" is the defect this whole
     * area exists to prevent.
     */
    const started = await startRun(auth, {
      agentId,
      connectionId,
      testVersionIds: [reschedulesVersion, cancelsVersion, needsAudioVersion],
      idempotencyKey: newId("run"),
    });
    runId = started.id;
    expect(started.expectedSimulationCount).toBe(4);

    const claims = await claimOwn(runId);
    // Three of the four are claimable. The fourth was born `skipped` and never
    // enters the queue, which is what makes it a different fact.
    expect(claims).toHaveLength(3);
    const [first, second, third] = claims;
    if (first === undefined || second === undefined || third === undefined) {
      throw new Error("the run should hand out three conversations");
    }

    await startSimulation(auth, first.id, first.claimedBy);
    await completeSimulation(auth, first.id, first.claimedBy, {
      endingReason: "persona_concluded",
    });
    await startSimulation(auth, second.id, second.claimedBy);
    await completeSimulation(auth, second.id, second.claimedBy, {
      endingReason: "persona_concluded",
    });
    await failSimulation(auth, third.id, third.claimedBy, {
      reason: "agent_never_joined",
    });

    await appendVerdicts(auth, [
      verdictOn({
        simulationId: first.id,
        runId,
        assertion: "offers at least one afternoon slot next week",
        verdict: "failed",
      }),
      verdictOn({
        simulationId: second.id,
        runId,
        assertion: "verifies who it is speaking to before discussing the booking",
        verdict: "passed",
      }),
      // Egma's own failure, written as `errored` by the engine that judged it.
      // The fold says `errored` for this conversation whatever the rows hold —
      // the rows are here so that grading is genuinely finished, which is what
      // lets the run stop moving.
      verdictOn({
        simulationId: third.id,
        runId,
        assertion: "verifies who it is speaking to before discussing the booking",
        verdict: "errored",
      }),
    ]);
  });

  it("finishes completed, with each ending counted as itself", async () => {
    const header = await getRun(auth, runId);
    expect(header?.status).toBe("completed");
    expect(header?.completedCount).toBe(2);
    expect(header?.failedCount).toBe(1);
    expect(header?.canceledCount).toBe(0);
    // Its own number, never folded into the failures.
    expect(header?.skippedCount).toBe(1);
    expect(header?.finishedAt).not.toBeNull();
  });

  it("folds to a failed verdict on a completed run, with nothing collapsed", async () => {
    const entry = await readRunFold(auth, runId);
    if (entry === undefined) throw new Error("the run should be readable");

    // The machinery finished. What it found was bad. Two facts, both kept.
    expect(entry.fold.status).toBe("completed");
    expect(entry.fold.verdict).toBe("failed");

    expect(entry.fold.simulations.completed).toBe(2);
    expect(entry.fold.simulations.failed).toBe(1);
    expect(entry.fold.simulations.skipped).toBe(1);

    /*
     * One vote per conversation. The judged pair split; the execution failure
     * reads `errored` because egma could not conduct it; the skip reads
     * `skipped` because egma declined to. Neither of the last two is ever
     * `failed` — exactly one conversation failed, and it is the one a grader
     * actually judged.
     */
    expect(entry.fold.counts).toEqual({
      passed: 1,
      failed: 1,
      skipped: 1,
      errored: 1,
      total: 4,
    });
    // Only the conversations that left something to read are gradable, and the
    // skipped one is waiting on nothing.
    expect(entry.fold.gradable).toBe(3);
    expect(entry.fold.finished).toBe(4);
    expect(entry.fold.moving).toBe(false);
  });

  it("shows the same fold on the row that opens it", async () => {
    const page = await listRunHistory(auth);
    const row = page.items.find((one) => one.run.id === runId);
    const opened = await readRunFold(auth, runId);
    expect(row?.fold).toEqual(opened?.fold);
  });
});

describe("a run stopped part way", () => {
  let runId: string;
  let straggler: string;

  beforeAll(async () => {
    const started = await startRun(auth, {
      agentId,
      connectionId,
      testVersionIds: [cancelsVersion],
      idempotencyKey: newId("run"),
    });
    runId = started.id;

    // Both conversations are out with a simulator when the cancel lands, so
    // neither settles here and now — the run says `canceled` while they finish
    // honoring the request, which is the shape that must never read as passing.
    const claims = await claimOwn(runId);
    const [held, other] = claims;
    if (held === undefined || other === undefined) {
      throw new Error("the cancel needs both conversations out");
    }
    straggler = held.id;
    await startSimulation(auth, held.id, held.claimedBy);

    await cancelRun(auth, runId);
    expect((await getRun(auth, runId))?.status).toBe("canceled");
    // Counts are not written while a straggler is still out, so the run cannot
    // be read as a finished suite in the meantime.
    expect((await getRun(auth, runId))?.canceledCount).toBeNull();

    // The simulator honors the request at its next heartbeat, and the run's
    // counts settle when the last of them does.
    await markSimulationCanceled(auth, held.id, held.claimedBy);
    await markSimulationCanceled(auth, other.id, other.claimedBy);
  });

  it("stays canceled, and a later landing cannot make it completed", async () => {
    const header = await getRun(auth, runId);
    expect(header?.status).toBe("canceled");
    expect(header?.finishedAt).not.toBeNull();
    // Both conversations settled as canceled: one where it stood, one where it
    // was told to stop.
    expect(header?.canceledCount).toBe(2);
    expect(header?.completedCount).toBe(0);

    /*
     * **The race this exists for.** A simulator that finished its conversation
     * a moment before the cancel reached it reports a completion afterwards.
     * The report lands on a terminal row and changes nothing — it answers
     * `undefined` rather than reopening anything — and the run header stays
     * `canceled`. If it did not, stopping a run early would read as a suite that
     * went green.
     */
    expect(
      await completeSimulation(auth, straggler, "simulator-blue-1", {
        endingReason: "persona_concluded",
      }),
    ).toBeUndefined();

    const after = await getRun(auth, runId);
    expect(after?.status).toBe("canceled");
    expect(after?.completedCount).toBe(0);
    expect(after?.canceledCount).toBe(2);
  });

  it("folds every canceled conversation to skipped, and never to failed", async () => {
    const entry = await readRunFold(auth, runId);
    expect(entry?.fold.status).toBe("canceled");
    expect(entry?.fold.verdict).toBe("skipped");
    expect(entry?.fold.counts.failed).toBe(0);
    expect(entry?.fold.counts.skipped).toBe(2);
    expect(entry?.fold.gradable).toBe(0);
  });
});

describe("the history, narrowed", () => {
  let onSecondConnection: string;
  let cancelled: string;

  beforeAll(async () => {
    onSecondConnection = (
      await startRun(auth, {
        agentId,
        connectionId: secondConnectionId,
        testVersionIds: [reschedulesVersion],
        idempotencyKey: newId("run"),
      })
    ).id;

    cancelled = (
      await startRun(auth, {
        agentId,
        connectionId,
        testVersionIds: [reschedulesVersion],
        idempotencyKey: newId("run"),
      })
    ).id;
    await cancelRun(auth, cancelled);
  });

  it("narrows to one connection without narrowing to its agent's other one", async () => {
    const page = await listRunHistory(auth, {
      connectionId: secondConnectionId,
    });
    expect(page.items.map((one) => one.run.id)).toEqual([onSecondConnection]);
  });

  it("narrows to one machinery state", async () => {
    const page = await listRunHistory(auth, { status: "canceled" });
    expect(page.items.map((one) => one.run.id)).toContain(cancelled);
    for (const entry of page.items) expect(entry.run.status).toBe("canceled");
  });

  it("narrows to the runs that executed one test, by identity", async () => {
    // A run records frozen version ids, so this is asked of the conversations
    // rather than of the header — which is what keeps it right after a test
    // gains a second version.
    const page = await listRunHistory(auth, { testId: cancels });
    expect(page.items.length).toBeGreaterThan(0);
    for (const entry of page.items) {
      expect(entry.run.pinnedTestVersionIds).toContain(cancelsVersion);
    }
    expect(page.items.map((one) => one.run.id)).not.toContain(cancelled);
  });

  it("narrows to a window, newest first, and pages by the run id", async () => {
    const tomorrow = new Date(Date.now() + 86_400_000);
    expect(
      (await listRunHistory(auth, { since: tomorrow })).items,
    ).toEqual([]);

    const first = await listRunHistory(auth, { limit: 1 });
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).toBe(first.items[0]?.run.id);

    const next = await listRunHistory(auth, {
      limit: 1,
      ...(first.nextCursor === undefined ? {} : { cursor: first.nextCursor }),
    });
    // Newest first: the second page is older than the first.
    expect(next.items[0]?.run.id.localeCompare(first.items[0]?.run.id ?? "")).toBeLessThan(0);
  });

  it("narrows to a verdict, and a run nobody has judged matches none of them", async () => {
    // `onSecondConnection` has never been claimed, so it has no verdict at all.
    for (const verdict of ["passed", "failed", "skipped", "errored"] as const) {
      const page = await listRunHistory(auth, { verdict });
      expect(page.items.map((one) => one.run.id)).not.toContain(
        onSecondConnection,
      );
    }
    // And a canceled run's conversations all read `skipped`, which is the one
    // verdict it can match — and never `failed`.
    const skipped = await listRunHistory(auth, { verdict: "skipped" });
    expect(skipped.items.map((one) => one.run.id)).toContain(cancelled);
    const failed = await listRunHistory(auth, { verdict: "failed" });
    expect(failed.items.map((one) => one.run.id)).not.toContain(cancelled);
  });

  it("shows another customer nothing of this one's", async () => {
    const theirs = await listRunHistory(actingAsGlobex());
    expect(theirs.items).toEqual([]);
  });
});

/* ------------------------------------------------------------------------ *
 * Retry.
 * ------------------------------------------------------------------------ */

describe("retrying a run", () => {
  /** A run of the plain selection, for a retry to be derived from. */
  async function anEarlierRun(): Promise<string> {
    return (
      await startRun(auth, {
        agentId,
        connectionId,
        testVersionIds: [reschedulesVersion],
        label: "Nightly smoke",
        idempotencyKey: newId("run"),
      })
    ).id;
  }

  it("derives a new run from the earlier one and never reopens it", async () => {
    const earlier = await anEarlierRun();
    const again = await retryRun(auth, earlier, {
      idempotencyKey: newId("run"),
    });
    if (again === undefined) throw new Error("the retry should have started");

    expect(again.id).not.toBe(earlier);
    expect(again.retryOfRunId).toBe(earlier);
    expect(again.agentId).toBe(agentId);
    expect(again.connectionId).toBe(connectionId);
    expect(again.pinnedTestVersionIds).toEqual([reschedulesVersion]);
    expect(again.label).toBe("Nightly smoke");

    // The earlier run is untouched, and certainly not reopened.
    const before = await getRun(auth, earlier);
    expect(before?.status).toBe("pending");
    expect(before?.retryOfRunId).toBeNull();
  });

  it("answers the same run twice under one key rather than dialing twice", async () => {
    const earlier = await anEarlierRun();
    const key = newId("run");
    const first = await retryRun(auth, earlier, { idempotencyKey: key });
    const second = await retryRun(auth, earlier, { idempotencyKey: key });
    expect(second?.id).toBe(first?.id);
  });

  /**
   * The repeat the key is actually for, and the reason the recall has to be
   * asked before any recheck.
   *
   * The first attempt succeeded and its answer was lost on the way back. By the
   * time the client asks again, the retry it is asking about is already running
   * — and the agent has since been archived, which needs no race at all, only
   * minutes. A recheck in front of the recall would answer "this cannot be
   * retried" about a retry that is running, which is the one failure an
   * idempotency key exists to prevent.
   *
   * It drives `retryRun` twice for real. Nothing here calls the recall itself.
   */
  it("answers the run the key already started, even after the agent is archived", async () => {
    // Its own agent, its own test and its own connection, so archiving it does
    // not disturb the rest of this file.
    const spare = await createAgent(auth, {
      name: `Archived under a repeat ${newId("agt")}`,
      connection: {
        type: "retell",
        modality: "chat",
        config: { retellAgentId: "agent_in_retell_4" },
        credentials: { apiKey: "retell-secret-R1R2R3R4WXYZ" },
      },
    });
    const spareTest = await createTest(auth, {
      name: `Applies to the repeat's agent ${newId("tst")}`,
      scenario: "Anything at all, so long as it applies to this agent.",
      expectedBehaviors: ["answers"],
      personaIds: [rita],
      agentIds: [spare.id],
    });
    const earlier = await startRun(auth, {
      agentId: spare.id,
      connectionId: spare.connection?.id ?? "",
      testVersionIds: [spareTest.versionId],
      idempotencyKey: newId("run"),
    });

    const key = newId("run");
    const first = await retryRun(auth, earlier.id, { idempotencyKey: key });
    if (first === undefined) throw new Error("the retry should have started");

    // Minutes later, and with the retry already dialing.
    await archiveAgent(auth, spare.id);

    const repeated = await retryRun(auth, earlier.id, { idempotencyKey: key });
    expect(repeated?.id).toBe(first.id);
    expect(repeated?.retryOfRunId).toBe(earlier.id);
  });

  /**
   * The shield answers a repeat; it never answers a different request. A key
   * carrying a new body is a conflict, and a conflict must not arrive wearing
   * the Retry sentence — the two lead two different ways, and "choose active
   * resources" would send somebody to fix a thing that is not broken.
   */
  it("still refuses a key reused for a different run, and not as a Retry refusal", async () => {
    const earlier = await anEarlierRun();
    const another = await anEarlierRun();
    const key = newId("run");
    await retryRun(auth, earlier, { idempotencyKey: key });

    // Archived agents and unlinked tests are what the rechecks look for, and
    // this refusal has to come from in front of all of them.
    await expect(
      retryRun(auth, another, { idempotencyKey: key }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it("answers nothing about a run that is not this caller's", async () => {
    const earlier = await anEarlierRun();
    expect(
      await retryRun(actingAsGlobex(), earlier, {
        idempotencyKey: newId("run"),
      }),
    ).toBeUndefined();
  });

  it("refuses a viewer, who cannot start a run by any door", async () => {
    const earlier = await anEarlierRun();
    await expect(
      retryRun(actingAsAcme("viewer"), earlier, {
        idempotencyKey: newId("run"),
      }),
    ).rejects.toThrow(/viewer/u);
  });

  /**
   * Every refusal below is the same shape and the same sentence with a different
   * noun in it, and every one of them is a substitution that did **not** happen.
   * A Retry that quietly swapped in a live replacement would answer "we ran it
   * again" about a different run.
   */
  async function refusalFrom(work: Promise<unknown>): Promise<RunRetryRefusedError> {
    try {
      await work;
    } catch (raised) {
      if (raised instanceof RunRetryRefusedError) return raised;
      throw raised;
    }
    throw new Error("the retry should have been refused");
  }

  it("refuses rather than substituting when the agent has been archived", async () => {
    // Its own agent and its own connection, so archiving does not disturb the
    // rest of this file.
    const spare = await createAgent(auth, {
      name: `Spare for archive ${newId("agt")}`,
      connection: {
        type: "retell",
        modality: "chat",
        config: { retellAgentId: "agent_in_retell_3" },
        credentials: { apiKey: "retell-secret-Q1Q2Q3Q4WXYZ" },
      },
    });
    const spareTest = await createTest(auth, {
      name: `Applies to the spare ${newId("tst")}`,
      scenario: "Anything at all, so long as it applies to this agent.",
      expectedBehaviors: ["answers"],
      personaIds: [rita],
      agentIds: [spare.id],
    });
    const earlier = await startRun(auth, {
      agentId: spare.id,
      connectionId: spare.connection?.id ?? "",
      testVersionIds: [spareTest.versionId],
      idempotencyKey: newId("run"),
    });

    await archiveAgent(auth, spare.id);

    const refused = await refusalFrom(
      retryRun(auth, earlier.id, { idempotencyKey: newId("run") }),
    );
    expect(refused.resourceKind).toBe("agent");
    expect(refused.message).toBe(
      `Run ${earlier.id} cannot be retried because agent ${spare.id} is not ` +
        `active or no longer applies. Open the run builder and choose active ` +
        `resources; the original run was not changed.`,
    );
    // And the earlier run is exactly as it was.
    expect((await getRun(auth, earlier.id))?.status).toBe("canceled");
  });

  it("refuses rather than substituting when the connection has been archived", async () => {
    const earlier = await startRun(auth, {
      agentId,
      connectionId: secondConnectionId,
      testVersionIds: [reschedulesVersion],
      idempotencyKey: newId("run"),
    });
    await archiveConnection(auth, agentId, secondConnectionId);

    const refused = await refusalFrom(
      retryRun(auth, earlier.id, { idempotencyKey: newId("run") }),
    );
    expect(refused.resourceKind).toBe("connection");
    expect(refused.message).toContain(`connection ${secondConnectionId}`);
    expect(refused.message).toContain("the original run was not changed");
  });

  it("refuses rather than substituting when the test has been archived", async () => {
    const earlier = await startRun(auth, {
      agentId,
      connectionId,
      testVersionIds: [cancelsVersion],
      idempotencyKey: newId("run"),
    });
    await archiveTest(auth, cancels);
    try {
      const refused = await refusalFrom(
        retryRun(auth, earlier.id, { idempotencyKey: newId("run") }),
      );
      expect(refused.resourceKind).toBe("test");
      expect(refused.message).toContain(`test ${cancels}`);
    } finally {
      await restoreTest(auth, cancels);
    }
  });

  it("refuses rather than substituting when the test no longer applies to the agent", async () => {
    // A second agent for the test to be linked to instead, so the test keeps
    // its last link and the only thing that changes is the pairing this run used.
    const elsewhere = await createAgent(auth, {
      name: `Somewhere else ${newId("agt")}`,
    });
    const earlier = await startRun(auth, {
      agentId,
      connectionId,
      testVersionIds: [cancelsVersion],
      idempotencyKey: newId("run"),
    });

    const before = await setTestAgents(auth, cancels, {
      agentIds: [elsewhere.id],
    });
    if (before === undefined) throw new Error("the relink should have landed");
    try {
      const refused = await refusalFrom(
        retryRun(auth, earlier.id, { idempotencyKey: newId("run") }),
      );
      // Both the test and the agent are perfectly alive; somebody unlinked
      // them. It is named as the test, which is where the link is repaired.
      expect(refused.resourceKind).toBe("applicability");
      expect(refused.message).toContain(`test ${cancels}`);
    } finally {
      await setTestAgents(auth, cancels, {
        agentIds: [agentId],
        expectedApplicabilityRevision: before.applicabilityRevision,
      });
    }
  });

  it("refuses rather than substituting when a persona the version names is archived", async () => {
    const spare = await seedPersona(`Retired caller ${newId("prs")}`);
    const named = await createTest(auth, {
      name: `Names the retired caller ${newId("tst")}`,
      scenario: "Anything, so long as this persona calls about it.",
      expectedBehaviors: ["answers"],
      personaIds: [spare],
    });
    const earlier = await startRun(auth, {
      agentId,
      connectionId,
      testVersionIds: [named.versionId],
      idempotencyKey: newId("run"),
    });

    // The test moves off the persona so the archive is allowed, and the frozen
    // version this run pinned still names them — which is exactly the case.
    await editTest(auth, named.id, {
      personaIds: [rita],
      expectedVersionId: named.versionId,
    });
    await archivePersona(auth, spare);

    const refused = await refusalFrom(
      retryRun(auth, earlier.id, { idempotencyKey: newId("run") }),
    );
    expect(refused.resourceKind).toBe("persona");
    expect(refused.message).toContain(`persona ${spare}`);
  });

  /*
   * **Two refusals over an archived grader used to live here, and both go.**
   * One rechecked before the Retry called in and one rechecked inside the
   * transaction that freezes the plan, and both were about a grader a pinned
   * test version named *directly*. A test names no graders now: what judges a
   * run is the project's live running copies and their scope, so a copy
   * switched off between two runs is a decision about the project rather than
   * something a Retry may overrule. Every other resource a Retry rechecks — the
   * agent, the connection, the tests, their applicability, the personas — is
   * still proved above and below.
   */
});

describe("running one simulation again", () => {
  it("creates one new simulation from the exact test and persona without changing the source", async () => {
    const earlier = await startRun(auth, {
      agentId,
      connectionId,
      testVersionIds: [cancelsVersion],
      label: "Original run",
      idempotencyKey: newId("run"),
    });
    await cancelRun(auth, earlier.id);

    const source = earlier.simulations[1];
    if (source === undefined) {
      throw new Error("the source run should contain two simulations");
    }

    const again = await rerunSimulation(auth, source.id, {
      label: "Deliberate Sam again",
      idempotencyKey: newId("run"),
    });
    if (again === undefined) throw new Error("the simulation should run again");

    expect(again.id).not.toBe(earlier.id);
    expect(again.retryOfRunId).toBe(earlier.id);
    expect(again.label).toBe("Deliberate Sam again");
    expect(again.pinnedTestVersionIds).toEqual([cancelsVersion]);
    expect(again.simulations).toHaveLength(1);
    expect(again.simulations[0]).toMatchObject({
      testVersionId: cancelsVersion,
      personaId: source.personaId,
      personaName: source.personaName,
      position: 1,
      status: "queued",
    });

    expect((await getRun(auth, earlier.id))?.status).toBe("canceled");
    expect(await listSimulations(auth, earlier.id)).toHaveLength(2);
  });

  it("refuses while the source simulation is still active", async () => {
    const earlier = await startRun(auth, {
      agentId,
      connectionId,
      testVersionIds: [reschedulesVersion],
      idempotencyKey: newId("run"),
    });
    const source = earlier.simulations[0];
    if (source === undefined) throw new Error("the source simulation is needed");

    await expect(
      rerunSimulation(auth, source.id, {
        label: "Too early",
        idempotencyKey: newId("run"),
      }),
    ).rejects.toBeInstanceOf(SimulationRerunRefusedError);
  });

  it("answers one new run twice under the same key and conflicts on another source", async () => {
    const earlier = await startRun(auth, {
      agentId,
      connectionId,
      testVersionIds: [cancelsVersion],
      idempotencyKey: newId("run"),
    });
    await cancelRun(auth, earlier.id);
    const [firstSource, secondSource] = earlier.simulations;
    if (firstSource === undefined || secondSource === undefined) {
      throw new Error("two source simulations are needed");
    }

    const key = newId("run");
    const first = await rerunSimulation(auth, firstSource.id, {
      label: "First source again",
      idempotencyKey: key,
    });
    const repeated = await rerunSimulation(auth, firstSource.id, {
      label: "First source again",
      idempotencyKey: key,
    });
    expect(repeated?.id).toBe(first?.id);

    await expect(
      rerunSimulation(auth, secondSource.id, {
        label: "Second source",
        idempotencyKey: key,
      }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it("recalls an already-created simulation rerun without starting another", async () => {
    const earlier = await startRun(auth, {
      agentId,
      connectionId,
      testVersionIds: [reschedulesVersion],
      idempotencyKey: newId("run"),
    });
    await cancelRun(auth, earlier.id);
    const source = earlier.simulations[0];
    if (source === undefined) throw new Error("the source simulation is needed");

    const request = {
      label: "Recall this rerun",
      idempotencyKey: newId("run"),
    };
    expect(
      await simulationRerunAlreadyStarted(auth, source.id, request),
    ).toBeUndefined();

    const started = await rerunSimulation(auth, source.id, request);
    const recalled = await simulationRerunAlreadyStarted(
      auth,
      source.id,
      request,
    );
    expect(recalled?.id).toBe(started?.id);
  });

  it("uses the persona's current version while keeping the source persona identity", async () => {
    const person = await createPersona(auth, {
      name: `Moves after the source ${newId("prs")}`,
      traits: neutralTraits,
    });
    const named = await createTest(auth, {
      name: `Names the moving persona ${newId("tst")}`,
      scenario: "Anything, so long as this persona calls about it.",
      expectedBehaviors: ["answers"],
      personaIds: [person.id],
      agentIds: [agentId],
    });
    const earlier = await startRun(auth, {
      agentId,
      connectionId,
      testVersionIds: [named.versionId],
      idempotencyKey: newId("run"),
    });
    await cancelRun(auth, earlier.id);
    const source = earlier.simulations[0];
    if (source === undefined) throw new Error("the source simulation is needed");

    const moved = await editPersona(auth, person.id, {
      traits: {
        ...neutralTraits,
        voice: { ...neutralTraits.voice, speed: 0.9 },
      },
    });
    if (moved === undefined) throw new Error("the persona edit should land");

    const again = await rerunSimulation(auth, source.id, {
      label: "Current persona version",
      idempotencyKey: newId("run"),
    });
    expect(again?.simulations[0]).toMatchObject({
      personaId: source.personaId,
      personaVersionId: moved.versionId,
    });
    expect(again?.simulations[0]?.personaVersionId).not.toBe(
      source.personaVersionId,
    );
  });

  it("refuses legacy evidence that recorded no test version", async () => {
    const earlier = await startRun(auth, {
      agentId,
      connectionId,
      testVersionIds: [reschedulesVersion],
      idempotencyKey: newId("run"),
    });
    const source = earlier.simulations[0];
    if (source === undefined) throw new Error("the source simulation is needed");
    await database.sql(
      "update simulation set test_id = null, test_version_id = null where id = $1",
      [source.id],
    );
    await cancelRun(auth, earlier.id);

    await expect(
      rerunSimulation(auth, source.id, {
        label: "Cannot be reconstructed",
        idempotencyKey: newId("run"),
      }),
    ).rejects.toMatchObject({ reason: "legacy" });
  });

  it("requires a new run name and the same permission as starting a run", async () => {
    const earlier = await startRun(auth, {
      agentId,
      connectionId,
      testVersionIds: [reschedulesVersion],
      idempotencyKey: newId("run"),
    });
    await cancelRun(auth, earlier.id);
    const source = earlier.simulations[0];
    if (source === undefined) throw new Error("the source simulation is needed");

    await expect(
      rerunSimulation(auth, source.id, {
        label: "   ",
        idempotencyKey: newId("run"),
      }),
    ).rejects.toMatchObject({ reason: "name_required" });
    await expect(
      rerunSimulation(auth, source.id, {
        label: "No key",
        idempotencyKey: "   ",
      }),
    ).rejects.toMatchObject({ reason: "idempotency_key_required" });
    await expect(
      rerunSimulation(actingAsAcme("viewer"), source.id, {
        label: "Viewer cannot run it",
        idempotencyKey: newId("run"),
      }),
    ).rejects.toThrow(/viewer/u);
    expect(
      await rerunSimulation(actingAsGlobex(), source.id, {
        label: "Not visible",
        idempotencyKey: newId("run"),
      }),
    ).toBeUndefined();
  });

  it("refuses when the source test is archived or no longer applies", async () => {
    const named = await createTest(auth, {
      name: `Moves after its source ${newId("tst")}`,
      scenario: "Anything, so long as the test remains available.",
      expectedBehaviors: ["answers"],
      personaIds: [rita],
      agentIds: [agentId],
    });
    const earlier = await startRun(auth, {
      agentId,
      connectionId,
      testVersionIds: [named.versionId],
      idempotencyKey: newId("run"),
    });
    await cancelRun(auth, earlier.id);
    const source = earlier.simulations[0];
    if (source === undefined) throw new Error("the source simulation is needed");

    await archiveTest(auth, named.id);
    await expect(
      rerunSimulation(auth, source.id, {
        label: "Archived source",
        idempotencyKey: newId("run"),
      }),
    ).rejects.toBeInstanceOf(RunWriteRefusedError);
    await restoreTest(auth, named.id);

    const elsewhere = await createAgent(auth, {
      name: `Only target left ${newId("agt")}`,
    });
    await setTestAgents(auth, named.id, { agentIds: [elsewhere.id] });
    await expect(
      rerunSimulation(auth, source.id, {
        label: "Unlinked source",
        idempotencyKey: newId("run"),
      }),
    ).rejects.toMatchObject({ reason: "test_not_applicable" });
  });
});

/* ------------------------------------------------------------------------ *
 * The guard under all of it.
 * ------------------------------------------------------------------------ */

describe("the lifecycle guard on the simulation table", () => {
  /**
   * A conversation born `skipped` is terminal from its first moment, and the
   * database is what makes that true.
   *
   * **`skipped → claimed` is the one transition that matters most here**, and it
   * is the one 0029 had to teach the trigger about: without that line the guard
   * reads a skipped row as a live one and lets it be claimed, which would put a
   * conversation egma deliberately declined to have in front of a simulator. The
   * module's own claim never asks for one, so only a direct write can prove the
   * guard is there rather than the query merely never trying.
   */
  it("refuses skipped → claimed, which no simulator may ever be handed", async () => {
    const needsAudio = await createTest(auth, {
      name: `Needs raw audio ${newId("tst")}`,
      scenario: "Something that only makes sense over a real audio channel.",
      expectedBehaviors: ["answers"],
      personaIds: [rita],
      requiredCapabilities: ["raw_audio"],
    });
    const started = await startRun(auth, {
      agentId,
      connectionId,
      testVersionIds: [needsAudio.versionId],
      idempotencyKey: newId("run"),
    });

    const [only] = started.simulations;
    if (only === undefined) throw new Error("the run should hold one skip");
    expect(only.status).toBe("skipped");

    await expect(
      database.sql("update simulation set status = 'claimed' where id = $1", [
        only.id,
      ]),
    ).rejects.toThrow(/is skipped, and a terminal simulation is written once/u);
  });
});
