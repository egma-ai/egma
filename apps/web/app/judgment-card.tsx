import { GRADING } from "../lib/grading-copy.ts";
import { DETAIL } from "../lib/transcript-copy.ts";
import { assertionHeading, type Judgment } from "../lib/transcripts.ts";
import styles from "./ui.module.css";

/**
 * One judged assertion, as a person reads it.
 *
 * **The heading is the sentence somebody wrote**, resolved by the read from the
 * version this conversation was executed against — not the key the row is filed
 * under. A verdict row keeps a key because the fold counts one assertion once
 * and a key derived from content would make an edited sentence a second
 * assertion; the words are fetched back at display time, which is here. Where
 * nothing could place a key the key is shown as itself, because a plausible
 * wrong sentence is worse than a terse right one.
 *
 * **A diagnostic says so.** A copy carrying `required: false` reports and never
 * decides, so its judgment is marked rather than left to read as a failure that
 * somehow did not count. Nothing is marked on the ordinary case: a blocking
 * grader is what a grader is.
 */
export function JudgmentCard({
  judgment,
  placement = "inline",
}: {
  judgment: Judgment;
  placement?: "inline" | "result";
}) {
  const cited =
    placement === "inline" || judgment.cited_turns.length === 0
      ? ""
      : judgment.cited_turns.join(", ");
  const diagnostic = judgment.required === false;

  return (
    <article
      className={placement === "result" ? styles.runJudgment : styles.judgmentCard}
      data-verdict={judgment.verdict}
      data-lane={diagnostic ? "diagnostic" : undefined}
    >
      <div className={styles.judgmentHeading}>
        <span className={styles.verdictChip}>{judgment.verdict}</span>
        <strong>{assertionHeading(judgment)}</strong>
        {diagnostic ? (
          <span className={styles.laneChip} title={GRADING.diagnosticMeans}>
            {GRADING.diagnostic}
          </span>
        ) : null}
      </div>
      <p>{judgment.rationale}</p>
      {cited === "" ? null : (
        <small>
          {DETAIL.citedTurns} <span className={styles.mono}>{cited}</span>
        </small>
      )}
    </article>
  );
}
