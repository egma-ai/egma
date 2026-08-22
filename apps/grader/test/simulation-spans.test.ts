import {
  getSimulation,
  listGradingJobsForSimulation,
  MOST_GRADING_ATTEMPTS,
  readTrace,
  readVerdicts,
} from "@egma/db";
import { traceIdOfSimulation } from "@egma/simulation-contract";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { conversationOfSimulation } from "../src/conversation.ts";
import {
  aLatencyCopy,
  conductSimulation,
  eventually,
  jobFor,
  streamConversationLate,
  makeWorld,
  oneServiceAtATime,
  seedGrader,
  seedTest,
  theSeededGrader,
  type World,
} from "./support/world.ts";
import { met, type ScriptedJudge } from "./support/scripted-judge.ts";

/**
 * A simulation read the way a production trace is read: from its spans.
 *
 * **The seam is the verdict rows, and the assertions are on them.** What a
 * conversation was assembled out of is not something a grader knows, so every
 * case here conducts a conversation, lets the real service judge it, and reads
 * back what it said.
 *
 * **The judge is scripted, and what it was *shown* is the other half of the
 * evidence.** A verdict row carries the turns a judgment rests on and nothing
 * about the transcript behind them, so the cases that are about assembly look
 * at the question the engine put — which is the one place the conversation egma
 * built out of spans is visible in full. One case reaches further still, to the
 * constructor itself, for the same reason the production suite does.
 *
 * **Nothing here is about the wire.** The spans are filed through the same
 * data-access call the ingest door files them through; the OTLP body, the
 * service token and the resource attribute naming the simulation are the API's
 * own tests, and repeating them would test Fastify rather than grading.
 */

let world: World;
const service = oneServiceAtATime();

/** The behavior every test in this file writes down, and the judge answers. */
const THE_BEHAVIOR = "confirms the new time back before finishing";

beforeAll(async () => {
  world = await makeWorld("grader_simulation_spans");
});

/**
 * The service, judging with one scripted answer — and the judge handed back, so
 * a case can see the conversation the engine assembled out of spans and put in
 * front of it.
 */
async function judgingWith(
  citedTurns: readonly number[] = [],
): Promise<ScriptedJudge> {
  return service.judgingWith({
    [THE_BEHAVIOR]: met("the agent read the new time back.", citedTurns),
  });
}

afterAll(async () => {
  await service.stop();
  await world.drop();
});

/** The conversation every case in this file conducts, said once. */
const A_CONVERSATION = [
  { speaker: "human" as const, text: "Can you move my cleaning to Tuesday?" },
  { speaker: "agent" as const, text: "Let me look at the diary." },
  { speaker: "human" as const, text: "Any afternoon works." },
  { speaker: "agent" as const, text: "Booked for Tuesday at four." },
];

describe("a simulation whose spans arrived complete", () => {
  it("is graded end to end, its verdicts citing turns assembled from spans", async () => {
    const judge = await judgingWith([4]);
    const testId = await seedTest(world, [THE_BEHAVIOR]);

    const conducted = await conductSimulation(world, {
      testId,
      spans: {
        said: A_CONVERSATION,
        calledTool: {
          name: "reschedule_appointment",
          arguments: '{"when":"Tuesday"}',
        },
        measured: { turn_response_latency: [900, 1_100] },
      },
    });
    await jobFor(world, conducted, "graded");

    // The conversation exists as spans and nowhere else — the row has no
    // field left that could hold one — so nothing below can have come from
    // anywhere but the trace store. That the columns are gone from the table
    // itself is asserted where the schema is, in the API's own black-box walk.
    const { verdicts } = await readVerdicts(world.auth, conducted.simulationId);
    const seeded = await theSeededGrader(world);
    const mine = verdicts.find((verdict) => verdict.graderId === seeded);

    // The transcript: judged, and cited at the turn the answer rests on —
    // which is the fourth thing said, counted through the span-assembled
    // transcript.
    expect(mine).toMatchObject({ verdict: "passed" });
    expect(mine?.citedSpanIds).toEqual(["turn:4"]);

    // And what the judge was shown, which is the conversation egma built: the
    // turns, the tool call read off the columns the door normalised it into,
    // and the measures off the timing spans.
    const [shown] = judge.asked;
    expect(shown?.evidence.transcript).toHaveLength(A_CONVERSATION.length);
    expect(shown?.evidence.toolCalls).toMatchObject([
      { tool: "reschedule_appointment" },
    ]);
    expect(shown?.evidence.measures).toEqual([
      { measure: "turn_response_latency", samples: [900, 1_100] },
    ]);
  });

  it("files its verdicts under the simulation id, exactly as before", async () => {
    await judgingWith();
    const testId = await seedTest(world, [THE_BEHAVIOR]);

    const conducted = await conductSimulation(world, {
      testId,
      spans: { said: A_CONVERSATION },
    });
    await jobFor(world, conducted, "graded");

    const { verdicts } = await readVerdicts(world.auth, conducted.simulationId);
    const seeded = await theSeededGrader(world);
    const mine = verdicts.find((verdict) => verdict.graderId === seeded);

    // The trace id on a verdict row is the product's word for this
    // conversation, and it did not move: the derived hex names where the spans
    // are filed and nothing else.
    expect(mine).toMatchObject({
      traceId: conducted.simulationId,
      source: "simulation",
      runId: conducted.runId,
      agentId: world.agentId,
    });
    expect(conducted.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(conducted.traceId).not.toBe(conducted.simulationId);
  });

  it("reads the conversation from its spans — the transcript, the tools and the measures", async () => {
    await judgingWith();
    const conducted = await conductSimulation(world, {
      spans: {
        said: A_CONVERSATION,
        calledTool: {
          name: "reschedule_appointment",
          arguments: '{"when":"Tuesday"}',
        },
        measured: {
          first_response_latency: [1_214],
          turn_response_latency: [862.5, 1_100],
        },
      },
    });
    await jobFor(world, conducted, "graded");

    const simulation = await getSimulation(world.auth, conducted.simulationId);
    if (simulation === undefined) throw new Error("the row went missing");

    const traceId = traceIdOfSimulation(simulation.id);
    const trace = await readTrace(world.auth, traceId as string, {
      window: {
        from: BigInt(Date.now() - 600_000) * 1_000n,
        to: BigInt(Date.now() + 600_000) * 1_000n,
      },
    });
    if (trace === undefined) throw new Error("the trace store lost the spans");

    const conversation = conversationOfSimulation(simulation, trace);

    expect(conversation.source).toBe("simulation");
    expect(conversation.traceId).toBe(simulation.id);
    expect(conversation.nothingToJudgeBecause).toBeNull();
    // The simulator's own word for how it ended, which only the row knows.
    expect(conversation.endingReason).toBe("persona_concluded");

    // The transcript, in the order it happened, with the speaker off the kind.
    expect(conversation.transcript).toMatchObject(
      A_CONVERSATION.map((turn) => ({ speaker: turn.speaker, text: turn.text })),
    );

    // The tool call, with no result — always, because the simulator observes
    // the call from egma's side of the connection and not the return.
    expect(conversation.events).toMatchObject([
      {
        kind: "tool_call",
        name: "reschedule_appointment",
        arguments: '{"when":"Tuesday"}',
        result: "",
      },
    ]);

    // The measures, in milliseconds, each one a timing span's own duration —
    // including the half a millisecond, which a whole-number division would
    // have floored away. They are the shared measure module's answer, which is
    // the same answer the metrics display shows for this conversation and the
    // same one a latency grader is judged on.
    expect(
      conversation.measures.map((one) => ({
        measure: one.measure,
        unit: one.unit,
        samples: one.samples.map((sample) => sample.value),
      })),
    ).toEqual([
      {
        measure: "first_response_latency",
        unit: "milliseconds",
        samples: [1_214],
      },
      {
        measure: "turn_response_latency",
        unit: "milliseconds",
        samples: [862.5, 1_100],
      },
    ]);
  });

  it("cites every turn a judgment rests on, in the order the answer gave them", async () => {
    // Two turns in one answer, so what is proved is the order of the citations
    // rather than there being one.
    await judgingWith([2, 4]);
    const testId = await seedTest(world, [THE_BEHAVIOR]);

    const conducted = await conductSimulation(world, {
      testId,
      spans: { said: A_CONVERSATION },
    });
    await jobFor(world, conducted, "graded");

    const { verdicts } = await readVerdicts(world.auth, conducted.simulationId);
    const seeded = await theSeededGrader(world);
    const mine = verdicts.find((verdict) => verdict.graderId === seeded);

    // The second thing said and the fourth, counted through the span-assembled
    // transcript and cited in that order.
    expect(mine?.verdict).toBe("passed");
    expect(mine?.citedSpanIds).toEqual(["turn:2", "turn:4"]);
  });

  it("keeps two turns that cross in time, in the order they began", async () => {
    await judgingWith();
    // What barge-in looks like: the persona starts answering before the agent
    // has stopped talking. The transcript has to hold both — a reader that
    // assumed turns take it in strict succession would drop one of them, or
    // reorder the pair, and the record would say the conversation went
    // differently than it did.
    const conducted = await conductSimulation(world, {
      spans: {
        said: [
          {
            speaker: "agent",
            text: "So that is Tuesday at four, and I will send you a text to—",
            atMilliseconds: 0,
            spokeForMilliseconds: 4_000,
          },
          {
            speaker: "human",
            text: "Sorry, make it Wednesday.",
            atMilliseconds: 3_000,
            spokeForMilliseconds: 1_500,
          },
        ],
      },
    });
    await jobFor(world, conducted, "graded");

    const simulation = await getSimulation(world.auth, conducted.simulationId);
    if (simulation === undefined) throw new Error("the row went missing");
    const trace = await readTrace(
      world.auth,
      traceIdOfSimulation(simulation.id) as string,
      {
        window: {
          from: BigInt(Date.now() - 600_000) * 1_000n,
          to: BigInt(Date.now() + 600_000) * 1_000n,
        },
      },
    );
    if (trace === undefined) throw new Error("the trace store lost the spans");

    const turns = conversationOfSimulation(simulation, trace).transcript as {
      speaker: string;
      started_at: string;
      ended_at: string;
    }[];

    expect(turns.map((turn) => turn.speaker)).toEqual(["agent", "human"]);
    // And they genuinely cross: the second began before the first had ended.
    // Compared as the store's own fixed-width instants, which sort exactly as
    // the moments do.
    const [agentTurn, humanTurn] = turns;
    expect(
      (humanTurn?.started_at ?? "") < (agentTurn?.ended_at ?? ""),
    ).toBe(true);
  });
});

/**
 * What the simulator measured, as it reaches something that judges.
 *
 * A measure is a number a grader may read, and the only place it is visible
 * from outside the engine is the evidence a judge is shown. What egma computes
 * *from* those numbers is the shared measure module's story and lands with the
 * grader that reads them.
 */
describe("what the simulator measured", () => {
  it("is the timing span's own duration, and never a value beside it", async () => {
    const judge = await judgingWith();
    const testId = await seedTest(world, [THE_BEHAVIOR]);

    const conducted = await conductSimulation(world, {
      testId,
      spans: { said: A_CONVERSATION, measured: { first_response_latency: [1_214] } },
    });
    await jobFor(world, conducted, "graded");

    // The number the span's start and end bracket, read back to the
    // millisecond — nothing on the span carries it a second time.
    //
    // **Precedence is per measure, and this list is exact so that stays true.**
    // The timed measure keeps the timing span's own duration and is never
    // derived beside it; the measure this conversation timed nothing for is
    // worked out from its turns, and is named here rather than allowed to arrive
    // unremarked. The day a derivation appends to `first_response_latency`
    // instead of standing aside, this assertion is what says so.
    //
    // The derived pair is hand-computed from the conversation's own shape: four
    // turns 2000 ms apart, each a single instant on a chat simulation, so each
    // of the two human turns is answered 2000 ms later.
    expect(judge.asked[0]?.evidence.measures).toEqual([
      { measure: "first_response_latency", samples: [1_214] },
      { measure: "turn_response_latency", samples: [2_000, 2_000] },
    ]);
  });

  it("leaves a voice measure absent on a chat simulation rather than inventing one", async () => {
    const judge = await judgingWith();
    const testId = await seedTest(world, [THE_BEHAVIOR]);

    const conducted = await conductSimulation(world, {
      testId,
      spans: { said: A_CONVERSATION, measured: { turn_response_latency: [900] } },
    });
    await jobFor(world, conducted, "graded");

    // A chat conversation has no audio, so it measured no speech — and what
    // reaches a judge says so by being absent rather than by carrying a zero,
    // which a reader would take for a measurement.
    const measures = judge.asked[0]?.evidence.measures ?? [];
    expect(measures.map((one) => one.measure)).toEqual([
      "turn_response_latency",
    ]);
  });
});

describe("a simulation whose trace never closed", () => {
  it("is errored for every grader — a partial record judges nobody", async () => {
    const judge = await judgingWith();
    const graderId = await seedGrader(
      world,
      aLatencyCopy({ name: "Asked about a conversation Egma holds half of" }),
    );
    const testId = await seedTest(world, [THE_BEHAVIOR]);

    const conducted = await conductSimulation(world, {
      testId,
      spans: { rootCloses: false, said: A_CONVERSATION },
    });
    await jobFor(world, conducted, "graded");

    const { verdicts } = await readVerdicts(world.auth, conducted.simulationId);
    const mine = verdicts.find((verdict) => verdict.graderId === graderId);

    // Never `failed`. What egma holds is genuinely half a conversation, and an
    // agent that behaved perfectly would be marked down for a flush that never
    // landed.
    expect(mine?.verdict).toBe("errored");
    expect(mine?.rationale).toContain("only part of this conversation");
    expect(verdicts.every((verdict) => verdict.verdict === "errored")).toBe(true);
    // And no judge was asked anything: there was nothing to ask about.
    expect(judge.asked).toEqual([]);
  });

  it("refuses to judge a reading the span limit cut short, root or no root", async () => {
    await judgingWith();
    const conducted = await conductSimulation(world, {
      spans: { said: A_CONVERSATION },
    });
    await jobFor(world, conducted, "graded");

    const simulation = await getSimulation(world.auth, conducted.simulationId);
    if (simulation === undefined) throw new Error("the row went missing");
    const trace = await readTrace(
      world.auth,
      traceIdOfSimulation(simulation.id) as string,
      {
        window: {
          from: BigInt(Date.now() - 600_000) * 1_000n,
          to: BigInt(Date.now() + 600_000) * 1_000n,
        },
      },
    );
    if (trace === undefined) throw new Error("the trace store lost the spans");

    // Exactly what the trace read answers when a conversation overruns the
    // reader's span limit: the same rows, the flag up. The root is present,
    // so completeness is not the question — wholeness of the reading is, and
    // judging the readable part would judge a different conversation.
    const conversation = conversationOfSimulation(simulation, {
      ...trace,
      truncated: true,
    });

    expect(conversation.nothingToJudgeBecause).toContain("span limit");
    expect(conversation.transcript).toEqual([]);
  });
});

/**
 * **Evidence accepted and not yet readable is a reason to ask again, never a
 * reason to answer.**
 *
 * A simulation's span batches are answered at the door when they are durable in
 * the object store, and the transaction that lands the simulation terminal is
 * what mints the work to judge it — so the work can be taken up before the
 * evidence behind it has been drained into the trace store. A verdict written
 * then would be permanent, and it would say egma could not read a conversation
 * it was in the middle of storing.
 */
describe("a simulation whose evidence is still on its way", () => {
  it("is asked again rather than judged, and judges the conversation once it lands", async () => {
    const judge = await judgingWith([3]);
    const testId = await seedTest(world, [THE_BEHAVIOR]);

    // Landed terminal with nothing under it yet.
    const conducted = await conductSimulation(world, { spans: null, testId });

    // The claim is declined and the job goes back with an attempt spent and a
    // sentence saying why. Nothing is written about the conversation.
    const released = await eventually(
      `the job for ${conducted.simulationId} to be handed back`,
      async () => {
        const [job] = await listGradingJobsForSimulation(
          world.auth,
          conducted.simulationId,
        );
        return job?.status === "pending" && job.attempts > 0 ? job : undefined;
      },
    );
    expect(released.lastError).toContain(
      "does not hold all of its conversation yet",
    );
    expect(
      (await readVerdicts(world.auth, conducted.simulationId)).verdicts,
    ).toEqual([]);
    expect(judge.asked).toEqual([]);

    // The drain finishes, and the next attempt judges what is now there.
    await streamConversationLate(world, conducted.simulationId);
    await jobFor(world, conducted, "graded");

    const { verdicts } = await readVerdicts(world.auth, conducted.simulationId);
    expect(verdicts.length).toBeGreaterThan(0);
    expect(verdicts.every((verdict) => verdict.verdict === "passed")).toBe(true);
    expect(judge.asked.length).toBeGreaterThan(0);
  });

  /**
   * And the budget is what ends the waiting. A conversation whose evidence
   * never arrives is answered on the last attempt out of what did — the same
   * list of checks a reader would have seen either way — rather than left
   * waiting or abandoned with nothing under it.
   */
  it("answers out of what arrived once the budget is spent", async () => {
    await judgingWith();
    const testId = await seedTest(world, [THE_BEHAVIOR]);
    const conducted = await conductSimulation(world, { spans: null, testId });

    const judged = await jobFor(world, conducted, "graded");
    expect(judged.attempts).toBe(MOST_GRADING_ATTEMPTS);

    const { verdicts } = await readVerdicts(world.auth, conducted.simulationId);
    expect(verdicts.length).toBeGreaterThan(0);
    expect(verdicts.every((verdict) => verdict.verdict === "errored")).toBe(true);
    expect(verdicts[0]?.rationale).toContain("no record of this conversation");
  });
});

describe("a simulation with no spans at all", () => {
  it("is errored for every grader, and for every expected behavior", async () => {
    await judgingWith();
    const graderId = await seedGrader(
      world,
      aLatencyCopy({ name: "Asked about a conversation Egma has no record of" }),
    );
    const testId = await seedTest(world, [
      "confirms the new time back before finishing",
      "never quotes a price",
    ]);

    // Nothing streamed: a completed conversation whose evidence never
    // reached egma at all, which is the only way a conversation can be
    // missing now that the spans are the whole of the record.
    const conducted = await conductSimulation(world, {
      spans: null,
      testId,
    });
    await jobFor(world, conducted, "graded");

    const { verdicts } = await readVerdicts(world.auth, conducted.simulationId);

    expect(verdicts.length).toBeGreaterThan(0);
    expect(verdicts.every((verdict) => verdict.verdict === "errored")).toBe(true);
    expect(
      verdicts.find((verdict) => verdict.graderId === graderId)?.rationale,
    ).toContain("no record of this conversation");

    // The expected-behaviors copy says the same thing, once per behavior, so a
    // page shows the same list of checks whether egma could read the
    // conversation or not.
    const seeded = await theSeededGrader(world);
    const behaviors = verdicts.filter(
      (verdict) => verdict.graderId === seeded,
    );
    expect(behaviors).toHaveLength(2);
    for (const behavior of behaviors) {
      expect(behavior.verdict).toBe("errored");
      expect(behavior.rationale).toContain("no record of this conversation");
    }
  });
});
