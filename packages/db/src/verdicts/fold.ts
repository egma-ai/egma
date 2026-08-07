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
 * **The word.** Any `failed` makes the whole thing failed; otherwise any
 * `errored` makes it errored; otherwise it passed. `skipped` and `errored` are
 * load-bearing and are never collapsed into `failed` — a test that could not run
 * is not a test that failed, and a check that did not apply did not fail either.
 * The one case that rule does not reach is a set where *nothing* was scored, and
 * that one is `skipped`: nothing judged has earned no green tick.
 *
 * **The number.** Score is passed divided by total minus skipped. A dimension
 * nobody could score is out of the denominator rather than counted against
 * anybody. `errored` deliberately stays in it: the distinction between a broken
 * agent and a broken test is carried by the word, and the number stays a plain
 * proportion of what was actually judged. An empty denominator has no score at
 * all rather than a made-up one.
 *
 * **Who speaks.** One judged dimension may have several rows — an older grading
 * and a newer one, a machine's judgment and a human's disagreement with it — and
 * exactly one of them counts. The rest stay in the record, underneath, which is
 * what makes them worth keeping at all.
 */

/** What a grader can say about one dimension. */
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
 * What a grader's priority was **at the moment of judging**. Snapshotted onto
 * the row rather than read from the grader now, so promoting a check to P0
 * today does not reinterpret yesterday's warnings.
 *
 * The fold does not read it, on purpose. Asking "did every P0 pass" is asking
 * the same question of a smaller set of rows, so it is `foldVerdicts` over the
 * P0 rows rather than a second answer this function has to carry — and that
 * keeps the one place the algebra lives from growing a second algebra beside it.
 */
export type Priority = "P0" | "P1" | "P2";

export const PRIORITIES: readonly Priority[] = ["P0", "P1", "P2"];

/**
 * The one `judged_by` value the fold treats specially.
 *
 * Everything else in that column names a machine — a judge model, or `engine`
 * for the deterministic graders that need no model at all. A person disagreeing
 * with a verdict writes a row of their own beside it rather than editing it, and
 * this is the word that says so.
 */
export const JUDGED_BY_HUMAN = "human";

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
   * What inside the grader was judged: one expected behavior, or the single
   * check a one-check grader makes. Opaque here — the grader names its own
   * dimensions and the fold only ever compares them for equality.
   */
  readonly dimension: string;
  readonly source: VerdictSource;
  /** A judge model, `engine`, or `human`. */
  readonly judgedBy: string;
  readonly verdict: Verdict;
  /** When the judgment was made, in microseconds since the epoch. */
  readonly judgedAtMicroseconds: bigint;
};

export type VerdictCounts = {
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly errored: number;
  /** Every judged dimension that counts, skipped ones included. */
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
 * Who speaks for a judged dimension.
 * ------------------------------------------------------------------- */

/**
 * The dimension a row is about, as a key that cannot be collided into.
 *
 * Deliberately **not** the storage identity: that one also spans the grader
 * version and who judged, because those are what make a re-grade a second row
 * rather than an overwrite. What the fold counts is the dimension, once,
 * whatever number of rows have accumulated against it.
 *
 * `JSON.stringify` of the tuple rather than a joined string, because a grader
 * names its own dimensions and any separator picked here would be a separator a
 * dimension name is one day allowed to contain.
 */
function dimensionKey(row: FoldableVerdict): string {
  return JSON.stringify([row.traceId, row.graderId, row.dimension, row.source]);
}

/**
 * Which of two rows is later, decided the same way whatever order they arrived
 * in.
 *
 * The clock first, then the grader version, then who judged — three total
 * orders in sequence, so two rows are never "equally late" unless they are the
 * same row. Without the tiebreaks the answer would depend on input order, and a
 * fold whose answer depends on the order rows came back in is one that changes
 * its mind between two reads of the same data.
 */
function isLater(row: FoldableVerdict, than: FoldableVerdict): boolean {
  if (row.judgedAtMicroseconds !== than.judgedAtMicroseconds) {
    return row.judgedAtMicroseconds > than.judgedAtMicroseconds;
  }
  if (row.graderVersionId !== than.graderVersionId) {
    return row.graderVersionId > than.graderVersionId;
  }
  return row.judgedBy > than.judgedBy;
}

function isHuman(row: FoldableVerdict): boolean {
  return row.judgedBy === JUDGED_BY_HUMAN;
}

/**
 * The rows that count, one per judged dimension, in the order they were handed
 * over.
 *
 * Two supersessions, applied in this order, and the order is the decision:
 *
 * **The newest grading speaks.** Re-grading at a new grader version writes rows
 * beside the old ones rather than over them, so both are here; counting both
 * would score one dimension twice and would leave a grader's old mistake failing
 * a run forever. The newest is decided by the clock on the machine's rows — a
 * grading is something the engine did, and a re-grade happens after the grading
 * it supersedes, so nothing here has to understand version identifiers to know
 * which came second. A grading with no machine row at all falls back to its own
 * rows' clock, because this function must be total: it is handed whatever rows
 * exist, including a set somebody filtered.
 *
 * **Then the human's word wins.** Inside the grading that speaks, a
 * `judged_by: human` row supersedes the machine's. The machine's row is still in
 * the input, still returned by the read, and still on the table — it is simply
 * not counted, which is the difference between disagreeing with a judgment and
 * erasing it. Accumulated, those pairs are the ground truth a future measurement
 * of judge accuracy is made of.
 *
 * A human correcting an *older* grading therefore does not pull it back in front
 * of a newer one. Their word stands against the grading they read, which is the
 * only one they can have read.
 *
 * Generic in the row so a caller gets its own rows back rather than a projection
 * of them, and stable so that "which rows count" can be shown beside "which rows
 * exist" without either being reordered.
 */
export function speakingVerdicts<Row extends FoldableVerdict>(
  rows: readonly Row[],
): readonly Row[] {
  const dimensions = new Map<string, Map<string, Grading>>();

  // Positions rather than rows, so that a row which is the same object as
  // another — the same array handed over twice, say — takes one place and not
  // two, and so that what comes back comes back in the order it arrived in.
  rows.forEach((row, at) => {
    const key = dimensionKey(row);
    const gradings = dimensions.get(key) ?? new Map<string, Grading>();
    gradings.set(
      row.graderVersionId,
      standing(gradings.get(row.graderVersionId), { row, at }),
    );
    dimensions.set(key, gradings);
  });

  const spoke: number[] = [];
  for (const gradings of dimensions.values()) {
    let winner: Grading | undefined;
    for (const grading of gradings.values()) {
      winner = winner === undefined ? grading : theLaterOf(winner, grading);
    }
    const said =
      winner === undefined ? undefined : (winner.human ?? winner.machine);
    if (said !== undefined) spoke.push(said.at);
  }

  return spoke
    .sort((left, right) => left - right)
    .map((at) => rows[at])
    .filter((row): row is Row => row !== undefined);
}

/** One of a dimension's rows, and where in the input it was. */
type Standing = { readonly row: FoldableVerdict; readonly at: number };

/**
 * What is known about one grading of one dimension: the latest thing the machine
 * said, and the latest thing a person said about it. Either may be missing —
 * a grading nobody has disagreed with has no human row, and a set somebody
 * filtered may hold a correction whose machine row was left behind.
 */
type Grading = {
  readonly machine: Standing | undefined;
  readonly human: Standing | undefined;
};

/** This grading with that row folded into it, keeping the later of each voice. */
function standing(held: Grading | undefined, here: Standing): Grading {
  const later = (against: Standing | undefined): Standing =>
    against === undefined || isLater(here.row, against.row) ? here : against;

  return isHuman(here.row)
    ? { machine: held?.machine, human: later(held?.human) }
    : { machine: later(held?.machine), human: held?.human };
}

/**
 * Of two gradings of one dimension, the one that happened later — which is the
 * one whose **machine** row is later.
 *
 * A person never opens a grading, they answer one, so their row's clock says
 * when they disagreed rather than when the judging was done. Their row stands in
 * only for a grading whose machine row is not in this input at all.
 */
function theLaterOf(held: Grading, contender: Grading): Grading {
  const opened = (grading: Grading): Standing | undefined =>
    grading.machine ?? grading.human;

  const ours = opened(held);
  const theirs = opened(contender);
  if (theirs === undefined) return held;
  if (ours === undefined) return contender;
  return isLater(theirs.row, ours.row) ? contender : held;
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
 * supersession is decided inside a single trace's dimensions, so folding a run
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
 * only that something did.
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
