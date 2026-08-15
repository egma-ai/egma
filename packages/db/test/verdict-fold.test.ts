import {
  foldVerdictsByGrader,
  speakingVerdicts,
  verdictLanes,
  VERDICTS,
  type FoldableVerdict,
  type Verdict,
  type VerdictSource,
} from "@egma/db";
// `foldVerdicts` is deliberately not on the package's surface — see the note
// beside its neighbours in `src/index.ts`. This file is the algebra's own unit
// test and lives in the same package, so it reaches the module directly.
import { foldVerdicts } from "../src/verdicts/fold.ts";
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
 * four words over one, two and three assertions, which is 84 cases and covers
 * every interaction of the precedence rule with the denominator rule. Larger
 * ones are swept **randomly from a fixed seed**, so a sweep is a thousand shapes
 * a person would not have written down and is still the same thousand on every
 * run — a property test that cannot be reproduced is a flake with a good
 * reputation.
 */

/* ------------------------------------------------------------------- *
 * A row, and a seeded source of them.
 * ------------------------------------------------------------------- */

let nextAssertion = 0;

function row(overrides: Partial<FoldableVerdict> = {}): FoldableVerdict {
  nextAssertion += 1;
  return {
    traceId: "trace-1",
    graderId: "grader-1",
    graderVersionId: "version-1",
    assertion: `behavior_${nextAssertion}`,
    source: "simulation",
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
const ASSERTIONS = ["behavior_1", "behavior_2", "behavior_3", "behavior_4"];
const SOURCES: readonly VerdictSource[] = ["simulation", "production"];

/**
 * A pile of rows with everything in it that a real table accumulates: several
 * conversations, several graders, assertions judged at more than one grader
 * version, and outright repeats.
 */
function someRows(draw: () => number, howMany: number): FoldableVerdict[] {
  return Array.from({ length: howMany }, () =>
    row({
      traceId: pick(draw, TRACES),
      graderId: pick(draw, GRADERS),
      graderVersionId: pick(draw, VERSIONS),
      assertion: pick(draw, ASSERTIONS),
      source: pick(draw, SOURCES),
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
   * The rule taken whole: an assertion nobody could score is out of the
   * denominator rather than counted against anybody, so adding one to a set
   * never moves the number.
   */
  it("does not move when a skipped assertion is added to it", () => {
    const draw = randomly(0x5c1d);
    for (let sweep = 0; sweep < 200; sweep += 1) {
      const rows = someRows(draw, 1 + Math.floor(draw() * 12));
      const before = foldVerdicts(rows);
      const after = foldVerdicts([
        ...rows,
        row({
          traceId: "trace-untouched",
          assertion: "one_nobody_could_score",
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
  it("counts an errored assertion in the denominator, unlike a skipped one", () => {
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
 * Who speaks for an assertion.
 * ------------------------------------------------------------------- */

describe("an assertion judged more than once", () => {
  const assertion = { traceId: "trace-1", assertion: "behavior_1" };

  it("is counted once however many rows have piled up against it", () => {
    const draw = randomly(0xf01d);
    for (let sweep = 0; sweep < 500; sweep += 1) {
      const rows = someRows(draw, 1 + Math.floor(draw() * 20));
      const assertions = new Set(
        rows.map((one) =>
          [one.traceId, one.graderId, one.assertion, one.source].join("\0"),
        ),
      );

      expect(foldVerdicts(rows).counts.total).toBe(assertions.size);
      expect(speakingVerdicts(rows)).toHaveLength(assertions.size);
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
        ...assertion,
        graderVersionId: "version-1",
        verdict: "failed",
        judgedAtMicroseconds: 1_000n,
      }),
      row({
        ...assertion,
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
   * A second grader's word about an assertion keyed the same way is a second
   * assertion, never a second opinion — which is what lets human corrections
   * come back as the reserved `human` type with no `judged_by` to arbitrate.
   * Both count, and binary scoring then needs both to pass.
   */
  it("keeps another grader's word apart rather than superseding with it", () => {
    const machine = row({
      ...assertion,
      verdict: "failed",
      judgedAtMicroseconds: 1_000n,
    });
    const person = row({
      ...assertion,
      graderId: "grader-human",
      verdict: "passed",
      judgedAtMicroseconds: 2_000n,
    });

    expect(foldVerdicts([machine, person])).toEqual({
      verdict: "failed",
      score: 0.5,
      counts: { passed: 1, failed: 1, skipped: 0, errored: 0, total: 2 },
    });
    expect(speakingVerdicts([machine, person])).toEqual([machine, person]);
  });

  /**
   * A judge model changing under an unchanged grader — which is what changing a
   * project's default produces — writes a second row on one identity, and the
   * store keeps the later of the two. Nothing on the row says which model
   * answered any more, so the later word simply speaks and the assertion counts
   * once.
   */
  it("speaks with the later grading when the model changed under an unchanged grader", () => {
    const rows = [
      row({ ...assertion, verdict: "failed", judgedAtMicroseconds: 1_000n }),
      row({ ...assertion, verdict: "passed", judgedAtMicroseconds: 2_000n }),
    ];

    expect(speakingVerdicts(rows).map((one) => one.verdict)).toEqual(["passed"]);
    expect(foldVerdicts(rows).counts.total).toBe(1);
  });

  /**
   * Two rows the store itself cannot order — same identity, same instant — are
   * the one case with no later row to prefer. The fold cannot be more decided
   * than the table underneath it, so it is consistent instead, and it breaks the
   * tie towards the more serious word: a green tick that arrived by luck is the
   * one answer this product must never give.
   */
  it("breaks a dead heat towards the more serious word, whatever the order", () => {
    const passed = row({
      ...assertion,
      verdict: "passed",
      judgedAtMicroseconds: 1_000n,
    });
    const failed = row({
      ...assertion,
      verdict: "failed",
      judgedAtMicroseconds: 1_000n,
    });

    expect(speakingVerdicts([passed, failed])).toEqual([failed]);
    expect(speakingVerdicts([failed, passed])).toEqual([failed]);
    expect(foldVerdicts([passed, failed]).verdict).toBe("failed");
  });

  /**
   * And the pair the product is loudest about, decided the same way. `failed`
   * and `errored` are kept apart everywhere else because a broken judge is not
   * a broken agent — but that rule is about never calling an `errored` row a
   * failure, not about letting one hide a failure. A dead heat resolves to the
   * failure, which is what the same two rows fold to over any other set.
   */
  it("prefers a failure over a broken judge in a dead heat", () => {
    const errored = row({
      ...assertion,
      verdict: "errored",
      judgedAtMicroseconds: 1_000n,
    });
    const failed = row({
      ...assertion,
      verdict: "failed",
      judgedAtMicroseconds: 1_000n,
    });

    expect(speakingVerdicts([errored, failed])).toEqual([failed]);
    expect(speakingVerdicts([failed, errored])).toEqual([failed]);
    expect(foldVerdicts([errored, failed]).verdict).toBe("failed");
  });

  it("keeps two assertions apart even when everything else about them matches", () => {
    const rows = [
      row({ ...assertion, assertion: "behavior_1", verdict: "passed" }),
      row({ ...assertion, assertion: "behavior_2", verdict: "failed" }),
    ];
    expect(foldVerdicts(rows).counts.total).toBe(2);
  });

  it("keeps a simulation's judgment apart from a production conversation's", () => {
    const rows = [
      row({ ...assertion, source: "simulation", verdict: "passed" }),
      row({ ...assertion, source: "production", verdict: "failed" }),
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
  it("splits by grader without losing or inventing an assertion", () => {
    const draw = randomly(0x9e2a);
    for (let sweep = 0; sweep < 300; sweep += 1) {
      const rows = someRows(draw, 1 + Math.floor(draw() * 30));
      const whole = foldVerdicts(rows);
      const byGrader = foldVerdictsByGrader(rows, new Set<string>());

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

/* ------------------------------------------------------------------- *
 * The two lanes: what decides, and what only reports.
 * ------------------------------------------------------------------- */

/**
 * A `required: false` copy is a diagnostic. Its rows exist, its fraction is
 * reported, and nothing it says can reach an outcome.
 *
 * The split is a function of its own rather than a branch inside the fold, so
 * what is asserted here are properties of the split and of the fold over each
 * half — which is exactly how the read path uses them.
 */
describe("the lane a verdict is in", () => {
  const REQUIRED = "grader-1";
  const DIAGNOSTIC = "grader-2";
  const onlyReports = new Set([DIAGNOSTIC]);
  /**
   * A caller that genuinely knows of no diagnostic copy, said out loud.
   *
   * It was the default value of the argument and is a named constant here
   * instead, because the answer it gives — *everything gates* — is the one a
   * caller must never receive for having forgotten to ask.
   */
  const NOTHING_ONLY_REPORTS: ReadonlySet<string> = new Set<string>();

  /** Everything decides when nothing was named a diagnostic. */
  it("is required for every grader when no diagnostic is named", () => {
    const draw = randomly(0x5b11);
    for (let sweep = 0; sweep < 200; sweep += 1) {
      const rows = someRows(draw, 1 + Math.floor(draw() * 20));
      const lanes = verdictLanes(rows, NOTHING_ONLY_REPORTS);

      expect(lanes.required).toEqual(rows);
      expect(lanes.diagnostic).toEqual([]);
      // And an empty set keeps `foldVerdicts` meaning exactly what it meant.
      expect(foldVerdicts(lanes.required)).toEqual(foldVerdicts(rows));
    }
  });

  /** Every row lands in exactly one lane, and neither lane is reordered. */
  it("puts every row in exactly one lane, in the order it arrived", () => {
    const draw = randomly(0x2f7c);
    for (let sweep = 0; sweep < 200; sweep += 1) {
      const rows = someRows(draw, 1 + Math.floor(draw() * 20));
      const lanes = verdictLanes(rows, onlyReports);

      expect(lanes.required.length + lanes.diagnostic.length).toBe(rows.length);
      expect(lanes.required).toEqual(
        rows.filter((one) => one.graderId !== DIAGNOSTIC),
      );
      expect(lanes.diagnostic).toEqual(
        rows.filter((one) => one.graderId === DIAGNOSTIC),
      );
    }
  });

  /**
   * The rule the whole flag exists for. A diagnostic failing every assertion it
   * has cannot move the answer by one word or one digit.
   */
  it("lets nothing a diagnostic said reach the outcome", () => {
    const decided = [
      row({ graderId: REQUIRED, assertion: "behavior_1", verdict: "passed" }),
      row({ graderId: REQUIRED, assertion: "behavior_2", verdict: "passed" }),
    ];
    const reported = [
      row({ graderId: DIAGNOSTIC, assertion: "behavior_1", verdict: "failed" }),
      row({ graderId: DIAGNOSTIC, assertion: "behavior_2", verdict: "errored" }),
    ];

    const alone = foldVerdicts(decided);
    const beside = foldVerdicts(
      verdictLanes([...decided, ...reported], onlyReports).required,
    );

    expect(beside).toEqual(alone);
    expect(beside.verdict).toBe("passed");

    // And folded together — which is what would happen if the lane were
    // forgotten — the same rows say the opposite.
    expect(foldVerdicts([...decided, ...reported]).verdict).toBe("failed");
  });

  /** The other way round: a required failure is not softened by a green diagnostic. */
  it("lets a required failure fail, whatever the diagnostics say", () => {
    const rows = [
      row({ graderId: REQUIRED, assertion: "behavior_1", verdict: "failed" }),
      row({ graderId: DIAGNOSTIC, assertion: "behavior_1", verdict: "passed" }),
      row({ graderId: DIAGNOSTIC, assertion: "behavior_2", verdict: "passed" }),
    ];

    const lanes = verdictLanes(rows, onlyReports);
    expect(foldVerdicts(lanes.required).verdict).toBe("failed");
    expect(foldVerdicts(lanes.diagnostic).verdict).toBe("passed");
  });

  /**
   * A conversation judged by diagnostics alone has earned no green tick: there
   * was nothing that decides, so the required lane is empty and `skipped` is
   * precisely what happened.
   */
  it("answers skipped where only diagnostics judged", () => {
    const rows = [
      row({ graderId: DIAGNOSTIC, assertion: "behavior_1", verdict: "passed" }),
    ];
    const lanes = verdictLanes(rows, onlyReports);

    expect(foldVerdicts(lanes.required).verdict).toBe("skipped");
    expect(foldVerdicts(lanes.required).score).toBeUndefined();
    expect(foldVerdicts(lanes.diagnostic).score).toBe(1);
  });

  /**
   * The per-grader fold keeps every grader, both lanes, and says which lane each
   * is in — because a diagnostic's fraction is the whole reason it was switched
   * on, and a list that dropped it would make it judge in silence.
   */
  it("reports every grader's fraction, marking which of them only report", () => {
    const rows = [
      row({ graderId: REQUIRED, assertion: "behavior_1", verdict: "passed" }),
      row({ graderId: DIAGNOSTIC, assertion: "behavior_1", verdict: "failed" }),
      row({ graderId: DIAGNOSTIC, assertion: "behavior_2", verdict: "passed" }),
    ];

    expect(foldVerdictsByGrader(rows, onlyReports)).toEqual([
      {
        graderId: REQUIRED,
        required: true,
        outcome: foldVerdicts([rows[0] as FoldableVerdict]),
      },
      {
        graderId: DIAGNOSTIC,
        required: false,
        outcome: foldVerdicts(rows.slice(1)),
      },
    ]);
  });

  /** A grader nobody named a diagnostic decides — the safe direction. */
  it("treats a grader it has never heard of as one that decides", () => {
    const rows = [row({ graderId: "grader-nobody-knows", verdict: "failed" })];

    expect(verdictLanes(rows, onlyReports).required).toEqual(rows);
    expect(foldVerdicts(verdictLanes(rows, onlyReports).required).verdict).toBe(
      "failed",
    );
    expect(foldVerdictsByGrader(rows, onlyReports)[0]?.required).toBe(true);
  });

  /**
   * Splitting first and folding each half is the same arithmetic as folding the
   * whole: the two lanes' counts add up to the counts over everything, on any
   * pile the sweep produces. That is what makes a page's two headings incapable
   * of disagreeing with the rows under them.
   */
  it("loses and invents nothing: the two lanes' counts are the whole", () => {
    const draw = randomly(0x11ac);
    for (let sweep = 0; sweep < 300; sweep += 1) {
      const rows = someRows(draw, 1 + Math.floor(draw() * 30));
      const lanes = verdictLanes(rows, onlyReports);
      const whole = foldVerdicts(rows);
      const decided = foldVerdicts(lanes.required);
      const reported = foldVerdicts(lanes.diagnostic);

      for (const word of [
        "passed",
        "failed",
        "skipped",
        "errored",
        "total",
      ] as const) {
        expect(whole.counts[word]).toBe(
          decided.counts[word] + reported.counts[word],
        );
      }
    }
  });
});
