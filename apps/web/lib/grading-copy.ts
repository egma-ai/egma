/**
 * Every word the judgment card says out loud, in one file.
 *
 * It is here rather than in `transcript-copy.ts` because the card is drawn on
 * **two** surfaces — one transcript, and a run's results — and copy named after
 * one of them would be copy the other borrowed. What both need is the same:
 * words for the two lanes a verdict lands in.
 *
 * Collecting it is not tidiness. It is what makes the vocabulary **checkable**:
 * the same test that holds the transcript pages' words against the banned list
 * reads this file too, so a word that should never have been typed fails the
 * build rather than shipping in a heading. Any string the card renders belongs
 * in here.
 *
 * The card itself is deliberately quiet about the ordinary case. A blocking
 * grader is what a grader is, so nothing marks one; only the lane that cannot
 * fail anything says so, because that is the fact a reader cannot get from the
 * verdict word in front of them.
 */
export const GRADING = {
  /** On one judgment from a copy that only reports. */
  diagnostic: "Diagnostic",
  /** What that marker means, where there is room to say it. */
  diagnosticMeans: "Reported only. This grader can never fail a test or a run.",
  /** The heading over the lane, where a whole run's worth is shown together. */
  diagnosticLane: "Diagnostics",
  diagnosticLaneLead: "Judged and reported. Nothing here can fail this run.",
} as const;
