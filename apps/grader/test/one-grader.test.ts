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
      // The entry's identifier, not its name: a predefined entry keeps one
      // identifier for life while its name is text a release may improve, and a
      // key that moved with the name would split every row written before a
      // rename from every row written after.
      assertion: PREDEFINED_GRADERS.latency,
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
      // The pointer, not the copy's name, for the same reason: a name is
      // something a person wrote and may rewrite.
      assertion: PREDEFINED_GRADERS.latency,
      verdict: "errored",
      score: 0,
    });
    expect(only?.rationale).toContain("library entry egma cannot read");
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
    });

    await expect(
      judgmentsOf(
        judged,
        definition(PREDEFINED_GRADERS.expectedBehaviors),
        judging(),
      ),
    ).rejects.toThrow(/not connected/);
  });

  it("never says failed, because nothing is being said about the agent", async () => {
    // The two a conversation can reach without a store behind it: an entry egma
    // does not execute yet, and a copy whose entry could not be read at all.
    for (const [copy, entry] of [
      [grader(), definition(PREDEFINED_GRADERS.latency)] as const,
      [grader(), undefined] as const,
    ]) {
      const judgments = await judgmentsOf(copy, entry, judging());
      expect(judgments.length).toBeGreaterThan(0);
      for (const judgment of judgments) {
        expect(judgment.verdict).toBe("errored");
      }
    }
  });
});
