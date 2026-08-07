import {
  claimGradingJobs,
  editGrader,
  getGradingJobForTrace,
  listGraders,
  readTrace,
  readVerdicts,
  type RecordedVerdict,
} from "@egma/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { conversationOfTrace } from "../src/conversation.ts";
import {
  aThreshold,
  conductProductionTrace,
  conductSimulation,
  eventually,
  exportALateFlush,
  makeWorld,
  runService,
  seedGrader,
  seedTest,
  testConfig,
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

async function verdictsOn(
  traceId: string,
  atLeast = 1,
): Promise<readonly RecordedVerdict[]> {
  return eventually(`verdicts on ${traceId}`, async () => {
    const read = await readVerdicts(world.auth, traceId);
    return read.verdicts.length >= atLeast ? read.verdicts : undefined;
  });
}

/** The job behind a trace, once it has reached a state worth asserting on. */
async function jobFor(traceId: string, status: string) {
  return eventually(`the job for ${traceId} to be ${status}`, async () => {
    const job = await getGradingJobForTrace(world.auth, traceId);
    return job?.status === status ? job : undefined;
  });
}

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
      aThreshold({ name: "Production only", scope: "production" }),
    );
    const both = await seedGrader(
      world,
      aThreshold({ name: "Both sources", scope: "both" }),
    );
    const testingOnly = await seedGrader(
      world,
      aThreshold({ name: "Simulations only", scope: "simulations" }),
    );
    // Named by a test's grader array, which is a decision about one scenario. A
    // real caller is in nobody's scenario, so naming it there must not reach
    // production however loudly the array says so.
    const attached = await seedGrader(
      world,
      aThreshold({ name: "This scenario only", scope: "simulations" }),
    );
    await seedTest(world, [attached]);

    const { traceId } = await conductProductionTrace(world);
    const verdicts = await verdictsOn(traceId, 2);
    const judged = new Set(verdicts.map((verdict) => verdict.graderId));

    expect(judged.has(monitoring)).toBe(true);
    expect(judged.has(both)).toBe(true);
    // Not skipped, not errored — absent. A grader scoped to simulations was
    // never about this conversation, so there is no row for it at all.
    expect(judged.has(testingOnly)).toBe(false);
    expect(judged.has(attached)).toBe(false);
    expect(judged.size).toBe(2);
  });

  it("is never judged by the built-in expected_behaviors grader", async () => {
    // The project holds a test carrying an expected behavior — the thing the
    // built-in judges — and this conversation is not that test being run. A
    // production trace has no test, so there is nothing for the built-in to
    // judge it against, and a real caller measured against expectations
    // somebody wrote for a different conversation would be the worst kind of
    // wrong: confident and unfalsifiable.
    await seedTest(world, []);

    const { traceId } = await conductProductionTrace(world);
    const verdicts = await verdictsOn(traceId);

    expect(
      verdicts.map((verdict) => verdict.dimension),
    ).not.toContain("expected_behaviors");
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
      aThreshold({ name: "Latency in the wild", scope: "production", priority: "P1" }),
    );

    const { traceId } = await conductProductionTrace(world);
    const verdicts = await verdictsOn(traceId);
    const mine = verdicts.find((verdict) => verdict.graderId === graderId);

    expect(mine).toMatchObject({
      traceId,
      graderId,
      source: "production",
      judgedBy: "engine",
      priority: "P1",
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
    await verdictsOn(traceId);

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
    await verdictsOn(traceId);

    const job = await jobFor(traceId, "graded");
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
   * matters — but no grader type egma executes today reads a transcript, so no
   * row can show whether the conversation the engine assembled is the one the
   * spans describe. This asserts it where it can be seen: the store's own read,
   * through the constructor, exactly as the engine does it.
   */
  it("reads the conversation from its spans — the transcript and the tool calls", async () => {
    const { traceId, startedAt } = await conductProductionTrace(world, {
      said: [
        { speaker: "human", text: "Move my cleaning to Tuesday please." },
        { speaker: "agent", text: "Booked for Tuesday at four." },
      ],
      calledTool: "reschedule_appointment",
    });
    await jobFor(traceId, "graded");

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
    // It happened: spans exist, so somebody talked to something. `errored` is
    // the answer to "did egma's own runtime manage to conduct this", and a real
    // caller's conversation was conducted by the world.
    expect(conversation.happened).toBe(true);
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

    // And no measures, honestly. What a threshold grader names is the
    // simulator's own measurement of a conversation it conducted; a production
    // trace is the agent's telemetry from the inside, and the two are different
    // measurements. A grader asked for one it does not have answers `skipped`,
    // which leaves the score's denominator.
    expect(conversation.metrics).toEqual({});

    // Empty, and honestly so: a trace that arrived at the OTLP door was not
    // started by egma, so there is no run and no agent row behind it.
    expect(conversation.runId).toBe("");
    expect(conversation.agentId).toBe("");
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
        aThreshold({ name: "Watching a broken exporter", scope: "production" }),
      );

      const { traceId } = await conductProductionTrace(world, {
        rootCloses: false,
      });

      // Nobody was woken — there was no ending to be woken by. The job is
      // waiting, unclaimable, until it has been quiet long enough.
      const waiting = await getGradingJobForTrace(world.auth, traceId);
      expect(waiting?.status).toBe("pending");
      expect(waiting?.rootClosedAt).toBeNull();

      const verdicts = await verdictsOn(traceId);
      expect(verdicts.length).toBeGreaterThan(0);
      expect(verdicts.every((verdict) => verdict.source === "production")).toBe(
        true,
      );

      const job = await jobFor(traceId, "graded");
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
      aThreshold({
        name: "A quarter of production",
        scope: "production",
        productionSampleRate: 25,
      }),
    );

    const judged: boolean[] = [];
    for (let trace = 0; trace < 8; trace += 1) {
      const { traceId } = await conductProductionTrace(world);
      await jobFor(traceId, "graded");
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
      aThreshold({
        name: "Never sampled",
        scope: "production",
        productionSampleRate: 0,
      }),
    );

    const { traceId } = await conductProductionTrace(world);
    await jobFor(traceId, "graded");

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
      aThreshold({
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
      aThreshold({ name: "Pointed at production later", scope: "simulations" }),
    );

    const before = await conductProductionTrace(world);
    await jobFor(before.traceId, "graded");
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
      aThreshold({ name: "Pointed away from production", scope: "production" }),
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
    await jobFor(after.traceId, "graded");

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
