import {
  GRADER_LIBRARY_CATALOG,
  PREDEFINED_GRADERS,
  type AuthContext,
  type Grader,
  type LibraryEntry,
  type MeasuredFromSpans,
} from "@egma/db";
import {
  MEASURE_CATALOG,
  SPAN_DERIVED_MEASURES,
} from "@egma/simulation-contract";
import { describe, expect, it } from "vitest";

import type { Conversation } from "../src/conversation.ts";
import { executeLatency, latencyAssertions } from "../src/graders/latency.ts";
import type { Execution } from "../src/graders/index.ts";
import { noJudgeWanted } from "./support/scripted-judge.ts";

/**
 * The latency grader itself: config entries in, one verdict each out, and no
 * model asked anything.
 *
 * **Asked without a store, on purpose.** What the executor does with the
 * measures it is handed is a decision that has nothing to do with where they
 * came from — the shared measure module's own suite proves those numbers come
 * off real spans in a real ClickHouse, identically for a simulation and a
 * production trace. This file is the other half: given numbers, what does the
 * grader say, and under which keys.
 *
 * `noJudgeWanted` throws if anything on this path reaches for a judge, so
 * "computed, with no model call anywhere" is asserted by every case here rather
 * than by one of them.
 */

const auth: AuthContext = {
  userId: "usr_01JQZ0000000000000000000AA",
  organizationId: "org_01JQZ0000000000000000000AA",
  projectId: "prj_01JQZ0000000000000000000AA",
  role: "member",
  via: "session",
};

/** The entry as it is read through the copy's pointer — off the catalog itself. */
function theLatencyEntry(): LibraryEntry {
  const entry = GRADER_LIBRARY_CATALOG.find(
    (candidate) => candidate.id === PREDEFINED_GRADERS.latency,
  );
  if (entry === undefined) throw new Error("no latency entry in the catalog");
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

/** One measured series, in the shape the measure module hands one over. */
function measured(
  measure: string,
  samples: readonly number[],
): MeasuredFromSpans {
  return {
    measure,
    unit: "milliseconds",
    samples,
    spanIds: samples.map((_, at) => `span-${measure}-${at}`),
  };
}

function execution(
  entries: readonly Readonly<Record<string, string | number>>[],
  conversation: Partial<Conversation> = {},
): Execution {
  return {
    definition: theLatencyEntry(),
    config: { assertions: entries } as Grader["config"],
    conversation: {
      source: "simulation",
      traceId: "sim_01JQZ0000000000000000000AA",
      nothingToJudgeBecause: null,
      endingReason: "persona_concluded",
      transcript: [],
      events: [],
      measures: [measured("turn_response_latency", [900, 1_100])],
      runId: "run_01JQZ0000000000000000000AA",
      agentId: "agt_01JQZ0000000000000000000AA",
      ...conversation,
    },
    judging: noJudgeWanted(),
    reading: { auth, simulationId: "sim_01JQZ0000000000000000000AA" },
  };
}

describe("one config entry, one assertion", () => {
  it("passes when the worst measurement holds the bound", () => {
    const [only] = executeLatency(
      execution([{ metric: "turn_response_latency", bound: 2_000 }]),
    );

    expect(only).toMatchObject({
      assertion: "assertion_1",
      verdict: "passed",
      score: 1,
    });
    // The worst of the two, named with its unit, and the bound it held.
    expect(only?.rationale).toBe(
      "turn_response_latency was 1100 milliseconds at its worst, across 2 measurements, within the bound of 2000.",
    );
    // The span the deciding measurement happened in.
    expect(only?.citedSpanIds).toEqual(["span-turn_response_latency-1"]);
  });

  /**
   * **The worst measurement decides, and it is not a detail.** A mean of 900 and
   * 3000 is 1950, inside a two-second bound — and the conversation had a turn
   * the caller waited three seconds through. A check that passed it would be a
   * check nobody should believe, which is why there is no aggregation to choose
   * and the strictest reading is the only one.
   */
  it("fails when one measurement misses the bound, however good the rest are", () => {
    const [only] = executeLatency(
      execution([{ metric: "turn_response_latency", bound: 2_000 }], {
        measures: [measured("turn_response_latency", [900, 3_000, 850])],
      }),
    );

    expect(only).toMatchObject({ verdict: "failed", score: 0 });
    expect(only?.rationale).toContain("3000 milliseconds at its worst");
    expect(only?.rationale).toContain("over the bound of 2000");
    expect(only?.citedSpanIds).toEqual(["span-turn_response_latency-1"]);
  });

  it("says the number plainly when there was only one measurement", () => {
    const [only] = executeLatency(
      execution([{ metric: "first_response_latency", bound: 1_500 }], {
        measures: [measured("first_response_latency", [1_214])],
      }),
    );

    expect(only?.rationale).toBe(
      "first_response_latency was 1214 milliseconds, within the bound of 1500.",
    );
  });

  it("passes a measurement exactly on the bound, because a bound is a most", () => {
    const [only] = executeLatency(
      execution([{ metric: "turn_response_latency", bound: 1_100 }]),
    );

    expect(only).toMatchObject({ verdict: "passed", score: 1 });
  });
});

describe("several config entries", () => {
  /**
   * One row each, keyed by **position** — never by the measure or the bound.
   * The fold counts a verdict once per conversation, grader and key, and prefers
   * the latest grading of that key; a key made of what somebody typed would turn
   * a re-grade at a tightened bound into a second assertion counted beside the
   * first forever, with both of them speaking.
   */
  it("are one assertion each, keyed by their position and nothing else", () => {
    const judgments = executeLatency(
      execution(
        [
          { metric: "turn_response_latency", bound: 2_000 },
          { metric: "turn_response_latency", bound: 500 },
          { metric: "first_response_latency", bound: 1_000 },
        ],
        {
          measures: [
            measured("turn_response_latency", [900, 1_100]),
            measured("first_response_latency", [1_214]),
          ],
        },
      ),
    );

    expect(judgments.map((one) => one.assertion)).toEqual([
      "assertion_1",
      "assertion_2",
      "assertion_3",
    ]);
    expect(judgments.map((one) => one.verdict)).toEqual([
      "passed",
      "failed",
      "failed",
    ]);
  });

  /**
   * **The keys a failure files under are the keys a judging writes**, which is
   * what makes an `errored` latency row one a re-grade can clear rather than one
   * that fails a test forever. The engine asks the companion when something
   * threw; if it answered different keys, those rows would sit beside the real
   * ones outranking every `passed` and nothing could reach them.
   */
  it("name the same keys whether egma judges them or only describes them", () => {
    const asked = execution([
      { metric: "turn_response_latency", bound: 2_000 },
      { metric: "first_response_latency", bound: 1_000 },
    ]);

    expect(latencyAssertions(asked)).toEqual(
      executeLatency(asked).map((one) => one.assertion),
    );
  });
});

/**
 * **A measure this conversation did not produce is `skipped`** — out of the
 * fraction's denominator, never failed and never errored. Asked **per measure in
 * the catalog**, because each needs different spans to be computable and one
 * case would only prove the measure it happened to pick.
 *
 * The loop is over the catalog rather than over a list written here, so a
 * measure added to egma starts being asked about the day it is added.
 */
describe("a conversation a measure cannot be computed for", () => {
  for (const cataloged of MEASURE_CATALOG) {
    it(`is skipped for ${cataloged.measure}, and out of the denominator`, () => {
      // Everything **except** this one, so the case is about this measure and
      // not about a conversation that measured nothing at all.
      const everythingElse = SPAN_DERIVED_MEASURES.filter(
        (other) => other !== cataloged.measure,
      ).map((other) => measured(other, [900]));

      const [only] = executeLatency(
        execution([{ metric: cataloged.measure, bound: 2_000 }], {
          measures: everythingElse,
        }),
      );

      expect(only).toMatchObject({
        assertion: "assertion_1",
        verdict: "skipped",
        // Zero, and it decides nothing: a skipped assertion leaves the
        // denominator, so this number is never divided by anything.
        score: 0,
      });
      expect(only?.rationale).toBe(
        `nothing in this conversation measured ${cataloged.measure}, so there was nothing to check against 2000.`,
      );
      expect(only?.citedSpanIds).toEqual([]);
    });
  }

  it("is skipped for every measure at once when nothing was measured", () => {
    const judgments = executeLatency(
      execution(
        SPAN_DERIVED_MEASURES.map((metric) => ({ metric, bound: 2_000 })),
        { measures: [] },
      ),
    );

    expect(judgments).toHaveLength(SPAN_DERIVED_MEASURES.length);
    for (const judgment of judgments) {
      expect(judgment.verdict).toBe("skipped");
    }
  });
});

describe("a conversation there is nothing to judge", () => {
  /**
   * `errored`, one row per assertion, in the conversation's own words — never
   * `failed`. A simulation the simulator reported never ran, or one whose spans
   * never arrived, went wrong on egma's side of the glass, and the one thing a
   * test product must never do is score that as the agent behaving badly.
   *
   * One row per assertion rather than one for the grader, so a page shows the
   * same list of checks whether egma managed to make them or not — and so a
   * later grading writes over exactly these rows.
   */
  it("is errored for every entry, with the conversation's own reason", () => {
    const because =
      "this simulation ended agent_never_joined, so there was no conversation to judge.";

    const judgments = executeLatency(
      execution(
        [
          { metric: "turn_response_latency", bound: 2_000 },
          { metric: "first_response_latency", bound: 1_000 },
        ],
        {
          nothingToJudgeBecause: because,
          // Measures the grader would happily have passed, so the answer cannot
          // be coming from anything having looked at them.
          measures: [
            measured("turn_response_latency", [10]),
            measured("first_response_latency", [10]),
          ],
        },
      ),
    );

    expect(judgments.map((one) => one.assertion)).toEqual([
      "assertion_1",
      "assertion_2",
    ]);
    for (const judgment of judgments) {
      expect(judgment).toMatchObject({ verdict: "errored", score: 0 });
      expect(judgment.rationale).toBe(because);
    }
  });
});

describe("a config row nothing could have written", () => {
  /**
   * The write door checks every value against the entry's declared parameters,
   * so a stored entry always holds a measure and a number. It is answered rather
   * than thrown over anyway, because a grading service is not the place to fall
   * over a row that came out of its own database — and the word is `errored`,
   * because egma could not make the check and the agent did nothing.
   */
  it("is errored rather than thrown over, and never failed", () => {
    for (const broken of [
      {},
      { metric: "turn_response_latency" },
      { bound: 2_000 },
      { metric: "", bound: 2_000 },
    ]) {
      const [only] = executeLatency(
        execution([broken as Readonly<Record<string, string | number>>]),
      );

      expect(only).toMatchObject({
        assertion: "assertion_1",
        verdict: "errored",
        score: 0,
      });
    }
  });
});
