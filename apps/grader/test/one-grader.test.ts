import {
  GRADER_LIBRARY_CATALOG,
  PREDEFINED_GRADERS,
  type AuthContext,
  type Grader,
  type LibraryEntry,
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
    metrics: { turn_response_latency: [900] },
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
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

/**
 * The definition, as it is read through the copy's pointer at judging time —
 * off the catalog itself, so what this file hands the seam is the row a
 * deployment would actually have on its shelf.
 */
function definition(id: string): LibraryEntry {
  const entry = GRADER_LIBRARY_CATALOG.find((candidate) => candidate.id === id);
  if (entry === undefined) throw new Error(`no catalog entry ${id}`);
  return {
    id: entry.id,
    name: entry.name,
    description: entry.description,
    type: entry.type,
    owner: "egma",
    projectId: null,
    version: 1,
    prompt: entry.prompt,
    params: entry.params,
    outputDefinition: entry.outputDefinition,
    createdAt: entry.createdAt,
    updatedAt: entry.createdAt,
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
   */
  it("says so out loud rather than passing", async () => {
    const [only] = await judgmentsOf(
      grader(),
      definition(PREDEFINED_GRADERS.latency),
      judging(),
    );

    expect(only).toMatchObject({
      assertion: "latency",
      verdict: "errored",
      score: 0,
      citedSpanIds: [],
    });
    expect(only?.rationale).toContain("does not execute the latency grader yet");
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
      definition(PREDEFINED_GRADERS.latency),
      judging({
        nothingToJudgeBecause:
          "this simulation ended agent_never_joined, so there was no conversation to judge.",
        endingReason: "agent_never_joined",
        // Measures the grader would happily have passed, so the answer cannot
        // be coming from anything having looked at them.
        metrics: { turn_response_latency: [10] },
      }),
    );

    expect(only).toMatchObject({ verdict: "errored", score: 0 });
    expect(only?.rationale).toBe(
      "this simulation ended agent_never_joined, so there was no conversation to judge.",
    );
  });
});

describe("a copy whose entry cannot be read", () => {
  /**
   * The pointer is a foreign key, so this cannot happen — and it is answered
   * rather than asserted, because a grading service is not the place to throw
   * over a row that came out of its own database. The row names the grader,
   * because that is what somebody looking at the page has in front of them.
   */
  it("is one errored row naming the grader, not a conversation with none", async () => {
    const [only] = await judgmentsOf(grader(), undefined, judging());

    expect(only).toMatchObject({
      assertion: "Answers inside two seconds",
      verdict: "errored",
      score: 0,
    });
    expect(only?.rationale).toContain("library entry egma cannot read");
  });
});

describe("a grader whose execution falls over", () => {
  /**
   * One grader failing is one `errored` row and not a conversation with no
   * verdicts on it. It matters most as the shelf grows: a judge model timing
   * out on one check must leave every other check's judgment standing, and the
   * engine rather than each executor is what guarantees it.
   *
   * The expected-behaviors executor is the one that reaches a store — its
   * assertions live on the test, so it has to go and get them — and nothing in
   * this file connects one. So asking it here is a real executor throwing real
   * code at the seam, which is exactly the case a well-formed input cannot
   * otherwise produce.
   */
  it("is one errored row, and says what went wrong", async () => {
    const judged = grader({
      libraryId: PREDEFINED_GRADERS.expectedBehaviors,
      type: "llm_as_judge",
      config: { assertions: [] },
    });

    const judgments = await judgmentsOf(
      judged,
      definition(PREDEFINED_GRADERS.expectedBehaviors),
      judging(),
    );

    expect(judgments).toHaveLength(1);
    expect(judgments[0]).toMatchObject({
      assertion: "expected_behaviors",
      verdict: "errored",
      score: 0,
      citedSpanIds: [],
    });
    expect(judgments[0]?.rationale).toContain("this check could not be made");
  });

  it("never says failed, because nothing is being said about the agent", async () => {
    for (const [copy, entry] of [
      [grader(), definition(PREDEFINED_GRADERS.latency)] as const,
      [
        grader({ libraryId: PREDEFINED_GRADERS.expectedBehaviors }),
        definition(PREDEFINED_GRADERS.expectedBehaviors),
      ] as const,
      [grader(), undefined] as const,
    ]) {
      for (const judgment of await judgmentsOf(copy, entry, judging())) {
        expect(judgment.verdict).toBe("errored");
      }
    }
  });
});
