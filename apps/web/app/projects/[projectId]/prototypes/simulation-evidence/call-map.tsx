"use client";

import { SimulationEvidenceReview } from "../../../../../ui/simulation-evidence-review.tsx";
import { type VariantProps } from "./shared.tsx";
import styles from "./prototype.module.css";

/** The candidate promoted to production: graders beside audio and transcript. */
export function CallMap({ evidence, recording }: VariantProps) {
  return (
    <div className={styles.variant}>
      <SimulationEvidenceReview evidence={evidence} recording={recording} />
    </div>
  );
}
