import {
  GRADER_LIBRARY_CATALOG,
  PREDEFINED_GRADERS,
  type AuthContext,
  type Grader,
  type GraderDefinitionSnapshot,
} from "@egma/db";
import { describe, expect, it } from "vitest";

import type { Conversation } from "../src/conversation.ts";
import { judgmentsOf } from "../src/grade.ts";
import { noJudgeWanted } from "./support/scripted-judge.ts";

/**
 * What one grader says about one conversation, before anything is written down.
 *
 * The seam between the engine and a library entry's executor is where unknown
 * code runs — every entry egma ships after these two arrives through it — so
 * the promises the engine makes about that seam are asserted here rather than
 * inferred from whichever entries happen to be executable today.
 */

function conversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    source: "simulation",
    traceId: "sim_01JQZ0000000000000000000AA",
    nothingToJudgeBecause: null,
    endingReason: "persona_concluded",
    transcript: [],
    events: [],
    measures: [
      {
        measure: "turn_response_latency",
        unit: "milliseconds" as const,
        origin: "timed" as const,
        reportedBy: "",
        samples: [{ value: 900, spanId: "0000000000000001" }],
      },
    ],
    runId: "run_01JQZ0000000000000000000AA",
    agentId: "agt_01JQZ0000000000000000000AA",
    ...overrides,
  };
}

const auth: AuthContext = {
  userId: "usr_01JQZ0000000000000000000AA",
  organizationId: "org_01JQZ0000000000000000000AA",
  projectId: "prj_01JQZ0000000000000000000AA",
  role: "member",
  via: "session",
};

/**
 * A running copy as the factory hands one over. Built rather than read, because
 * what is under test is what the engine does with a copy, not how one is
 * stored.
 */
function grader(overrides: Partial<Grader> = {}): Grader {
  return {
    id: "grd_01JQZ0000000000000000000AA",
    projectId: auth.projectId ?? "",
    libraryId: PREDEFINED_GRADERS.latency,
    name: "Answers inside two seconds",
    description: null,
    type: "code",
    required: true,
    scope: "simulations",
    productionSampleRate: 100,
    version: 1,
    versionId: "grv_01JQZ0000000000000000000AA",
    config: { assertions: [{ metric: "turn_response_latency", bound: 2_000 }] },
    judgeModel: null,
    definition: definition(PREDEFINED_GRADERS.latency),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

/**
 * The immutable definition revision one grader version points at.
 */
function definition(id: string): GraderDefinitionSnapshot {
  const entry = GRADER_LIBRARY_CATALOG.find((candidate) => candidate.id === id);
  if (entry === undefined) throw new Error(`no catalog entry ${id}`);
  return {
    libraryId: entry.id,
    libraryVersion: 1,
    type: entry.type,
    prompt: entry.prompt,
    params: entry.params,
    outputDefinition: entry.outputDefinition,
    sourceCode: null,
    sourceCodeLanguage: null,
  };
}

/** What every case here hands the seam besides the grader and its definition. */
function judging(conversationOverrides: Partial<Conversation> = {}) {
  return {
    conversation: conversation(conversationOverrides),
    judging: noJudgeWanted(),
    reading: { auth, simulationId: "sim_01JQZ0000000000000000000AA" },
  };
}

describe("a copy of an entry egma cannot execute yet", () => {
  /**
   * **`errored`, and deliberately not `skipped`.** `skipped` means the check
   * did not apply to this conversation and leaves the score's denominator,
   * which is right for a measure a conversation could never produce and wrong
   * here: this check applies perfectly well and egma did not make it. Saying so
   * out loud is what keeps a project's page from going green because a grader
   * quietly judged nothing.
   *
   * Both entries v0 ships are executed now, so the case is asked with an entry
   * off the shelf that no roster names — which is exactly what a copy of a
   * *third* predefined grader looks like on the release before its executor
   * lands. Asking it with a real entry would mean waiting for one to be missing
   * again, which is to say never asking it.
   */
  it("says so out loud rather than passing", async () => {
    const unbuilt = {
      ...definition(PREDEFINED_GRADERS.latency),
      libraryId: "grl_01M01MH8KCE00NOTHINGBUILTYET",
    };

    const [only] = await judgmentsOf(
      grader({ libraryId: unbuilt.libraryId, definition: unbuilt }),
      judging(),
    );

    expect(only).toMatchObject({
      // The entry's identifier, not its name: a predefined entry keeps one
      // identifier for life while its name is text a release may improve, and a
      // key that moved with the name would split every row written before a
      // rename from every row written after.
      assertion: unbuilt.libraryId,
      verdict: "errored",
      score: 0,
      citedSpanIds: [],
    });
    expect(only?.rationale).toContain(
      `does not execute Library grader ${unbuilt.libraryId} yet`,
    );
  });
});

describe("a simulation that never ran", () => {
  /**
   * Either it never happened or egma cannot read it, and both are things that
   * went wrong on egma's side of the glass. The one thing a test product must
   * never do is score them as the agent behaving badly, so the reason the
   * conversation carries is the reason the row carries.
   */
  it("is errored for the grader, in the conversation's own words", async () => {
    const [only] = await judgmentsOf(
      grader(),
      judging({
        nothingToJudgeBecause:
          "this simulation ended agent_never_joined, so there was no conversation to judge.",
        endingReason: "agent_never_joined",
        // Measures the grader would happily have passed, so the answer cannot
        // be coming from anything having looked at them.
        measures: [
          {
            measure: "turn_response_latency",
            unit: "milliseconds" as const,
            origin: "timed" as const,
            reportedBy: "",
            samples: [{ value: 10, spanId: "0000000000000001" }],
          },
        ],
      }),
    );

    expect(only).toMatchObject({ verdict: "errored", score: 0 });
    expect(only?.rationale).toBe(
      "this simulation ended agent_never_joined, so there was no conversation to judge.",
    );
  });
});

describe("a grader whose execution falls over", () => {
  /**
   * **A grader that fell over writes one `errored` row per check it makes**, not
   * one row for the grader — and where those keys come from is the whole point.
   *
   * A verdict is counted once per conversation, grader and assertion key, and
   * the newest grading of a key supersedes the older one. That identity does not
   * span the grader version, so a row filed under a key the executor never
   * produces can never be superseded by anything: it would outrank every
   * `passed` beside it forever and no re-grade could reach it. The engine
   * therefore asks the grader to spread the reason across its own keys, and
   * `expected-behaviors.test.ts` watches a broken grading get rewritten by a
   * later one through the whole service.
   *
   * **When even the keys cannot be answered, nothing is written and the throw
   * escapes.** That is what this file can see. The expected-behaviors grader
   * reads its assertions off the test — a store call — and nothing here connects
   * a store, so both the execution and the question "what would you have
   * checked" fail. A grader egma cannot describe is one it must stay silent
   * about rather than file a row it can never correct; the job is released and
   * judged again from the beginning, which is what the attempt count is for.
   */
  it("writes nothing at all when it cannot even name its assertions", async () => {
    const judged = grader({
      libraryId: PREDEFINED_GRADERS.expectedBehaviors,
      type: "llm_as_judge",
      config: { assertions: [] },
      definition: definition(PREDEFINED_GRADERS.expectedBehaviors),
    });

    await expect(judgmentsOf(judged, judging())).rejects.toThrow(/not connected/);
  });

  it("never says failed, because nothing is being said about the agent", async () => {
    // A definition revision whose executor has not shipped is a platform fault,
    // never evidence that the agent failed its check.
    const unbuilt = {
      ...definition(PREDEFINED_GRADERS.latency),
      libraryId: "grl_01M01MH8KCE00NOTHINGBUILTYET",
    };

    const judgments = await judgmentsOf(
      grader({ libraryId: unbuilt.libraryId, definition: unbuilt }),
      judging(),
    );
    expect(judgments.length).toBeGreaterThan(0);
    for (const judgment of judgments) {
      expect(judgment.verdict).toBe("errored");
    }
  });

  /**
   * **A computed grader never reaches for a judge**, and that is asserted rather
   * than assumed: `noJudgeWanted` throws if anything on this path asks a model.
   * A job whose only running graders are computed must never use a deployment
   * provider key.
   */
  it("computes latency without asking anybody, and passes what holds", async () => {
    const judgments = await judgmentsOf(
      grader(),
      judging(),
    );

    expect(judgments).toHaveLength(1);
    expect(judgments[0]).toMatchObject({
      // The config entry's position, one-based — never the measure or the
      // bound, which a person may edit and which a re-grade must write over
      // rather than beside.
      assertion: "turn_response_latency",
      verdict: "passed",
      score: 1,
    });
    expect(judgments[0]?.rationale).toContain("turn_response_latency");
  });
});
