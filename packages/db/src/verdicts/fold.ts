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
 *
 * **Which rows decide.** A running copy carries `required`, and `false` makes it
 * a **diagnostic**: it is judged exactly as a blocking copy is, writes exactly
 * the same rows, and reports its own fraction — and it can never fail a test or
 * a run. So the rows arrive in two lanes, split by `verdictLanes` before
 * anything is folded, and the answer is the fold over the required lane alone.
 * A diagnostic that could move the headline would not be a diagnostic; a
 * diagnostic whose rows were never written would diagnose nothing.
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
  /**
   * Whether this grader's rows can fail anything — the copy's `required` flag as
   * it stands, not as it stood when the judgment was made.
   *
   * Live rather than pinned on purpose. Turning a blocker into a diagnostic
   * changes nothing about any judgment already made; it changes what the project
   * lets a failure do, and that answer has to be the one in force at the moment
   * somebody reads the page. It is the same reason the flag lives on the copy
   * rather than on its versions.
   */
  readonly required: boolean;
  readonly outcome: FoldedOutcome;
};

/* ------------------------------------------------------------------- *
 * Which rows decide, and which only report.
 * ------------------------------------------------------------------- */

/**
 * The running copies that only report, by id: every `required: false` one.
 *
 * **Named by exception, so the safe answer is the default.** A grader this set
 * has never heard of is required, which is what an empty set means and what
 * keeps `foldVerdicts` over a bare pile of rows meaning what it always meant. A
 * set of the *blocking* ones would have the opposite failure mode: a grader
 * missing from it — deleted since, unreadable, forgotten by a caller — would
 * quietly stop being able to fail anything, and a check nobody can fail is the
 * exact false trust this product exists to kill.
 */
export type Diagnostics = ReadonlySet<string>;

/** The rows of one grain, in the two lanes they are folded in. */
export type VerdictLanes<Row extends FoldableVerdict> = {
  /** From copies that can fail a test. Folding these is the answer. */
  readonly required: readonly Row[];
  /** From copies that only report. Folding these decides nothing. */
  readonly diagnostic: readonly Row[];
};

/**
 * The rows split by whether the copy that wrote them can fail anything.
 *
 * **The split happens before the fold rather than inside it**, so that the one
 * algebra stays one algebra: `foldVerdicts` answers about whatever pile it is
 * handed and never asks whose rows they are, and every question about `required`
 * is settled here, once, in the one place a reader has to look.
 *
 * **`diagnostics` is required, and it used to have a default of the empty set.**
 * An empty set means *everything gates*, so the default was the answer a caller
 * got for forgetting to ask — and a read path written after the flag existed
 * would compile, pass every test, and quietly fold a diagnostic's failure into
 * the headline. That is precisely what happened on one of the three read paths
 * that fold a run: run history said `failed` about a run whose own page said
 * `passed`, the moment anybody switched on a `required: false` copy. A caller
 * that genuinely knows of no diagnostic copy passes an empty set and says so.
 *
 * Both lanes come back in the order they arrived, so what counted can be shown
 * beside what exists without either being reordered.
 */
export function verdictLanes<Row extends FoldableVerdict>(
  rows: readonly Row[],
  diagnostics: Diagnostics,
): VerdictLanes<Row> {
  const required: Row[] = [];
  const diagnostic: Row[] = [];

  for (const row of rows) {
    (diagnostics.has(row.graderId) ? diagnostic : required).push(row);
  }

  return { required, diagnostic };
}

/* ------------------------------------------------------------------- *
 * Who speaks for a judged assertion.
 * ------------------------------------------------------------------- */

/**
 * The assertion a row is about, as a key that cannot be collided into.
 *
 * Deliberately **not** the storage identity: that one also spans the grader
 * version, so production judgments made under different current versions stay
 * distinct. What the fold counts is the assertion, once, whatever number of
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
 * How seriously a word is taken when nothing else can tell two rows apart.
 *
 * Higher wins, and the order is the fold's own precedence rule said one row at a
 * time: a failure outranks a broken judge, which outranks a check that did not
 * apply, which outranks a pass.
 *
 * `failed` over `errored` is the pair that matters most and it is not
 * arbitrary. The two are kept apart everywhere else because a broken judge is
 * not a broken agent — but that is a rule about not calling an `errored` row a
 * failure, never about letting an `errored` row hide one. A conversation where
 * the agent failed *and* the judging broke did fail, and `foldVerdicts` says so
 * over the whole set; a tie broken the other way would let the same set answer
 * `errored` because of which row a merge happened to keep.
 */
const SERIOUSNESS: { readonly [Word in Verdict]: number } = {
  failed: 3,
  errored: 2,
  skipped: 1,
  passed: 0,
};

/**
 * Which of two rows is later, decided the same way whatever order they arrived
 * in.
 *
 * The clock first, then the grader version, then how serious the word is —
 * three total orders in sequence, so two rows are never "equally late" unless
 * they say the same thing. Without the tiebreaks the answer would depend on
 * input order, and a fold whose answer depends on the order rows came back in is
 * one that changes its mind between two reads of the same data.
 *
 * The last tiebreak is reached only by two rows the **store** cannot tell apart
 * either: same identity, same clock, so the engine that keeps the later one is
 * free to keep whichever it merged last. The fold cannot be more decided than
 * the table underneath it, so what it can be is consistent — and it breaks the
 * tie towards the more serious word, because the alternative is a green tick
 * that arrived by luck, or a failure hidden behind a broken judge for the same
 * reason.
 */
function isLater(row: FoldableVerdict, than: FoldableVerdict): boolean {
  if (row.judgedAtMicroseconds !== than.judgedAtMicroseconds) {
    return row.judgedAtMicroseconds > than.judgedAtMicroseconds;
  }
  if (row.graderVersionId !== than.graderVersionId) {
    return row.graderVersionId > than.graderVersionId;
  }
  return SERIOUSNESS[row.verdict] > SERIOUSNESS[than.verdict];
}

/**
 * The rows that count, one per judged assertion, in the order they were handed
 * over.
 *
 * **The newest grading speaks.** Production re-grading can use a new current
 * grader version and write beside the old row. Counting both would score one
 * assertion twice. The newest is decided by the clock, so nothing here has to
 * understand version identifiers to know which came second. A simulation
 * re-grade stays on its run-pinned version and replaces that version's row.
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
 * **Every grader is here, diagnostics included.** A diagnostic's fraction is the
 * whole reason somebody switched it on, so leaving it out of this list would
 * make it a check that judges in silence. Each entry says which lane it is in
 * instead, and a reader shows the two apart rather than adding them up.
 *
 * Graders come back in id order, which is arbitrary and deterministic — the
 * order to show them in is the authored one, and that lives with the graders
 * rather than with their verdicts.
 */
export function foldVerdictsByGrader(
  rows: readonly FoldableVerdict[],
  diagnostics: Diagnostics,
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
      required: !diagnostics.has(graderId),
      outcome: foldVerdicts(graderRows),
    }));
}
