import {
  GRADER_DEFINITION_CATALOG,
  PREDEFINED_GRADERS,
  type GraderDefinitionSnapshot,
} from "@egma/db";
import { describe, expect, it } from "vitest";

import type { Conversation } from "../src/conversation.ts";
import { executeExpectedBehaviors } from "../src/graders/expected-behaviors.ts";
import {
  cannotDetermine,
  met,
  notMet,
  scriptedJudging,
  type Scripted,
} from "./support/scripted-judge.ts";

const BEHAVIORS = [
  "confirms the new time",
  "does not quote a price",
  "offers a reminder",
  "states the cancellation policy",
  "does not expose private data",
  "answers the caller's question",
  "ends politely",
] as const;

function definition(): GraderDefinitionSnapshot {
  const found = GRADER_DEFINITION_CATALOG.find(
    (candidate) => candidate.id === PREDEFINED_GRADERS.expectedBehaviors,
  );
  if (found === undefined) throw new Error("Expected behaviors is not cataloged");
  return {
    definitionId: found.id,
    definitionVersion: 1,
    type: found.type,
    prompt: found.prompt,
    parameterContract: found.parameterContract,
    modalities: found.modalities,
    judgeModel: found.judgeModel,
  };
}

function conversation(
  overrides: Partial<Conversation> = {},
): Conversation {
  return {
    source: "simulation",
    traceId: "1111111111111111111111111111aaaa",
    nothingToJudgeBecause: null,
    endingReason: "persona_concluded",
    transcript: [
      {
        span_id: "aaaaaaaaaaaaaaaa",
        speaker: "persona",
        text: "Please cancel my appointment.",
      },
      {
        span_id: "bbbbbbbbbbbbbbbb",
        speaker: "agent",
        text: "It is canceled. The policy permits it.",
      },
    ],
    events: [],
    measures: [],
    runId: "run_01JQZ0000000000000000000AA",
    agentId: "agt_01JQZ0000000000000000000AA",
    ...overrides,
  };
}

async function grade(
  answers: Readonly<Record<string, Scripted>>,
  overrides: {
    readonly behaviors?: readonly string[];
    readonly conversation?: Partial<Conversation>;
  } = {},
) {
  const scripted = scriptedJudging({ answers });
  const result = await executeExpectedBehaviors({
    definition: definition(),
    parameterValues: {},
    conversation: conversation(overrides.conversation),
    judging: scripted.judging,
    reading: {
      async expectedBehaviors() {
        return overrides.behaviors ?? BEHAVIORS;
      },
    },
  });
  return { result, judge: scripted.judge };
}

describe("Expected behaviors produces one grade", () => {
  it("normalizes seven independent assertions into one score", async () => {
    const answers = Object.fromEntries(
      BEHAVIORS.map((behavior, at) => [
        behavior,
        at < 5
          ? met(`behavior ${at + 1} passed`, at === 0 ? [2] : [])
          : notMet(`behavior ${at + 1} failed`),
      ]),
    );

    const { result, judge } = await grade(answers);

    expect(result.score).toBe(5 / 7);
    expect(result.details.rationale).toBe(
      "5 of 7 expected behaviors passed.",
    );
    expect(result.details.assertions).toHaveLength(7);
    expect(result.details.assertions?.[0]).toEqual({
      key: "behavior_1",
      score: 1,
      rationale: "behavior 1 passed",
      citedSpanIds: ["bbbbbbbbbbbbbbbb"],
    });
    expect(result.details.assertions?.[6]).toMatchObject({
      key: "behavior_7",
      score: 0,
    });
    expect(judge.asked.map((question) => question.criterion)).toEqual(BEHAVIORS);
  });

  it("keeps completed assertion evidence but errors the grade when one call fails", async () => {
    const { result } = await grade({
      [BEHAVIORS[0]]: met("confirmed", [2]),
      [BEHAVIORS[1]]: new Error("judge answered 503"),
      [BEHAVIORS[2]]: notMet("no reminder"),
    }, { behaviors: BEHAVIORS.slice(0, 3) });

    expect(result.score).toBeNull();
    expect(result.details.error).toBe(
      "1 of 3 expected behaviors could not be graded",
    );
    expect(result.details.assertions).toEqual([
      {
        key: "behavior_1",
        score: 1,
        rationale: "confirmed",
        citedSpanIds: ["bbbbbbbbbbbbbbbb"],
      },
      {
        key: "behavior_2",
        error: "this behavior could not be graded: judge answered 503",
      },
      {
        key: "behavior_3",
        score: 0,
        rationale: "no reminder",
        citedSpanIds: [],
      },
    ]);
  });

  it("treats could-not-determine as an error rather than zero", async () => {
    const { result } = await grade({
      [BEHAVIORS[0]]: cannotDetermine("the evidence does not settle it"),
    }, { behaviors: BEHAVIORS.slice(0, 1) });

    expect(result.score).toBeNull();
    expect(result.details.assertions?.[0]).toMatchObject({
      key: "behavior_1",
      rationale: "the evidence does not settle it",
      error: "the grader could not determine whether this behavior was met",
    });
  });

  it("writes one error result without asking a model when evidence is absent", async () => {
    const { result, judge } = await grade({}, {
      behaviors: BEHAVIORS.slice(0, 2),
      conversation: { nothingToJudgeBecause: "the trace is incomplete" },
    });

    expect(result.score).toBeNull();
    expect(result.details.error).toBe("the trace is incomplete");
    expect(result.details.assertions).toEqual([
      { key: "behavior_1", error: "the trace is incomplete" },
      { key: "behavior_2", error: "the trace is incomplete" },
    ]);
    expect(judge.asked).toEqual([]);
  });
});
