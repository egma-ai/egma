import {
  appendVerdicts,
  claimGradingJobs,
  finishGradingJob,
  listGraders,
  listGradingJobsForSimulation,
  PREDEFINED_GRADERS,
  useLibraryEntry,
  type AuthContext,
  type NewVerdict,
} from "@egma/db";
import { traceIdOfSimulation } from "@egma/simulation-contract";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { createApi, type TestApi } from "./support/api.ts";
import {
  startObjectStorage,
  type ObjectStorage,
} from "./support/object-storage.ts";
import {
  aConductedRun,
  fileTranscriptOf,
  standingOf,
  type ConductedRun,
  type Standing,
} from "./support/recordings.ts";
import { colleagueOf, request as ask, signUp, type Answer } from "./support/traces.ts";

/**
 * One conversation's evidence over real HTTP, against real Postgres and a real
 * ClickHouse.
 *
 * **The claim is that one request is enough**, and that is what most of this
 * file is about: what happened, the versions it executed against, who it was
 * against, what egma made of it and what a person said afterwards all arrive
 * together — including the transcript, whose window this side works out from the
 * conversation's own stamps rather than asking a caller to guess it.
 *
 * The rest is how a judgment is revisited, and who may. A `viewer` sees every
 * piece of evidence on the page and is refused the re-grade **by the server**;
 * the page offering no button is the page agreeing with this, never the check
 * itself.
 *
 * **There is no correction here, and there was.** ADR-0009 takes a person's
 * disagreement out of v0: it returns as the reserved `human` grader type,
 * writing its own rows under its own grader id, which is why no verdict row
 * carries who judged it any more.
 */

const storage: ObjectStorage = await startObjectStorage("simulation-evidence");

if (!storage.available) {
  process.stderr.write(
    `\nskipping the simulation-evidence suite — ${storage.why}\n\n`,
  );
}

let api: TestApi;

afterEach(async () => {
  await api?.close();
});

afterAll(() => {
  if (storage.available) storage.stop();
});

function request(
  method: "GET" | "POST",
  url: string,
  key: string,
  payload?: Record<string, unknown>,
): Promise<Answer> {
  return ask(api.app, method, url, key, payload);
}

const GRADER = "grd_01JQZ0000000000000000000AA";
const GRADER_VERSION = "grv_01JQZ0000000000000000000AA";
const BEHAVIOR = "confirms the new time back before finishing";

/** Who moved the conversations, as a simulator and a grader name themselves. */
const CLAIMANT = "simulator-blue-1";

/** What the engine said about one conversation, stated field by field. */
function machineVerdict(
  one: ConductedRun,
  simulationId: string,
  overrides: Partial<NewVerdict> = {},
): NewVerdict {
  return {
    traceId: simulationId,
    graderId: GRADER,
    graderVersionId: GRADER_VERSION,
    assertion: BEHAVIOR,
    source: "simulation",
    verdict: "failed",
    score: 0,
    rationale: "the agent never said the new time back.",
    citedSpanIds: [],
    runId: one.runId,
    agentId: "agt_01JQZ0000000000000000000AA",
    agentVersionId: "",
    judgedAtMicroseconds: BigInt(Date.parse("2026-08-15T10:00:00Z")) * 1000n,
    ...overrides,
  };
}

type Conducted = {
  readonly who: Standing;
  readonly ada: Awaited<ReturnType<typeof signUp>>;
  readonly run: ConductedRun;
};

/**
 * A customer with one run of two conversations. Evidence reads can also ask
 * for one transcript filed at the door a simulator files one at. Re-grade
 * checks use only the Postgres queue, so they do not create a ClickHouse store.
 *
 * Every step goes through the product: the agent is registered over HTTP, the
 * test is pushed over HTTP, the run is started over HTTP, and the conversations
 * are moved with the same data-access calls a simulator makes.
 */
async function aCustomerWhoHasRun(
  label: string,
  options: { readonly withTraceEvidence?: boolean } = {},
): Promise<Conducted> {
  api = await createApi(label, {
    traceStore: options.withTraceEvidence === true,
    ...(options.withTraceEvidence === true && storage.available
      ? { ingestStore: storage.ingestStore }
      : {}),
  });
  const ada = await signUp(api.app, "ada@acme.example", "Acme");
  const who = await standingOf(api.app, ada.cookie, "a terminal");
  const run = await aConductedRun(api.app, who, {
    reference: "sim_01JQ0A2B3C4D5E6F7G8H9J0K/dual-channel.wav",
  });

  if (options.withTraceEvidence === true) {
    await fileTranscriptOf(
      api,
      run.heard,
      {
        human: "I need to move Thursday's clean to next week.",
        agent: "Of course — Tuesday at four works. You are all set.",
      },
      new Date(),
    );
  }

  return { who, ada, run };
}

/** Move every outstanding grading job of this customer to `graded`. */
async function finishGrading(auth: AuthContext): Promise<void> {
  const claimed = await claimGradingJobs({ claimant: CLAIMANT, capacity: 50 });
  for (const job of claimed) {
    await finishGradingJob(auth, job.id, CLAIMANT);
  }
}

/**
 * A grader this customer actually holds, so a re-grade can be narrowed to one.
 *
 * `GRADER` above is a made-up id on purpose — it is what the "not there for a
 * grader nobody can reach" test names — and a narrowing test needs the opposite.
 */
async function aGraderOf(auth: AuthContext, name: string): Promise<string> {
  const created = await useLibraryEntry(auth, {
    libraryId: PREDEFINED_GRADERS.latency,
    name,
    params: { metric: "turn_response_latency", bound: 2_000 },
  });
  return created.id;
}

/** The seeded expected-behaviors copy, reached through the ordinary grader list. */
async function expectedBehaviorsGraderOf(auth: AuthContext): Promise<string> {
  const page = await listGraders(auth);
  const matches = page.items.filter(
    (item) => item.libraryId === PREDEFINED_GRADERS.expectedBehaviors,
  );
  if (matches.length !== 1) {
    throw new Error(
      `expected one expected-behaviors grader, found ${matches.length}`,
    );
  }
  return matches[0]?.id ?? "";
}

/**
 * Take the outstanding work the way the grader service takes it: the real claim,
 * instance-wide and oldest-first, which is the only thing that moves a job to
 * `claimed` and stamps whose it is.
 */
async function theEngineTakesTheWork(claimant: string): Promise<void> {
  await claimGradingJobs({ claimant, capacity: 50 });
}

/** How this conversation's one job stands, as the route's own read sees it. */
async function theJobOn(
  auth: AuthContext,
  simulationId: string,
): Promise<{ status: string; narrowedTo: string | null }> {
  const jobs = await listGradingJobsForSimulation(auth, simulationId);
  const [only] = jobs;
  if (only === undefined || jobs.length !== 1) {
    throw new Error(`${simulationId} has ${jobs.length} grading jobs, not one`);
  }
  return { status: only.status, narrowedTo: only.regradeGraderId };
}

describe.skipIf(!storage.available)("one conversation's evidence, in one read", () => {
  it("carries the pins, the identities, the plan, the judgement and the transcript together", async () => {
    const { who, run } = await aCustomerWhoHasRun("evidence_one_read", {
      withTraceEvidence: true,
    });
    await appendVerdicts(who.auth, [machineVerdict(run, run.heard)]);

    const read = await request("GET", `/v1/simulations/${run.heard}`, who.key);
    expect(read.statusCode, JSON.stringify(read.body)).toBe(200);

    // Which run this belongs to, so the page can go back to it.
    expect(read.body.runId).toBe(run.runId);

    // The two pins: what actually executed, which never moves.
    const test = read.body.test as Record<string, unknown>;
    expect(String(test.versionId)).toMatch(/^tstv_/u);
    expect(String(test.scenario)).toContain("cleaning is booked for Thursday");
    expect(test.expectedBehaviors).toEqual([BEHAVIOR]);

    const persona = read.body.persona as Record<string, unknown>;
    expect(String(persona.versionId)).toMatch(/^prsv_/u);
    expect(persona.traits).not.toBeNull();
    const personaTraits = persona.traits as Record<string, unknown>;
    expect(Object.keys(personaTraits).sort()).toEqual([
      "language",
      "personality",
    ]);
    expect(personaTraits.personality).toEqual(expect.any(String));
    expect(personaTraits.language).toEqual(expect.any(String));
    expect(personaTraits).not.toHaveProperty("voice");

    // Who it was against, and exactly how egma reached them.
    expect((read.body.agent as { name: string }).name).toMatch(
      /^Front desk voice \d+$/u,
    );
    expect((read.body.connection as { name: string }).name).not.toBe(null);
    const snapshot = read.body.connectionSnapshot as Record<string, unknown>;
    expect(snapshot.agentPlatform).toBe("livekit_agents");
    expect(snapshot.connectionKind).toBe("livekit_room");
    expect(snapshot.accessVariant).toBe("livekit_room.project_credentials");
    expect(snapshot.modality).toBe("voice");
    // Nothing a credential could ride in. The secret lives in its own sealed
    // column and was never copied into the snapshot.
    expect(JSON.stringify(snapshot)).not.toContain("livekit-key");
    expect(JSON.stringify(snapshot)).not.toContain("livekit-secret");

    // What judged it, and the state that says how much of it can be believed.
    const plan = read.body.gradingPlan as { state: string; items: unknown[] };
    expect(plan.state).toBe("run_start");
    expect(plan.items.length).toBeGreaterThan(0);

    // What egma made of it, with everything a reviewer needs to argue back.
    const verdicts = read.body.verdicts as Record<string, unknown>[];
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]).toMatchObject({
      graderId: GRADER,
      assertion: BEHAVIOR,
      verdict: "failed",
      // A grader nothing on this project holds is required, which is the safe
      // direction: a row nobody could resolve must not quietly stop being able
      // to fail anything.
      required: true,
    });

    // And what was said, read inside a window nobody had to name.
    const transcript = read.body.transcript as {
      turns: { text: string }[];
      spansTruncated: boolean;
    };
    expect(transcript.turns.map((turn) => turn.text)).toEqual([
      "I need to move Thursday's clean to next week.",
      "Of course — Tuesday at four works. You are all set.",
    ]);
    expect(transcript.spansTruncated).toBe(false);

    // Reported counts, not judgements, and only what is actually known.
    const measures = read.body.measures as Record<string, number>;
    expect(measures.turnCount).toBe(6);
    expect(measures).not.toHaveProperty("measuredAudioBandHertz");
    expect(measures.humanTurnCount).toBe(1);
  });

  /**
   * A conversation that never emitted anything is not a fault. The evidence
   * still reads; the transcript is `null` rather than an empty tree, which is
   * the difference between *nothing was filed* and *nobody said anything*.
   */
  it("says there is no transcript rather than drawing an empty one", async () => {
    const { who, run } = await aCustomerWhoHasRun("evidence_no_transcript", {
      withTraceEvidence: true,
    });

    const read = await request("GET", `/v1/simulations/${run.silent}`, who.key);
    expect(read.statusCode, JSON.stringify(read.body)).toBe(200);
    expect(read.body.transcript).toBeNull();
    // The evidence around it is all still there.
    expect(read.body.runId).toBe(run.runId);
    expect((read.body.test as { versionId: string }).versionId).not.toBeNull();
  });

  /**
   * A conversation nobody has judged is not a conversation that failed. The
   * grading state says the work is outstanding and the verdict stays null.
   */
  it("reports pending grading without turning the page into a failure", async () => {
    const { who, run } = await aCustomerWhoHasRun("evidence_pending", {
      withTraceEvidence: true,
    });

    const read = await request("GET", `/v1/simulations/${run.heard}`, who.key);
    expect(read.statusCode, JSON.stringify(read.body)).toBe(200);
    expect(read.body.status).toBe("completed");
    expect(read.body.grading).toBe("pending");
    expect(read.body.verdict).toBeNull();
    const jobs = read.body.gradingJobs as { status: string }[];
    expect(jobs.map((job) => job.status)).toContain("pending");
  });

  it("is not there for another organization, whatever the id", async () => {
    const { run } = await aCustomerWhoHasRun("evidence_other_customer");
    const grace = await signUp(api.app, "grace@globex.example", "Globex");

    const read = await request(
      "GET",
      `/v1/simulations/${run.heard}`,
      grace.secret,
    );
    expect(read.statusCode).toBe(404);
    expect(read.body.error).toBe("not_found");
  });
});

describe.skipIf(!storage.available)("judging one conversation again", () => {
  it("reopens its grading job, and says what the ask was narrowed to", async () => {
    const { who, run } = await aCustomerWhoHasRun("evidence_regrade");
    await finishGrading(who.auth);

    const asked = await request(
      "POST",
      `/v1/simulations/${run.heard}/regrade`,
      who.key,
      {},
    );
    expect(asked.statusCode, JSON.stringify(asked.body)).toBe(200);
    expect(asked.body).toMatchObject({
      simulationId: run.heard,
      // No grader named: the whole applicable set is resolved again.
      graderId: null,
      reopened: 1,
    });

    const jobs = await listGradingJobsForSimulation(who.auth, run.heard);
    expect(jobs.map((job) => job.status)).toEqual(["pending"]);
    expect(jobs[0]?.regradeGraderId).toBeNull();

    // And the conversation beside it was left exactly alone. A re-grade of one
    // conversation is a re-grade of one conversation.
    const neighbour = await listGradingJobsForSimulation(who.auth, run.silent);
    expect(neighbour.map((job) => job.status)).toEqual(["graded"]);
  });

  it("refuses a graderId that is not a grader id, and says why", async () => {
    const { who, run } = await aCustomerWhoHasRun("evidence_regrade_shape");
    await finishGrading(who.auth);

    const asked = await request(
      "POST",
      `/v1/simulations/${run.heard}/regrade`,
      who.key,
      { graderId: "expected_behaviors_v1" },
    );
    expect(asked.statusCode).toBe(400);
    expect(String(asked.body.message)).toContain("active grader");
    expect(String(asked.body.message)).not.toContain("never a row");
    // Nothing was reopened by a refused ask.
    const jobs = await listGradingJobsForSimulation(who.auth, run.heard);
    expect(jobs.map((job) => job.status)).toEqual(["graded"]);
  });

  it("targets the seeded expected-behaviors grader by its ordinary grader id", async () => {
    const { who, run } = await aCustomerWhoHasRun(
      "evidence_regrade_expected_behaviors",
    );
    await finishGrading(who.auth);
    const grader = await expectedBehaviorsGraderOf(who.auth);

    const asked = await request(
      "POST",
      `/v1/simulations/${run.heard}/regrade`,
      who.key,
      { graderId: grader },
    );

    expect(asked.statusCode, JSON.stringify(asked.body)).toBe(200);
    expect(asked.body).toMatchObject({
      simulationId: run.heard,
      graderId: grader,
      reopened: 1,
    });
    expect(await theJobOn(who.auth, run.heard)).toEqual({
      status: "pending",
      narrowedTo: grader,
    });
  });

  it("is not there for a grader this customer cannot reach", async () => {
    const { who, run } = await aCustomerWhoHasRun("evidence_regrade_grader");
    await finishGrading(who.auth);

    const asked = await request(
      "POST",
      `/v1/simulations/${run.heard}/regrade`,
      who.key,
      { graderId: GRADER },
    );
    expect(asked.statusCode).toBe(404);
    const jobs = await listGradingJobsForSimulation(who.auth, run.heard);
    expect(jobs.map((job) => job.status)).toEqual(["graded"]);
  });

  /**
   * The four cases a conversation already in the queue can be in, driven through
   * the route rather than through the sentence that answers it — the branch is
   * the thing under test, and a test of the sentence alone would pass with the
   * route choosing the wrong one of them.
   *
   * A claimed job is judged under the instruction it was claimed with. So the
   * question is never "is anything running" but "does what is running cover what
   * has just been asked", and only the last two below say no.
   */
  it("still says a conversation is already waiting when the work running judges everything", async () => {
    const { who, run } = await aCustomerWhoHasRun("evidence_regrade_covered");
    await finishGrading(who.auth);
    const grader = await aGraderOf(who.auth, "Answers inside two seconds");

    // Asked for the whole conversation, then taken by the engine.
    const first = await request(
      "POST",
      `/v1/simulations/${run.heard}/regrade`,
      who.key,
      {},
    );
    expect(first.statusCode, JSON.stringify(first.body)).toBe(200);
    await theEngineTakesTheWork("grader-judging-everything");
    expect(await theJobOn(who.auth, run.heard)).toEqual({
      status: "claimed",
      narrowedTo: null,
    });

    // Judging everything includes judging this grader, so the ask is carried
    // out by the work already running and the old sentence is the true one.
    const again = await request(
      "POST",
      `/v1/simulations/${run.heard}/regrade`,
      who.key,
      { graderId: grader },
    );
    expect(again.statusCode, JSON.stringify(again.body)).toBe(200);
    expect(again.body).toMatchObject({
      simulationId: run.heard,
      reopened: 0,
      alreadyWaiting: 1,
    });
  });

  it("still says a conversation is already waiting when the ask is the narrowing already running", async () => {
    const { who, run } = await aCustomerWhoHasRun("evidence_regrade_same");
    await finishGrading(who.auth);
    const grader = await aGraderOf(who.auth, "Answers inside two seconds");

    const first = await request(
      "POST",
      `/v1/simulations/${run.heard}/regrade`,
      who.key,
      { graderId: grader },
    );
    expect(first.statusCode, JSON.stringify(first.body)).toBe(200);
    await theEngineTakesTheWork("grader-judging-that-grader");
    expect(await theJobOn(who.auth, run.heard)).toEqual({
      status: "claimed",
      narrowedTo: grader,
    });

    const again = await request(
      "POST",
      `/v1/simulations/${run.heard}/regrade`,
      who.key,
      { graderId: grader },
    );
    expect(again.statusCode, JSON.stringify(again.body)).toBe(200);
    expect(again.body).toMatchObject({ reopened: 0, alreadyWaiting: 1 });
  });

  it("says nothing was queued when the work running is narrowed to another grader", async () => {
    const { who, run } = await aCustomerWhoHasRun("evidence_regrade_narrowed");
    await finishGrading(who.auth);
    const judged = await aGraderOf(who.auth, "Answers inside two seconds");
    const asked = await aGraderOf(who.auth, "Reads the booking back");

    const first = await request(
      "POST",
      `/v1/simulations/${run.heard}/regrade`,
      who.key,
      { graderId: judged },
    );
    expect(first.statusCode, JSON.stringify(first.body)).toBe(200);
    await theEngineTakesTheWork("grader-judging-one-grader");

    const again = await request(
      "POST",
      `/v1/simulations/${run.heard}/regrade`,
      who.key,
      { graderId: asked },
    );

    // Not a success with a caveat: the ask was not carried out and nothing was
    // queued behind it, so no verdict for it is ever coming.
    expect(again.statusCode, JSON.stringify(again.body)).toBe(409);
    expect(again.body.error).toBe("narrower_grading_in_flight");
    expect(String(again.body.message)).toContain("being judged right now");
    expect(String(again.body.message)).toContain("Ask again once those");
    // And it says nothing that could be read as "already waiting".
    expect(again.body.alreadyWaiting).toBeUndefined();
    expect(again.body.reopened).toBeUndefined();

    // The judgment already running is untouched. Nothing interrupts it.
    expect(await theJobOn(who.auth, run.heard)).toEqual({
      status: "claimed",
      narrowedTo: judged,
    });
  });

  it("says nothing was queued when the whole conversation is asked for over a narrowed judgment", async () => {
    const { who, run } = await aCustomerWhoHasRun("evidence_regrade_whole");
    await finishGrading(who.auth);
    const judged = await aGraderOf(who.auth, "Answers inside two seconds");

    const first = await request(
      "POST",
      `/v1/simulations/${run.heard}/regrade`,
      who.key,
      { graderId: judged },
    );
    expect(first.statusCode, JSON.stringify(first.body)).toBe(200);
    await theEngineTakesTheWork("grader-judging-one-of-many");

    // The ask a browser makes: the whole conversation. One grader of it is
    // running, and the rest of it is not going to be judged by that job.
    const again = await request(
      "POST",
      `/v1/simulations/${run.heard}/regrade`,
      who.key,
      {},
    );

    expect(again.statusCode, JSON.stringify(again.body)).toBe(409);
    expect(again.body.error).toBe("narrower_grading_in_flight");
    expect(await theJobOn(who.auth, run.heard)).toEqual({
      status: "claimed",
      narrowedTo: judged,
    });
  });

  it("refuses a viewer, whatever their page offers them", async () => {
    const { who, ada, run } = await aCustomerWhoHasRun("evidence_regrade_viewer", {
      withTraceEvidence: true,
    });
    await finishGrading(who.auth);
    const sam = await colleagueOf(api.app, ada, "sam@acme.example", "viewer");

    // They can read every piece of evidence on the page.
    const read = await request("GET", `/v1/simulations/${run.heard}`, sam.secret);
    expect(read.statusCode, JSON.stringify(read.body)).toBe(200);

    const asked = await request(
      "POST",
      `/v1/simulations/${run.heard}/regrade`,
      sam.secret,
      {},
    );
    expect(asked.statusCode).toBe(403);
    expect(asked.body.error).toBe("not_permitted");

    // And the queue is untouched by the attempt.
    const jobs = await listGradingJobsForSimulation(who.auth, run.heard);
    expect(jobs.map((job) => job.status)).toEqual(["graded"]);
  });
});

/*
 * **Four proofs about disagreeing with a judgement used to stand here**, and
 * they go with the endpoint: a person's word written beside the machine's, a
 * correction with no reason refused, a correction of a judgement nobody made
 * refused, and a viewer refused the write. ADR-0009 takes corrections and their
 * calibration data out of v0. The capability returns as the reserved `human`
 * grader type — rows of its own under a grader id of its own — and its proofs
 * belong with it when it does, not weakened into something smaller here.
 */

/**
 * The two identifiers a reader holds are the same 128 bits written two ways, and
 * this is where that stops being a claim: the transcript above came back under
 * the id derived from the conversation, with nothing having stored a mapping.
 */
describe.skipIf(!storage.available)("the conversation and its spans", () => {
  it("files the transcript under the id derived from the simulation", async () => {
    const { who, run } = await aCustomerWhoHasRun("evidence_trace_identity", {
      withTraceEvidence: true,
    });

    const read = await request("GET", `/v1/simulations/${run.heard}`, who.key);
    const transcript = read.body.transcript as { traceId: string };
    expect(transcript.traceId).toBe(traceIdOfSimulation(run.heard));
  });

  /**
   * **Simulation evidence goes through the same durable path, and is graded
   * once.**
   *
   * One rule stands between a simulation's spans and a second piece of grading
   * work: a span whose source is not `production` is not reported through the
   * evidence-ready boundary. The door writes nothing at all, and the drainer
   * reports every segment it drains without knowing whose conversation is
   * whose — so that per-span rule is the only guard there is.
   *
   * A simulation's grading work is minted by the transaction that lands it
   * terminal, so a second piece filed from telemetry would be one conversation
   * judged twice. That is why the evidence going in **and** the evidence going
   * through the drainer are both proved here rather than assumed.
   */
  it("grades exactly once, however many segments its spans arrive in", async () => {
    const { who, run } = await aCustomerWhoHasRun("evidence_graded_once", {
      withTraceEvidence: true,
    });

    // A second flush of the same conversation, drained on its own — which is
    // the shape a simulator's ordered sender really produces.
    await fileTranscriptOf(
      api,
      run.heard,
      { human: "One more thing.", agent: "Of course." },
      new Date(),
    );

    const jobs = await listGradingJobsForSimulation(who.auth, run.heard);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ source: "simulation" });

    // And nothing was filed against the trace those spans are stored under,
    // which is where a second piece of work would have appeared.
    const { rows } = await api.database.sql<{ count: string }>(
      "select count(*) as count from grading_job where source = $1",
      ["production"],
    );
    expect(rows[0]?.count).toBe("0");
  });
});
