import { DETAIL } from "../lib/transcript-copy.ts";
import { humanizeIdentifier, type Judgment } from "../lib/transcripts.ts";
import styles from "./ui.module.css";

export function JudgmentCard({
  judgment,
  placement = "inline",
}: {
  judgment: Judgment;
  placement?: "inline" | "result";
}) {
  return (
    <article
      className={placement === "result" ? styles.runJudgment : styles.judgmentCard}
      data-verdict={judgment.verdict}
    >
      <div className={styles.judgmentHeading}>
        <span className={styles.verdictChip}>{judgment.verdict}</span>
        <strong>{humanizeIdentifier(judgment.dimension)}</strong>
        <span>{judgment.priority}</span>
      </div>
      <p>{judgment.rationale}</p>
      <small>
        {DETAIL.judgedBy} <span className={styles.mono}>{judgment.judged_by}</span>
        {placement === "inline" || judgment.cited_turns.length === 0
          ? ""
          : ` · ${judgment.cited_turns.join(", ")}`}
      </small>
    </article>
  );
}
