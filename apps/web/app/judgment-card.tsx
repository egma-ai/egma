import { humanizeIdentifier, type Judgment } from "../lib/transcripts.ts";
import styles from "./ui.module.css";

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

  return (
    <article
      className={placement === "result" ? styles.runJudgment : styles.judgmentCard}
      data-verdict={judgment.verdict}
    >
      <div className={styles.judgmentHeading}>
        <span className={styles.verdictChip}>{judgment.verdict}</span>
        <strong>{humanizeIdentifier(judgment.assertion)}</strong>
      </div>
      <p>{judgment.rationale}</p>
      {cited === "" ? null : <small>{cited}</small>}
    </article>
  );
}
