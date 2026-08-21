import type {
  AssertionWords,
  FoldedOutcome,
  GraderOutcome,
  RecordedVerdict,
} from "@egma/db";

/**
 * How a judgment and the answers folded from it cross the wire.
 *
 * **Two surfaces draw the same judgment card** — a run's results and one
 * transcript — and the shape it reads is decided here rather than twice. A
 * projection written out at each door was two chances for one of them to answer
 * a field the other does not, and the field that would have gone missing is
 * exactly the one that says whether a red card means anything: a diagnostic
 * copy's failure rendered unmarked, under a header folded without it, is the
 * headline disagreeing with the evidence beneath it — which is the one thing
 * read-time folding exists to prevent.
 */

/**
 * One folded answer, or null where there is none.
 *
 * Used at three grains — a run, one conversation, and the diagnostic lane of
 * either — so a reader that learned the three keys once has learned them
 * everywhere.
 */
export function describedOutcome(
  outcome: FoldedOutcome | undefined,
): Record<string, unknown> | null {
  if (outcome === undefined) return null;
  return {
    verdict: outcome.verdict,
    score: outcome.score ?? null,
    counts: outcome.counts,
  };
}

/**
 * Which of the graders that judged only report, off the per-grader fold rather
 * than read a second time.
 *
 * One answer about `required`, taken where the lanes were actually split, so a
 * row's marking and the header's arithmetic cannot disagree.
 *
 * **A grader absent from the fold it was derived from is required**, which is
 * the safe direction and the same one the store-side read takes. It happens on
 * a run's page: the run fold covers every row of the run, and a conversation's
 * rows are a subset of those, so a row present in one and absent from the other
 * is a race rather than a state — and a check that quietly stopped being able to
 * fail anything is worse than one marked required for a moment too long.
 */
export function onlyReporting(
  byGrader: readonly GraderOutcome[] | undefined,
): ReadonlySet<string> {
  return new Set(
    (byGrader ?? []).filter((its) => !its.required).map((its) => its.graderId),
  );
}

/**
 * One judged assertion as every read of one describes it.
 *
 * **`assertion` is the key the store keeps, and `assertionText` is what a
 * person reads.** The key is a behavior's position in the pinned test version,
 * or the identifier of the entry a whole-grader check names; the words behind it
 * are fetched from that pinned version at display time, because a row keyed by
 * content would make an edited sentence a second assertion counted beside the
 * first forever. Both are sent: the key is what a client filters and groups by,
 * and the text is what it shows. A key nothing can place carries `null` and is
 * shown as itself rather than as a guess.
 *
 * **`required` says which lane the row is in**, so a card can mark a diagnostic
 * without going and matching grader ids against a list somewhere else on the
 * page.
 */
export function describedVerdict(
  its: RecordedVerdict,
  words: AssertionWords | undefined,
  diagnostic: ReadonlySet<string>,
): Record<string, unknown> {
  return {
    graderId: its.graderId,
    assertion: its.assertion,
    assertionText: words?.of(its.graderId, its.assertion) ?? null,
    required: !diagnostic.has(its.graderId),
    verdict: its.verdict,
    score: its.score,
    rationale: its.rationale,
    citedTurns: [...its.citedSpanIds],
    judgedAt: its.judgedAt,
  };
}
