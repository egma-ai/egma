import {
  claimGradingJobs,
  editGrader,
  getGradingJobForTrace,
  listGraders,
  readTrace,
  readVerdicts,
} from "@egma/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { conversationOfTrace } from "../src/conversation.ts";
import {
  aLatencyCopy,
  conductProductionTrace,
  conductSimulation,
  eventually,
  exportALateFlush,
  jobFor,
  makeWorld,
  runService,
  seedGrader,
  seedTest,
  testConfig,
  theSeededGrader,
  verdictsOn,
  type World,
} from "./support/world.ts";
import type { Service } from "../src/service.ts";

/**
 * The same graders, the other source: a real caller's conversation, judged.
 *
 * **The contract is the seam here too.** A trace's spans and a grader
 * configuration go in; the assertions are on the verdict rows that come out and
 * on nothing about how they got written. Every test in this file could be
 * satisfied by a completely different implementation of the completion trigger,
 * which is the point.
 *
 * **The backstop and the idle window are both an hour away on purpose.** So a
 * trace judged inside a test's patience was judged because its root span closed
 * and woke somebody — never because an interval came round. The one test that is
 * about the idle window runs its own service with its own window.
 */

let world: World;
let service: Service;

beforeAll(async () => {
  world = await makeWorld("grader_production");
  service = runService(testConfig());
});

afterAll(async () => {
  service.stop();
  await service.finished;
  await world.drop();
});

describe("a production trace whose root span closes", () => {
  it("is judged by exactly the project graders whose scope includes production", async () => {
    const monitoring = await seedGrader(
      world,
      aLatencyCopy({ name: "Production only", scope: "production" }),
    );
    const both = await seedGrader(
      world,
      aLatencyCopy({ name: "Both sources", scope: "both" }),
    );
    const testingOnly = await seedGrader(
      world,
      aLatencyCopy({ name: "Simulations only", scope: "simulations" }),
    );
    // Named by a test's grader array, which is a decision about one scenario. A
    // real caller is in nobody's scenario, so naming it there must not reach
    // production however loudly the array says so.
    const attached = await seedGrader(
      world,
      aLatencyCopy({ name: "This scenario only", scope: "simulations" }),
    );
    await seedTest(world, [attached]);

    const { traceId } = await conductProductionTrace(world);
    const verdicts = await verdictsOn(world, traceId, 2);
    const judged = new Set(verdicts.map((verdict) => verdict.graderId));

    expect(judged.has(monitoring)).toBe(true);
    expect(judged.has(both)).toBe(true);
    // Not skipped, not errored — absent. A grader scoped to simulations was
    // never about this conversation, so there is no row for it at all.
    expect(judged.has(testingOnly)).toBe(false);
    expect(judged.has(attached)).toBe(false);
    expect(judged.size).toBe(2);
  });

  it("is never judged by the expected-behaviors grader", async () => {
    // The project holds a test carrying an expected behavior — the thing that
    // grader judges — and this conversation is not that test being run. A
    // production trace has no test, so there is nothing to judge it against,
    // and a real caller measured against expectations somebody wrote for a
    // different conversation would be the worst kind of wrong: confident and
    // unfalsifiable.
    //
    // **The scope is what keeps it out**, and that is the shape the redesign
    // gives this: the copy every project is created with is scoped to
    // simulations, so a person can see the decision and change it, rather than
    // it living in a branch nobody can point at.
    await seedTest(world, []);

    const { traceId } = await conductProductionTrace(world);
    const verdicts = await verdictsOn(world, traceId);

    const seeded = await theSeededGrader(world);
    expect(verdicts.map((verdict) => verdict.graderId)).not.toContain(seeded);
    expect(
      verdicts.map((verdict) => verdict.assertion),
    ).not.toContain("behavior_1");
    // Every row here was written by a grader somebody created and scoped to
    // production. Nothing else may write one.
    const scoped = new Set(
      (await listGraders(world.auth)).items
        .filter(
          (grader) => grader.scope === "production" || grader.scope === "both",
        )
        .map((grader) => grader.id),
    );
    for (const verdict of verdicts) {
      expect(scoped.has(verdict.graderId)).toBe(true);
    }
  });

  it("lands verdict rows carrying source production and no run id", async () => {
    const graderId = await seedGrader(
      world,
      aLatencyCopy({ name: "Latency in the wild", scope: "production" }),
    );

    const { traceId } = await conductProductionTrace(world);
    const verdicts = await verdictsOn(world, traceId);
    const mine = verdicts.find((verdict) => verdict.graderId === graderId);

    expect(mine).toMatchObject({
      traceId,
      graderId,
      source: "production",
      // Empty, honestly: a trace that arrived at the OTLP door was not started
      // by egma, so there is no run and no agent row behind it.
      runId: "",
      agentId: "",
      agentVersionId: "",
    });
    expect(mine?.graderVersionId).toMatch(/^grv_/);
  });

  it("folds identically to a simulation's, over the same rows", async () => {
    const { traceId } = await conductProductionTrace(world);
    await verdictsOn(world, traceId);

    const read = await readVerdicts(world.auth, traceId);

    // The same fold, over rows that differ only in where the conversation came
    // from: nothing in the read path asks which source it was.
    expect(read.outcome.counts.total).toBe(read.verdicts.length);
    expect(read.byGrader.length).toBeGreaterThan(0);
    expect(["passed", "failed", "errored", "skipped"]).toContain(
      read.outcome.verdict,
    );
    for (const verdict of read.verdicts) {
      expect(verdict.source).toBe("production");
    }
  });

  it("is judged once, and a late export does not queue a second judgment", async () => {
    const { traceId } = await conductProductionTrace(world);
    await verdictsOn(world, traceId);

    const job = await jobFor(world, { traceId }, "graded");
    expect(job.finishedAt).toBeInstanceOf(Date);
    expect(job.rootClosedAt).toBeInstanceOf(Date);

    // A straggling flush of the same conversation, exactly as the door files
    // one — a root span and all. The job stays where it is: re-grading history
    // is something somebody asks for, never something a late export causes.
    await exportALateFlush(world, traceId);

    const claimed = await claimGradingJobs({
      claimant: "another-copy",
      capacity: 50,
    });
    expect(claimed.some((claim) => claim.traceId === traceId)).toBe(false);
    expect(
      (await getGradingJobForTrace(world.auth, traceId))?.status,
    ).toBe("graded");
  });

  /**
   * The read path itself, from real spans in a real store.
   *
   * Everything else in this file asserts verdict rows, which is the seam that
   * matters — but nothing egma executes on a production trace reads a
   * *transcript*, so no row can show whether the conversation the engine
   * assembled is the one the spans describe. This asserts it where it can be
   * seen: the store's own read, through the constructor, exactly as the engine
   * does it. The measures are the half a verdict row can speak for, and the
   * case below does that.
   */
  it("reads the conversation from its spans — the transcript and the tool calls", async () => {
    const { traceId, startedAt } = await conductProductionTrace(world, {
      said: [
        { speaker: "human", text: "Move my cleaning to Tuesday please." },
        { speaker: "agent", text: "Booked for Tuesday at four." },
      ],
      calledTool: "reschedule_appointment",
    });
    await jobFor(world, { traceId }, "graded");

    const trace = await readTrace(world.auth, traceId, {
      window: {
        from: BigInt(startedAt.getTime() - 60_000) * 1_000n,
        to: BigInt(startedAt.getTime() + 60_000) * 1_000n,
      },
    });
    if (trace === undefined) throw new Error("the trace store lost the trace");

    const conversation = conversationOfTrace(trace);

    expect(conversation.source).toBe("production");
    expect(conversation.traceId).toBe(traceId);
    // There is something here to judge: spans exist, so somebody talked to
    // something. `errored` is the answer to "did egma's own runtime manage to
    // conduct this", and a real caller's conversation was conducted by the
    // world.
    expect(conversation.nothingToJudgeBecause).toBeNull();
    // Nothing on the wire says why a real caller hung up, and a guess dressed
    // up as a reason would be worse than the absence.
    expect(conversation.endingReason).toBeNull();

    // The transcript, from the turn-grain spans, in the order they happened.
    expect(conversation.transcript).toMatchObject([
      { speaker: "human", text: "Move my cleaning to Tuesday please." },
      { speaker: "agent", text: "Booked for Tuesday at four." },
    ]);
    for (const turn of conversation.transcript as { ended_at: string }[]) {
      // To the microsecond, which is the precision the store keeps and a `Date`
      // cannot carry.
      expect(turn.ended_at).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:]{8}\.\d{6}Z$/);
    }

    // The tool call, read off the columns the door normalised it into rather
    // than parsed back out of a payload.
    expect(conversation.events).toMatchObject([
      {
        kind: "tool_call",
        name: "reschedule_appointment",
        arguments: '{"when": "Tuesday"}',
        result: '"booked"',
      },
    ]);

    // And no measures — not because this is production, but because these spans
    // carry none. The shared measure module is handed the trace and knows
    // nothing about who conducted it; most agents' telemetry emits no timings,
    // so most production traces measure nothing, and a grader asked for one
    // answers `skipped`, which leaves the score's denominator. A production
    // trace that *does* carry timing spans measures exactly what a simulation's
    // identical spans measure, which the case below is about.
    expect(conversation.measures).toEqual([]);

    // Empty, and honestly so: a trace that arrived at the OTLP door was not
    // started by egma, so there is no run and no agent row behind it.
    expect(conversation.runId).toBe("");
    expect(conversation.agentId).toBe("");
  });

  /**
   * **A reading the span limit cut short is judged by nobody**, exactly as a
   * simulation's is — and on this branch that stopped being a formality.
   *
   * A production conversation used to measure nothing at all, so a prefix could
   * not move a number and the missing refusal cost nothing. Now the worst
   * measurement is taken over whatever the reading returned, and the worst turn
   * of a long call is as likely to be past the cut as before it: a bound would
   * pass or fail on an arbitrary slice, and the verdict would say nothing about
   * the conversation while looking exactly like a verdict that did.
   *
   * The sentence is the one the simulation branch already used, because it is
   * the same fact about the same reader.
   */
  it("refuses to judge a reading the span limit cut short", async () => {
    const { traceId, startedAt } = await conductProductionTrace(world, {
      measured: { turn_response_latency: [900, 1_100] },
    });
    await jobFor(world, { traceId }, "graded");

    const trace = await readTrace(world.auth, traceId, {
      window: {
        from: BigInt(startedAt.getTime() - 60_000) * 1_000n,
        to: BigInt(startedAt.getTime() + 60_000) * 1_000n,
      },
    });
    if (trace === undefined) throw new Error("the trace store lost the spans");

    // Exactly what the trace read answers when a conversation overruns the
    // reader's limit: the same rows, the flag up.
    const whole = conversationOfTrace(trace);
    const prefix = conversationOfTrace({ ...trace, truncated: true });

    // Whole, it measures — which is what makes the refusal below a refusal
    // rather than a conversation that had nothing in it anyway.
    expect(whole.nothingToJudgeBecause).toBeNull();
    expect(whole.measures.map((one) => one.measure)).toEqual([
      "turn_response_latency",
    ]);

    expect(prefix.nothingToJudgeBecause).toContain("span limit");
    // And nothing is handed to a grader off a prefix — not a measure, not a
    // transcript. A number computed from part of a call is the quietly wrong
    // answer this whole module exists to prevent.
    expect(prefix.measures).toEqual([]);
    expect(prefix.transcript).toEqual([]);
    expect(prefix.events).toEqual([]);
  });

  /**
   * **One source, both worlds — asserted where a customer would feel it.**
   *
   * The same measurements are filed twice: once by egma's own simulator as a
   * conversation it conducted, and once at the OTLP door as a real caller's.
   * The latency copies come back with the same verdict and the same rationale,
   * because the number they were decided by came out of one module that never
   * learns which source it is reading.
   *
   * That is what makes "passes in simulation, fails in production" a fact about
   * the agent rather than about two readers. If the two paths could disagree,
   * the whole comparison the product is built on would be measuring egma.
   */
  it("measures a real caller's spans exactly as it measures a simulation's", async () => {
    const MEASURED = { turn_response_latency: [900, 1_100] };

    const watching = await seedGrader(
      world,
      aLatencyCopy({ name: "The same bound in the wild", scope: "production" }),
    );
    const testing = await seedGrader(
      world,
      aLatencyCopy({ name: "The same bound in a test", scope: "simulations" }),
    );

    const { traceId } = await conductProductionTrace(world, {
      measured: MEASURED,
    });
    const { simulationId } = await conductSimulation(world, {
      spans: { measured: MEASURED },
    });

    const inTheWild = (await verdictsOn(world, traceId, 1)).find(
      (verdict) => verdict.graderId === watching,
    );
    const inATest = (await verdictsOn(world, simulationId, 1)).find(
      (verdict) => verdict.graderId === testing,
    );

    // Two different conversations, conducted by two different things, filed
    // under two different sources.
    expect(inTheWild?.source).toBe("production");
    expect(inATest?.source).toBe("simulation");

    // And one answer, down to the sentence — which can only be true if one
    // piece of arithmetic produced both.
    expect(inTheWild?.verdict).toBe("passed");
    expect(inTheWild?.verdict).toBe(inATest?.verdict);
    expect(inTheWild?.score).toBe(inATest?.score);
    expect(inTheWild?.assertion).toBe(inATest?.assertion);
    expect(inTheWild?.rationale).toBe(inATest?.rationale);
    expect(inTheWild?.rationale).toContain("1100 milliseconds at its worst");
  });
});

describe("a production trace whose root span never closes", () => {
  it("is completed by the idle window, and still only judged once", async () => {
    const patient = runService(
      testConfig({
        claimant: "grader-watching-idle-traces",
        // A second of quiet is enough, and the pass that notices comes round
        // every second: this is the only path in the service where a
        // conversation waits on a clock, so the test has to let it.
        traceIdleSeconds: 1,
        sweepSeconds: 1,
      }),
    );

    try {
      await seedGrader(
        world,
        aLatencyCopy({ name: "Watching a broken exporter", scope: "production" }),
      );

      const { traceId } = await conductProductionTrace(world, {
        rootCloses: false,
      });

      // Nobody was woken — there was no ending to be woken by. The job is
      // waiting, unclaimable, until it has been quiet long enough.
      const waiting = await getGradingJobForTrace(world.auth, traceId);
      expect(waiting?.status).toBe("pending");
      expect(waiting?.rootClosedAt).toBeNull();

      const verdicts = await verdictsOn(world, traceId);
      expect(verdicts.length).toBeGreaterThan(0);
      expect(verdicts.every((verdict) => verdict.source === "production")).toBe(
        true,
      );

      const job = await jobFor(world, { traceId }, "graded");
      // Judged with no root ever closing it, and once: the unique on the trace
      // is what makes a second job unrepresentable rather than merely unwritten.
      expect(job.rootClosedAt).toBeNull();
      const again = await claimGradingJobs({
        claimant: "yet-another-copy",
        capacity: 50,
        idleSeconds: 1,
      });
      expect(again.some((claim) => claim.traceId === traceId)).toBe(false);
    } finally {
      patient.stop();
      await patient.finished;
    }
  });
});

describe("the production sample rate", () => {
  it("grades a quarter of the traces, deterministically — every fourth one", async () => {
    const sampled = await seedGrader(
      world,
      aLatencyCopy({
        name: "A quarter of production",
        scope: "production",
        productionSampleRate: 25,
      }),
    );

    const judged: boolean[] = [];
    for (let trace = 0; trace < 8; trace += 1) {
      const { traceId } = await conductProductionTrace(world);
      await jobFor(world, { traceId }, "graded");
      const read = await readVerdicts(world.auth, traceId);
      judged.push(read.verdicts.some((verdict) => verdict.graderId === sampled));
    }

    // Two of eight, and not two chosen at random: the accumulator crosses a
    // hundred on every fourth trace, so a customer who set 25% can point at
    // which calls were judged.
    expect(judged.filter(Boolean)).toHaveLength(2);
    expect(judged).toEqual([
      false,
      false,
      false,
      true,
      false,
      false,
      false,
      true,
    ]);
  });

  it("leaves no verdict row at all on a trace it skipped — not a skipped one", async () => {
    const never = await seedGrader(
      world,
      aLatencyCopy({
        name: "Never sampled",
        scope: "production",
        productionSampleRate: 0,
      }),
    );

    const { traceId } = await conductProductionTrace(world);
    await jobFor(world, { traceId }, "graded");

    const read = await readVerdicts(world.auth, traceId);
    // Other graders did judge this trace, so the rows are certainly readable.
    expect(read.verdicts.length).toBeGreaterThan(0);
    // And this grader's are absent, which is the whole distinction: `skipped`
    // would mean "this check did not apply to this conversation", and it applied
    // perfectly well — nobody chose to spend a judgment on this call.
    expect(read.verdicts.some((verdict) => verdict.graderId === never)).toBe(
      false,
    );
  });

  it("never applies to a simulation, whatever the rate says", async () => {
    const graderId = await seedGrader(
      world,
      aLatencyCopy({
        name: "Sampled, and judging every simulation",
        scope: "both",
        productionSampleRate: 1,
      }),
    );

    for (let conversation = 0; conversation < 3; conversation += 1) {
      const { simulationId } = await conductSimulation(world);
      await eventually(`a verdict from ${graderId}`, async () => {
        const read = await readVerdicts(world.auth, simulationId);
        return read.verdicts.some((verdict) => verdict.graderId === graderId)
          ? read
          : undefined;
      });
    }
  });
});

describe("changing where a grader applies", () => {
  it("takes effect forward only — no back-grading, and nothing deleted", async () => {
    const graderId = await seedGrader(
      world,
      aLatencyCopy({ name: "Pointed at production later", scope: "simulations" }),
    );

    const before = await conductProductionTrace(world);
    await jobFor(world, { traceId: before.traceId }, "graded");
    const untouched = await readVerdicts(world.auth, before.traceId);
    expect(
      untouched.verdicts.some((verdict) => verdict.graderId === graderId),
    ).toBe(false);

    await editGrader(world.auth, graderId, { scope: "production" });

    const after = await conductProductionTrace(world);
    await eventually(`${graderId} to judge the next trace`, async () => {
      const read = await readVerdicts(world.auth, after.traceId);
      return read.verdicts.some((verdict) => verdict.graderId === graderId)
        ? read
        : undefined;
    });

    // The trace from before the change is exactly as it was: no verdict
    // appeared on it, and nothing that was there was taken away.
    const still = await readVerdicts(world.auth, before.traceId);
    expect(
      still.verdicts.some((verdict) => verdict.graderId === graderId),
    ).toBe(false);
    expect(still.verdicts).toHaveLength(untouched.verdicts.length);
  });

  it("stops judging from the moment it is narrowed, and keeps what it said", async () => {
    const graderId = await seedGrader(
      world,
      aLatencyCopy({ name: "Pointed away from production", scope: "production" }),
    );

    const before = await conductProductionTrace(world);
    await eventually(`${graderId} to judge a trace`, async () => {
      const read = await readVerdicts(world.auth, before.traceId);
      return read.verdicts.some((verdict) => verdict.graderId === graderId)
        ? read
        : undefined;
    });

    await editGrader(world.auth, graderId, { scope: "simulations" });

    const after = await conductProductionTrace(world);
    await jobFor(world, { traceId: after.traceId }, "graded");

    expect(
      (await readVerdicts(world.auth, after.traceId)).verdicts.some(
        (verdict) => verdict.graderId === graderId,
      ),
    ).toBe(false);
    // And the judgment it already made is still there, unedited.
    expect(
      (await readVerdicts(world.auth, before.traceId)).verdicts.some(
        (verdict) => verdict.graderId === graderId,
      ),
    ).toBe(true);
  });
});
