/**
 * The fold: how a pile of verdict rows becomes one answer.
 *
 * **No overall row is written anywhere, ever.** A simulation's outcome, a run's
 * outcome and one grader's outcome are all the same computation over the rows
 * beneath them, done at read time, in this file and in no other. That is the
 * whole reason the algebra lives in a pure function rather than in a query: a
 * stored headline can come to disagree with the evidence under it, and a
 * headline that is only ever derived cannot.
 *
 * It touches no store, takes no `AuthContext`, and is exported from the
 * package's entry point rather than from the data-access surface for exactly
 * that reason — it is handed rows a caller already holds and can reach nothing.
 *
 * Three rules, and they are the product's own words:
 *
 * **The word, and it is strictly binary.** Every assertion has to pass. Any
 * `failed` makes the whole thing failed; otherwise any `errored` makes it
 * errored; otherwise it passed. `skipped` and `errored` are load-bearing and are
 * never collapsed into `failed` — a test that could not run is not a test that
 * failed, and a check that did not apply did not fail either. There is no
 * threshold anywhere for a fraction to be judged against, and no priority for a
 * failure to hide behind: a lower bar is a thing the product does not have. The
 * one case that rule does not reach is a set where *nothing* was scored, and
 * that one is `skipped`: nothing judged has earned no green tick.
 *
 * **The number, which diagnoses and never decides.** Score is passed divided by
 * total minus skipped. An assertion nobody could score is out of the denominator
 * rather than counted against anybody. `errored` deliberately stays in it: the
 * distinction between a broken agent and a broken test is carried by the word,
 * and the number stays a plain proportion of what was actually judged. An empty
 * denominator has no score at all rather than a made-up one. The per-grader
 * fraction beside it is what says *which* check is going wrong and how badly —
 * τ2-bench's reward breakdown — and nothing in v0 reads it to decide anything.
 *
 * **Who speaks.** One judged assertion may have several rows — an older grading
 * and a newer one — and exactly one of them counts. The rest stay in the record,
 * underneath, which is what makes them worth keeping at all.
 */

/** What a grader can say about one assertion. */
export type Verdict = "passed" | "failed" | "skipped" | "errored";

/** The four, in the order a person recites them. */
export const VERDICTS: readonly Verdict[] = [
  "passed",
  "failed",
  "skipped",
  "errored",
];

/**
 * Where the judged conversation came from — the same word `spans.source`
 * carries, because a simulation and a production conversation are compared
 * against each other and a word that meant two things would make that
 * impossible.
 */
export type VerdictSource = "simulation" | "production";

/**
 * What the fold reads off a row, and nothing else it happens to carry.
 *
 * Structural rather than the stored row type, so that the read path's rows and a
 * test's hand-built ones are the same input, and so that adding a column to the
 * table is not a change to the algebra.
 */
export type FoldableVerdict = {
  readonly traceId: string;
  readonly graderId: string;
  readonly graderVersionId: string;
  /**
   * Which 0-or-1 check inside the grader this row answers, as its **key**: the
   * behavior's position in the pinned test version, the config entry's index.
   * Opaque here — the grader names its own assertions and the fold only ever
   * compares them for equality.
   */
  readonly assertion: string;
  readonly source: VerdictSource;
  readonly verdict: Verdict;
  /** When the judgment was made, in microseconds since the epoch. */
  readonly judgedAtMicroseconds: bigint;
};

export type VerdictCounts = {
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly errored: number;
  /** Every judged assertion that counts, skipped ones included. */
  readonly total: number;
};

export type FoldedOutcome = {
  readonly verdict: Verdict;
  /**
   * Passed over total minus skipped, or **absent** when there is nothing in the
   * denominator.
   *
   * A proportion of nothing is not a number, and both available lies are worse
   * than saying so: 1 because nothing failed reads as a clean sweep nobody
   * earned, and 0 because nothing passed reads as a broken agent. So it is
   * absent, and a caller renders that as "not scored" rather than as a figure.
   */
  readonly score: number | undefined;
  readonly counts: VerdictCounts;
};

export type GraderOutcome = {
  readonly graderId: string;
  readonly outcome: FoldedOutcome;
};

/* ------------------------------------------------------------------- *
 * Who speaks for a judged assertion.
 * ------------------------------------------------------------------- */

/**
 * The assertion a row is about, as a key that cannot be collided into.
 *
 * Deliberately **not** the storage identity: that one also spans the grader
 * version, because that is what makes a re-grade a second row rather than an
 * overwrite. What the fold counts is the assertion, once, whatever number of
 * rows have accumulated against it.
 *
 * `JSON.stringify` of the tuple rather than a joined string, because a grader
 * names its own assertions and any separator picked here would be a separator an
 * assertion key is one day allowed to contain.
 */
function assertionKey(row: FoldableVerdict): string {
  return JSON.stringify([row.traceId, row.graderId, row.assertion, row.source]);
}

/**
 * Which of two rows is later, decided the same way whatever order they arrived
 * in.
 *
 * The clock first, then the grader version — two total orders in sequence, so
 * two rows are never "equally late" unless they are the same row. Without the
 * tiebreak the answer would depend on input order, and a fold whose answer
 * depends on the order rows came back in is one that changes its mind between
 * two reads of the same data.
 */
function isLater(row: FoldableVerdict, than: FoldableVerdict): boolean {
  if (row.judgedAtMicroseconds !== than.judgedAtMicroseconds) {
    return row.judgedAtMicroseconds > than.judgedAtMicroseconds;
  }
  return row.graderVersionId > than.graderVersionId;
}

/**
 * The rows that count, one per judged assertion, in the order they were handed
 * over.
 *
 * **The newest grading speaks.** Re-grading at a new grader version writes rows
 * beside the old ones rather than over them, so both are here; counting both
 * would score one assertion twice and would leave a grader's old mistake failing
 * a run forever. The newest is decided by the clock — a re-grade happens after
 * the grading it supersedes, so nothing here has to understand version
 * identifiers to know which came second.
 *
 * There is exactly one voice per grading now. A person disagreeing with a
 * judgment is not a second row on the machine's identity — corrections return as
 * the reserved `human` grader type, writing rows under a grader id of their own,
 * which this function folds beside the machine's the way it folds any other
 * grader's.
 *
 * Generic in the row so a caller gets its own rows back rather than a projection
 * of them, and stable so that "which rows count" can be shown beside "which rows
 * exist" without either being reordered.
 */
export function speakingVerdicts<Row extends FoldableVerdict>(
  rows: readonly Row[],
): readonly Row[] {
  // Positions rather than rows, so that a row which is the same object as
  // another — the same array handed over twice, say — takes one place and not
  // two, and so that what comes back comes back in the order it arrived in.
  const spoke = new Map<string, { readonly row: Row; readonly at: number }>();

  rows.forEach((row, at) => {
    const key = assertionKey(row);
    const held = spoke.get(key);
    if (held === undefined || isLater(row, held.row)) spoke.set(key, { row, at });
  });

  return [...spoke.values()]
    .sort((left, right) => left.at - right.at)
    .map(({ row }) => row);
}

/* ------------------------------------------------------------------- *
 * The fold itself.
 * ------------------------------------------------------------------- */

/**
 * One answer from any number of rows, at any grain.
 *
 * The grain is whatever the caller handed over and this function never asks:
 * one trace's rows fold to a simulation's outcome, a run's traces fold to the
 * run's, one grader's rows fold to that grader's. That works because
 * supersession is decided inside a single trace's assertions, so folding a run
 * whole and folding each of its simulations and adding the counts up are the
 * same arithmetic — which is what makes a run header and the rows on the page
 * beneath it incapable of disagreeing.
 *
 * Rows that do not count are ignored rather than refused: a caller may hand over
 * everything the read returned, superseded rows included, and does not have to
 * know which is which.
 */
export function foldVerdicts(rows: readonly FoldableVerdict[]): FoldedOutcome {
  const counts = { passed: 0, failed: 0, skipped: 0, errored: 0, total: 0 };

  for (const row of speakingVerdicts(rows)) {
    counts[row.verdict] += 1;
    counts.total += 1;
  }

  const scored = counts.total - counts.skipped;

  return {
    // Nothing scored is not a pass. A run where every check was inapplicable,
    // or one that has not been graded yet, has earned no green tick — so the
    // word is `skipped`, which is precisely what happened, and the precedence
    // rule above applies only once something was actually judged.
    verdict:
      counts.failed > 0
        ? "failed"
        : counts.errored > 0
          ? "errored"
          : scored > 0
            ? "passed"
            : "skipped",
    score: scored === 0 ? undefined : counts.passed / scored,
    counts,
  };
}

/**
 * The same answer per grader, so a page can say which check failed rather than
 * only that something did — and with which fraction of its assertions passed,
 * which is the diagnosis binary scoring would otherwise throw away.
 *
 * Graders come back in id order, which is arbitrary and deterministic — the
 * order to show them in is the authored one, and that lives with the graders
 * rather than with their verdicts.
 */
export function foldVerdictsByGrader(
  rows: readonly FoldableVerdict[],
): readonly GraderOutcome[] {
  const byGrader = new Map<string, FoldableVerdict[]>();
  for (const row of rows) {
    const held = byGrader.get(row.graderId);
    if (held === undefined) byGrader.set(row.graderId, [row]);
    else held.push(row);
  }

  return [...byGrader.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([graderId, graderRows]) => ({
      graderId,
      outcome: foldVerdicts(graderRows),
    }));
}
