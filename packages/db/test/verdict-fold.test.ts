import {
  foldVerdicts,
  foldVerdictsByGrader,
  JUDGED_BY_HUMAN,
  speakingVerdicts,
  VERDICTS,
  type FoldableVerdict,
  type Verdict,
  type VerdictSource,
} from "@egma/db";
import { describe, expect, it } from "vitest";

/**
 * The fold, asked the questions a stored rollup would never have to answer.
 *
 * It is a pure function, so this file reaches no store at all: rows in, one
 * answer out. That is the whole reason the algebra was put in a function rather
 * than in a query — a query can only be tested against the rows somebody thought
 * to insert, and what has to hold here is a set of rules over *any* rows,
 * including the ones nobody thought of.
 *
 * Two halves. Small sets are asserted **exhaustively**: every arrangement of the
 * four words over one, two and three dimensions, which is 84 cases and covers
 * every interaction of the precedence rule with the denominator rule. Larger
 * ones are swept **randomly from a fixed seed**, so a sweep is a thousand shapes
 * a person would not have written down and is still the same thousand on every
 * run — a property test that cannot be reproduced is a flake with a good
 * reputation.
 */

/* ------------------------------------------------------------------- *
 * A row, and a seeded source of them.
 * ------------------------------------------------------------------- */

let nextDimension = 0;

function row(overrides: Partial<FoldableVerdict> = {}): FoldableVerdict {
  nextDimension += 1;
  return {
    traceId: "trace-1",
    graderId: "grader-1",
    graderVersionId: "version-1",
    dimension: `behavior ${nextDimension}`,
    source: "simulation",
    judgedBy: "engine",
    verdict: "passed",
    judgedAtMicroseconds: 1_785_693_880_000_000n,
    ...overrides,
  };
}

/**
 * A seeded generator, which is the whole of the randomness here.
 *
 * `Math.random` would make every run a different test and a failure impossible
 * to look at twice. This is mulberry32: thirty-two bits of state, one line of
 * arithmetic, and the same sequence forever from the same seed.
 */
function randomly(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let drawn = Math.imul(state ^ (state >>> 15), 1 | state);
    drawn = (drawn + Math.imul(drawn ^ (drawn >>> 7), 61 | drawn)) ^ drawn;
    return ((drawn ^ (drawn >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function pick<Item>(draw: () => number, from: readonly Item[]): Item {
  return from[Math.floor(draw() * from.length)] as Item;
}

const TRACES = ["trace-1", "trace-2", "trace-3"];
const GRADERS = ["grader-1", "grader-2"];
const VERSIONS = ["version-1", "version-2", "version-3"];
const DIMENSIONS = ["greeting", "slot offered", "address read back", "goodbye"];
const SOURCES: readonly VerdictSource[] = ["simulation", "production"];
const JUDGES = ["engine", "openai/gpt-judge", JUDGED_BY_HUMAN];

/**
 * A pile of rows with everything in it that a real table accumulates: several
 * conversations, several graders, dimensions judged at more than one grader
 * version, corrections written by people, and outright repeats.
 */
function someRows(draw: () => number, howMany: number): FoldableVerdict[] {
  return Array.from({ length: howMany }, () =>
    row({
      traceId: pick(draw, TRACES),
      graderId: pick(draw, GRADERS),
      graderVersionId: pick(draw, VERSIONS),
      dimension: pick(draw, DIMENSIONS),
      source: pick(draw, SOURCES),
      judgedBy: pick(draw, JUDGES),
      verdict: pick(draw, VERDICTS),
      // A day's worth of minutes, so ties happen often enough to matter.
      judgedAtMicroseconds:
        1_785_693_880_000_000n + BigInt(Math.floor(draw() * 60)) * 60_000_000n,
    }),
  );
}

function shuffled<Item>(draw: () => number, items: readonly Item[]): Item[] {
  const deck = [...items];
  for (let at = deck.length - 1; at > 0; at -= 1) {
    const swap = Math.floor(draw() * (at + 1));
    [deck[at], deck[swap]] = [deck[swap] as Item, deck[at] as Item];
  }
  return deck;
}

/** Every arrangement of `length` words drawn from the four, all of them. */
function everyArrangement(length: number): Verdict[][] {
  if (length === 0) return [[]];
  return everyArrangement(length - 1).flatMap((shorter) =>
    VERDICTS.map((word) => [...shorter, word]),
  );
}

/* ------------------------------------------------------------------- *
 * The word and the number, over every small set there is.
 * ------------------------------------------------------------------- */

describe("the word a set of verdicts folds to", () => {
  it("is failed if anything failed, errored if anything errored, and passed only if something was judged", () => {
    for (const length of [1, 2, 3]) {
      for (const words of everyArrangement(length)) {
        const rows = words.map((word) => row({ verdict: word }));
        const folded = foldVerdicts(rows);

        const expected = words.includes("failed")
          ? "failed"
          : words.includes("errored")
            ? "errored"
            : words.some((word) => word === "passed")
              ? "passed"
              : "skipped";

        expect(folded.verdict, words.join("+")).toBe(expected);
      }
    }
  });

  /**
   * A broken test is never scored as a broken agent, and that distinction is
   * carried by the word rather than by the number. So `errored` outranks
   * `passed` and is outranked by `failed` — a run holding both a real failure
   * and a judge that fell over failed, because the failure is the answer and the
   * broken judge is a second problem.
   */
  it("never collapses errored or skipped into failed", () => {
    for (const words of everyArrangement(3)) {
      const folded = foldVerdicts(words.map((word) => row({ verdict: word })));
      if (!words.includes("failed")) expect(folded.verdict).not.toBe("failed");
    }
  });
});

describe("the score", () => {
  it("is what passed over what could be scored, on every small set there is", () => {
    for (const length of [1, 2, 3]) {
      for (const words of everyArrangement(length)) {
        const folded = foldVerdicts(words.map((word) => row({ verdict: word })));

        const skipped = words.filter((word) => word === "skipped").length;
        const passed = words.filter((word) => word === "passed").length;
        const denominator = words.length - skipped;

        expect(folded.counts).toEqual({
          passed,
          failed: words.filter((word) => word === "failed").length,
          skipped,
          errored: words.filter((word) => word === "errored").length,
          total: words.length,
        });
        expect(folded.score, words.join("+")).toBe(
          denominator === 0 ? undefined : passed / denominator,
        );
      }
    }
  });

  /**
   * The rule taken whole: a dimension nobody could score is out of the
   * denominator rather than counted against anybody, so adding one to a set
   * never moves the number.
   */
  it("does not move when a skipped dimension is added to it", () => {
    const draw = randomly(0x5c1d);
    for (let sweep = 0; sweep < 200; sweep += 1) {
      const rows = someRows(draw, 1 + Math.floor(draw() * 12));
      const before = foldVerdicts(rows);
      const after = foldVerdicts([
        ...rows,
        row({
          traceId: "trace-untouched",
          dimension: "one nobody could score",
          verdict: "skipped",
        }),
      ]);

      expect(after.score).toBe(before.score);
      expect(after.counts.skipped).toBe(before.counts.skipped + 1);
    }
  });

  /**
   * `errored` stays in the denominator on purpose, and this is where that is
   * written down rather than assumed. The word says a test could not run; the
   * number stays a plain proportion of what was actually judged, so a judge that
   * fell over on half the behaviors does not quietly read as full marks on the
   * other half.
   */
  it("counts an errored dimension in the denominator, unlike a skipped one", () => {
    const passedAndErrored = foldVerdicts([
      row({ verdict: "passed" }),
      row({ verdict: "errored" }),
    ]);
    expect(passedAndErrored.score).toBe(0.5);

    const passedAndSkipped = foldVerdicts([
      row({ verdict: "passed" }),
      row({ verdict: "skipped" }),
    ]);
    expect(passedAndSkipped.score).toBe(1);
  });

  /**
   * The empty denominator, defined rather than stumbled into. There is no
   * proportion of nothing, and both available lies are worse than saying so: 1
   * because nothing failed reads as a clean sweep nobody earned, and 0 because
   * nothing passed reads as a broken agent.
   */
  it("is absent when nothing could be scored, and the word is skipped", () => {
    for (const rows of [
      [],
      [row({ verdict: "skipped" })],
      [row({ verdict: "skipped" }), row({ verdict: "skipped" })],
    ]) {
      const folded = foldVerdicts(rows);
      expect(folded.score).toBeUndefined();
      expect(folded.verdict).toBe("skipped");
    }
  });
});

/* ------------------------------------------------------------------- *
 * Who speaks for a dimension.
 * ------------------------------------------------------------------- */

describe("a dimension judged more than once", () => {
  const dimension = { traceId: "trace-1", dimension: "greeting" };

  it("is counted once however many rows have piled up against it", () => {
    const draw = randomly(0xf01d);
    for (let sweep = 0; sweep < 500; sweep += 1) {
      const rows = someRows(draw, 1 + Math.floor(draw() * 20));
      const dimensions = new Set(
        rows.map((one) =>
          [one.traceId, one.graderId, one.dimension, one.source].join("\0"),
        ),
      );

      expect(foldVerdicts(rows).counts.total).toBe(dimensions.size);
      expect(speakingVerdicts(rows)).toHaveLength(dimensions.size);
    }
  });

  /**
   * Re-grading at a tightened grader writes rows beside the old ones, so both
   * are in the input. The newer grading is the one that speaks — otherwise a
   * grader's old mistake would go on failing a run forever, which is precisely
   * what the explicit re-grade exists to undo.
   */
  it("speaks with its newest grading, not with the one it replaced", () => {
    const rows = [
      row({
        ...dimension,
        graderVersionId: "version-1",
        verdict: "failed",
        judgedAtMicroseconds: 1_000n,
      }),
      row({
        ...dimension,
        graderVersionId: "version-2",
        verdict: "passed",
        judgedAtMicroseconds: 2_000n,
      }),
    ];

    expect(foldVerdicts(rows)).toEqual({
      verdict: "passed",
      score: 1,
      counts: { passed: 1, failed: 0, skipped: 0, errored: 0, total: 1 },
    });
    expect(speakingVerdicts(rows).map((one) => one.graderVersionId)).toEqual([
      "version-2",
    ]);
  });

  /**
   * The correction supersedes at read time and the machine's row stays beneath
   * it, which is the difference between disagreeing with a judgment and erasing
   * one. Never counted twice: a set with a correction in it has exactly as many
   * counted dimensions as the same set without.
   */
  it("speaks with the person who disagreed, and still counts once", () => {
    const machine = row({
      ...dimension,
      verdict: "failed",
      judgedAtMicroseconds: 1_000n,
    });
    const person = row({
      ...dimension,
      judgedBy: JUDGED_BY_HUMAN,
      verdict: "passed",
      judgedAtMicroseconds: 2_000n,
    });

    expect(foldVerdicts([machine])).toEqual({
      verdict: "failed",
      score: 0,
      counts: { passed: 0, failed: 1, skipped: 0, errored: 0, total: 1 },
    });
    expect(foldVerdicts([machine, person])).toEqual({
      verdict: "passed",
      score: 1,
      counts: { passed: 1, failed: 0, skipped: 0, errored: 0, total: 1 },
    });
    expect(speakingVerdicts([machine, person])).toEqual([person]);
  });

  /**
   * And they win whichever order the rows arrive in, and whether their
   * correction was written before or after the machine's row — a correction is
   * always later in fact, but a fold that leaned on the clock for this would be
   * one clock skew away from ignoring a person.
   */
  it("prefers the person over the machine whatever the clock says", () => {
    const machine = row({
      ...dimension,
      verdict: "failed",
      judgedAtMicroseconds: 9_000n,
    });
    const person = row({
      ...dimension,
      judgedBy: JUDGED_BY_HUMAN,
      verdict: "passed",
      judgedAtMicroseconds: 1_000n,
    });

    expect(speakingVerdicts([machine, person])).toEqual([person]);
    expect(speakingVerdicts([person, machine])).toEqual([person]);
  });

  /**
   * A person's word stands against the grading they read, which is the only one
   * they can have read. Correcting version 1 after version 2 has been graded
   * therefore does not drag version 1 back in front — their correction stays
   * beneath, as calibration data, exactly like the machine row it answers.
   */
  it("is not dragged back to an older grading by a correction of that grading", () => {
    const rows = [
      row({
        ...dimension,
        graderVersionId: "version-1",
        verdict: "failed",
        judgedAtMicroseconds: 1_000n,
      }),
      row({
        ...dimension,
        graderVersionId: "version-2",
        verdict: "passed",
        judgedAtMicroseconds: 2_000n,
      }),
      row({
        ...dimension,
        graderVersionId: "version-1",
        judgedBy: JUDGED_BY_HUMAN,
        verdict: "skipped",
        judgedAtMicroseconds: 3_000n,
      }),
    ];

    expect(speakingVerdicts(rows).map((one) => one.graderVersionId)).toEqual([
      "version-2",
    ]);
    expect(foldVerdicts(rows).verdict).toBe("passed");
  });

  /**
   * Two judge models on one grading — which is what changing a project's default
   * judge without touching the grader produces — is the same question again, and
   * the answer is the same: the later one speaks, and the dimension counts once.
   */
  it("speaks with the later judge when the model changed under an unchanged grader", () => {
    const rows = [
      row({
        ...dimension,
        judgedBy: "openai/small",
        verdict: "failed",
        judgedAtMicroseconds: 1_000n,
      }),
      row({
        ...dimension,
        judgedBy: "openai/large",
        verdict: "passed",
        judgedAtMicroseconds: 2_000n,
      }),
    ];

    expect(speakingVerdicts(rows).map((one) => one.judgedBy)).toEqual([
      "openai/large",
    ]);
    expect(foldVerdicts(rows).counts.total).toBe(1);
  });

  it("keeps two dimensions apart even when everything else about them matches", () => {
    const rows = [
      row({ ...dimension, dimension: "greeting", verdict: "passed" }),
      row({ ...dimension, dimension: "goodbye", verdict: "failed" }),
    ];
    expect(foldVerdicts(rows).counts.total).toBe(2);
  });

  it("keeps a simulation's judgment apart from a production conversation's", () => {
    const rows = [
      row({ ...dimension, source: "simulation", verdict: "passed" }),
      row({ ...dimension, source: "production", verdict: "failed" }),
    ];
    expect(foldVerdicts(rows).counts.total).toBe(2);
  });
});

/* ------------------------------------------------------------------- *
 * What has to hold whatever the rows are.
 * ------------------------------------------------------------------- */

describe("whatever pile of rows it is handed", () => {
  /**
   * A read returns rows in whatever order the store found them, and two reads of
   * the same data may not agree on that. An answer that depended on it would
   * change its mind between two identical questions.
   */
  it("answers the same however the rows are ordered", () => {
    const draw = randomly(0xb0a7);
    for (let sweep = 0; sweep < 500; sweep += 1) {
      const rows = someRows(draw, 1 + Math.floor(draw() * 25));
      const folded = foldVerdicts(rows);

      for (let again = 0; again < 3; again += 1) {
        expect(foldVerdicts(shuffled(draw, rows))).toEqual(folded);
      }
    }
  });

  /** Handing the same rows over twice is the same question, not twice the data. */
  it("answers the same when a row is handed over twice", () => {
    const draw = randomly(0x1dee);
    for (let sweep = 0; sweep < 300; sweep += 1) {
      const rows = someRows(draw, 1 + Math.floor(draw() * 15));
      expect(foldVerdicts([...rows, ...rows])).toEqual(foldVerdicts(rows));
      expect(foldVerdicts([...rows, ...rows.map((one) => ({ ...one }))])).toEqual(
        foldVerdicts(rows),
      );
    }
  });

  /**
   * A run's answer is its simulations' answers put together, and this is why the
   * run header cannot disagree with the page under it: they are the same
   * arithmetic over the same rows, grouped or not.
   */
  it("adds up across conversations, so a run is its simulations", () => {
    const draw = randomly(0x2ead);
    for (let sweep = 0; sweep < 300; sweep += 1) {
      const rows = someRows(draw, 1 + Math.floor(draw() * 30));
      const whole = foldVerdicts(rows);

      const apart = TRACES.map((traceId) =>
        foldVerdicts(rows.filter((one) => one.traceId === traceId)),
      );

      for (const word of ["passed", "failed", "skipped", "errored", "total"] as const) {
        expect(whole.counts[word]).toBe(
          apart.reduce((running, one) => running + one.counts[word], 0),
        );
      }
      expect(whole.verdict).toBe(
        apart.some((one) => one.verdict === "failed")
          ? "failed"
          : apart.some((one) => one.verdict === "errored")
            ? "errored"
            : apart.some((one) => one.verdict === "passed")
              ? "passed"
              : "skipped",
      );
    }
  });

  /** The same, one grader at a time: the parts are exactly the whole. */
  it("splits by grader without losing or inventing a dimension", () => {
    const draw = randomly(0x9e2a);
    for (let sweep = 0; sweep < 300; sweep += 1) {
      const rows = someRows(draw, 1 + Math.floor(draw() * 30));
      const whole = foldVerdicts(rows);
      const byGrader = foldVerdictsByGrader(rows);

      expect(byGrader.map((one) => one.graderId)).toEqual(
        [...new Set(rows.map((one) => one.graderId))].sort(),
      );
      for (const word of ["passed", "failed", "skipped", "errored", "total"] as const) {
        expect(whole.counts[word]).toBe(
          byGrader.reduce((running, one) => running + one.outcome.counts[word], 0),
        );
      }
    }
  });

  /**
   * The rows that count are rows that were handed over, in the order they were
   * handed over. Nothing is invented and nothing is reordered, so what counted
   * can be shown beside what exists.
   */
  it("counts rows it was given, in the order it was given them", () => {
    const draw = randomly(0x7a1e);
    for (let sweep = 0; sweep < 300; sweep += 1) {
      const rows = someRows(draw, 1 + Math.floor(draw() * 25));
      const spoke = speakingVerdicts(rows);

      let looking = 0;
      for (const one of spoke) {
        looking = rows.indexOf(one, looking);
        expect(looking).toBeGreaterThanOrEqual(0);
        looking += 1;
      }
    }
  });

  /** And every arithmetic invariant, on every set the sweep produces. */
  it("keeps the counts and the score consistent with each other", () => {
    const draw = randomly(0x3c0a);
    for (let sweep = 0; sweep < 500; sweep += 1) {
      const rows = someRows(draw, Math.floor(draw() * 25));
      const { verdict, score, counts } = foldVerdicts(rows);

      expect(counts.passed + counts.failed + counts.skipped + counts.errored).toBe(
        counts.total,
      );

      const denominator = counts.total - counts.skipped;
      if (denominator === 0) {
        expect(score).toBeUndefined();
        expect(verdict).toBe("skipped");
      } else {
        expect(score).toBe(counts.passed / denominator);
        expect(score).toBeGreaterThanOrEqual(0);
        expect(score).toBeLessThanOrEqual(1);
        expect(verdict).toBe(
          counts.failed > 0
            ? "failed"
            : counts.errored > 0
              ? "errored"
              : "passed",
        );
      }
    }
  });
});
