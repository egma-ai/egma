import { getSimulation, readTrace, readVerdicts } from "@egma/db";
import { traceIdOfSimulation } from "@egma/simulation-contract";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { conversationOfSimulation } from "../src/conversation.ts";
import {
  aThreshold,
  conductSimulation,
  jobFor,
  makeWorld,
  oneServiceAtATime,
  seedGrader,
  seedTest,
  type World,
} from "./support/world.ts";
import type { NewGrader } from "@egma/db";

/**
 * A simulation read the way a production trace is read: from its spans.
 *
 * **The seam is the verdict rows, and the assertions are on them.** What a
 * conversation was assembled out of is not something a grader knows, so every
 * case here conducts a conversation, lets the real service judge it, and reads
 * back what it said. One case reaches through to the constructor, for the same
 * reason the production suite does: no grader type egma executes prints a
 * transcript, so nothing in a verdict row can show that the turns are the ones
 * the spans describe.
 *
 * **Nothing here is about the wire.** The spans are filed through the same
 * data-access call the ingest door files them through; the OTLP body, the
 * service token and the resource attribute naming the simulation are the API's
 * own tests, and repeating them would test Fastify rather than grading.
 */

let world: World;
const service = oneServiceAtATime();

beforeAll(async () => {
  world = await makeWorld("grader_simulation_spans");
});

afterAll(async () => {
  await service.stop();
  await world.drop();
});

/** A phrase the agent has to have said: the one deterministic type that cites turns. */
function aPhrase(overrides: Partial<NewGrader> = {}): NewGrader {
  return {
    name: "Reads the new time back",
    type: "phrase_match",
    config: {
      required: [{ text: "Tuesday at four", match: "contains" }],
      banned: [],
      speaker: "agent",
    },
    ...overrides,
  } as NewGrader;
}

/** A tool that has to have fired, judged from what egma observed and not said. */
function aTool(overrides: Partial<NewGrader> = {}): NewGrader {
  return {
    name: "Actually reschedules",
    type: "tool_calls",
    config: {
      required: [{ tool: "reschedule_appointment", arguments: null }],
      forbidden: [],
    },
    ...overrides,
  } as NewGrader;
}

/** The conversation every case in this file conducts, said once. */
const A_CONVERSATION = [
  { speaker: "human" as const, text: "Can you move my cleaning to Tuesday?" },
  { speaker: "agent" as const, text: "Let me look at the diary." },
  { speaker: "human" as const, text: "Any afternoon works." },
  { speaker: "agent" as const, text: "Booked for Tuesday at four." },
];

/** The same conversation as the columns hold one, for the path being retired. */
const A_CONVERSATION_IN_COLUMNS = A_CONVERSATION.map((turn) => ({
  kind: "turn",
  speaker: turn.speaker,
  text: turn.text,
}));

describe("a simulation whose spans arrived complete", () => {
  beforeAll(async () => {
    await service.start();
  });

  it("is graded end to end, its verdicts citing turns assembled from spans", async () => {
    const phrase = await seedGrader(world, aPhrase());
    const tool = await seedGrader(world, aTool());
    const latency = await seedGrader(
      world,
      aThreshold({ name: "Answers inside two seconds from spans" }),
    );

    const conducted = await conductSimulation(world, {
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

    // Nothing on the row, so nothing a verdict says can have come from it. This
    // is the whole point of the case: the conversation exists only as spans.
    const row = await getSimulation(world.auth, conducted.simulationId);
    expect(row?.transcript).toBeNull();
    expect(row?.events).toBeNull();
    expect(row?.metrics).toBeNull();

    const { verdicts } = await readVerdicts(world.auth, conducted.simulationId);
    const by = (graderId: string) =>
      verdicts.find((verdict) => verdict.graderId === graderId);

    // The transcript: found, and cited at the turn it was found in — which is
    // the fourth thing said, counted through the span-assembled transcript.
    expect(by(phrase)).toMatchObject({ verdict: "passed" });
    expect(by(phrase)?.citedSpanIds).toEqual(["turn:4"]);
    // The tool calls, read off the columns the door normalised them into.
    expect(by(tool)).toMatchObject({ verdict: "passed" });
    // And the measures, off the timing spans.
    expect(by(latency)).toMatchObject({ verdict: "passed" });
  });

  it("files its verdicts under the simulation id, exactly as before", async () => {
    const graderId = await seedGrader(
      world,
      aPhrase({ name: "Filed under the simulation" }),
    );

    const conducted = await conductSimulation(world, {
      spans: { said: A_CONVERSATION },
    });
    await jobFor(world, conducted, "graded");

    const { verdicts } = await readVerdicts(world.auth, conducted.simulationId);
    const mine = verdicts.find((verdict) => verdict.graderId === graderId);

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
    // have floored away.
    expect(conversation.metrics).toEqual({
      first_response_latency: [1_214],
      turn_response_latency: [862.5, 1_100],
    });
  });

  it("keeps two turns that cross in time, in the order they began", async () => {
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

describe("one conversation graded through each path", () => {
  beforeAll(async () => {
    await service.start();
  });

  it("cites the same turns, in the same order, whichever it was read from", async () => {
    const graderId = await seedGrader(
      world,
      aPhrase({
        name: "Compared across both paths",
        // Two phrases in two different turns, so the comparison is about the
        // order of the citations rather than about there being one.
        config: {
          required: [
            { text: "Tuesday at four", match: "contains" },
            { text: "the diary", match: "contains" },
          ],
          banned: [],
          speaker: "agent",
        },
      } as Partial<NewGrader>),
    );

    const fromSpans = await conductSimulation(world, {
      spans: { said: A_CONVERSATION },
    });
    const fromColumns = await conductSimulation(world, {
      transcript: A_CONVERSATION_IN_COLUMNS,
    });
    await jobFor(world, fromSpans, "graded");
    await jobFor(world, fromColumns, "graded");

    const judgedIn = async (simulationId: string) => {
      const { verdicts } = await readVerdicts(world.auth, simulationId);
      const mine = verdicts.find((verdict) => verdict.graderId === graderId);
      return {
        verdict: mine?.verdict,
        rationale: mine?.rationale,
        citedSpanIds: mine?.citedSpanIds,
      };
    };

    const spans = await judgedIn(fromSpans.simulationId);
    const columns = await judgedIn(fromColumns.simulationId);

    // The same answer, about the same turns, in the same order. Written as one
    // comparison rather than two assertions against a constant, because what is
    // being proved is that the two paths agree — not that either says something
    // somebody typed out here.
    expect(spans).toEqual(columns);
    expect(spans.verdict).toBe("passed");
    expect(spans.citedSpanIds).toEqual(["turn:2", "turn:4"]);
  });
});

describe("what the simulator measured", () => {
  beforeAll(async () => {
    await service.start();
  });

  it("is the timing span's own duration, and never a value beside it", async () => {
    const graderId = await seedGrader(
      world,
      aThreshold({
        name: "The first answer inside a second and a half",
        config: {
          measure: "first_response_latency",
          aggregation: "max",
          comparator: "below",
          threshold: 1_500,
        },
      } as Partial<NewGrader>),
    );

    const conducted = await conductSimulation(world, {
      spans: { said: A_CONVERSATION, measured: { first_response_latency: [1_214] } },
    });
    await jobFor(world, conducted, "graded");

    const { verdicts } = await readVerdicts(world.auth, conducted.simulationId);
    const mine = verdicts.find((verdict) => verdict.graderId === graderId);

    expect(mine?.verdict).toBe("passed");
    // The number the span's start and end bracket, read back to the
    // millisecond — nothing on the span carries it a second time.
    expect(mine?.rationale).toContain("1214");
  });

  it("leaves a voice measure absent on a chat simulation — skipped, never failed", async () => {
    const graderId = await seedGrader(
      world,
      aThreshold({
        name: "How long the agent spoke for",
        config: {
          measure: "agent_speech_duration",
          aggregation: "p90",
          comparator: "below",
          threshold: 20_000,
        },
      } as Partial<NewGrader>),
    );

    const conducted = await conductSimulation(world, {
      spans: { said: A_CONVERSATION, measured: { turn_response_latency: [900] } },
    });
    await jobFor(world, conducted, "graded");

    const { verdicts } = await readVerdicts(world.auth, conducted.simulationId);
    const mine = verdicts.find((verdict) => verdict.graderId === graderId);

    // A chat conversation has no audio, so it measured no speech. The check did
    // not apply; it did not fail, and it did not error either — the fold leaves
    // a skipped check out of the score's denominator.
    expect(mine?.verdict).toBe("skipped");
  });
});

describe("a simulation whose trace never closed", () => {
  beforeAll(async () => {
    await service.start();
  });

  it("falls back to the row's columns, so nothing mid-migration breaks", async () => {
    const graderId = await seedGrader(
      world,
      aPhrase({ name: "Read off the columns behind a half-sent trace" }),
    );

    const conducted = await conductSimulation(world, {
      spans: {
        // Turns went out; the flush carrying the root never did.
        rootCloses: false,
        said: [{ speaker: "agent", text: "Something else entirely." }],
      },
      transcript: A_CONVERSATION_IN_COLUMNS,
    });
    await jobFor(world, conducted, "graded");

    const { verdicts } = await readVerdicts(world.auth, conducted.simulationId);
    const mine = verdicts.find((verdict) => verdict.graderId === graderId);

    // Judged, and judged from the columns: the phrase is in the column
    // transcript and nowhere in the spans that did arrive, so a pass here can
    // only have come from the fallback.
    expect(mine?.verdict).toBe("passed");
    expect(mine?.citedSpanIds).toEqual(["turn:4"]);
  });

  it("is errored for every grader when no column holds it either", async () => {
    const graderId = await seedGrader(
      world,
      aPhrase({ name: "Asked about a conversation egma holds half of" }),
    );

    const conducted = await conductSimulation(world, {
      spans: { rootCloses: false, said: A_CONVERSATION },
    });
    await jobFor(world, conducted, "graded");

    const { verdicts } = await readVerdicts(world.auth, conducted.simulationId);
    const mine = verdicts.find((verdict) => verdict.graderId === graderId);

    // Never `failed`. The required phrase is genuinely absent from what egma
    // holds, and an agent that said it perfectly would be marked down for a
    // flush that never landed.
    expect(mine?.verdict).toBe("errored");
    expect(mine?.rationale).toContain("only part of this conversation");
    expect(verdicts.every((verdict) => verdict.verdict === "errored")).toBe(true);
  });
});

describe("a simulation with no spans at all", () => {
  beforeAll(async () => {
    await service.start();
  });

  it("still grades from its columns — the row written before any of this streamed", async () => {
    const graderId = await seedGrader(
      world,
      aPhrase({ name: "Judging a row that predates the emitter" }),
    );

    const conducted = await conductSimulation(world, {
      transcript: A_CONVERSATION_IN_COLUMNS,
      metrics: { turn_response_latency: [900, 1_100] },
    });
    await jobFor(world, conducted, "graded");

    const { verdicts } = await readVerdicts(world.auth, conducted.simulationId);
    const mine = verdicts.find((verdict) => verdict.graderId === graderId);

    expect(mine?.verdict).toBe("passed");
    expect(mine?.citedSpanIds).toEqual(["turn:4"]);
  });

  it("is errored for every grader, and for every expected behavior, when its row holds nothing", async () => {
    const graderId = await seedGrader(
      world,
      aPhrase({ name: "Asked about a conversation egma has no record of" }),
    );
    const testId = await seedTest(world, [], [
      "confirms the new time back before finishing",
      "never quotes a price",
    ]);

    // Nothing streamed and nothing landed on the row: a completed conversation
    // whose evidence never reached egma at all.
    const conducted = await conductSimulation(world, {
      transcript: null,
      metrics: null,
      testId,
    });
    await jobFor(world, conducted, "graded");

    const { verdicts } = await readVerdicts(world.auth, conducted.simulationId);

    expect(verdicts.length).toBeGreaterThan(0);
    expect(verdicts.every((verdict) => verdict.verdict === "errored")).toBe(true);
    expect(
      verdicts.find((verdict) => verdict.graderId === graderId)?.rationale,
    ).toContain("no record of this conversation");

    // The built-in says the same thing, once per behavior, so a page shows the
    // same list of checks whether egma could read the conversation or not.
    const behaviors = verdicts.filter(
      (verdict) => verdict.graderId === "expected_behaviors",
    );
    expect(behaviors).toHaveLength(2);
    for (const behavior of behaviors) {
      expect(behavior.verdict).toBe("errored");
      expect(behavior.rationale).toContain("no record of this conversation");
    }
  });
});
