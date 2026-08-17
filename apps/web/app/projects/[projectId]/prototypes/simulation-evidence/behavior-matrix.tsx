"use client";

import { useState } from "react";

import {
  CriterionResult,
  Recording,
  Scenario,
  SummaryStrip,
  TranscriptRows,
  criteriaOf,
  type VariantProps,
} from "./shared.tsx";
import styles from "./prototype.module.css";

/** Criterion-first: programmed behavior and the judge's finding stay together. */
export function BehaviorMatrix({ evidence, recording }: VariantProps) {
  const criteria = criteriaOf(evidence);
  const [selected, setSelected] = useState(0);
  const active = criteria[selected] ?? null;

  return (
    <div className={styles.variant}>
      <SummaryStrip evidence={evidence} />
      <Scenario evidence={evidence} />
      <div className={styles.matrixLayout}>
        <section className={styles.panel} aria-labelledby="matrix-behaviors">
          <header className={styles.panelHead}>
            <div>
              <h2 id="matrix-behaviors">Expected behaviors</h2>
              <p>Select one to see the exact evidence the judge used.</p>
            </div>
          </header>
          {criteria.length === 0 ? (
            <p className={styles.quiet}>No expected behaviors were recorded.</p>
          ) : (
            <div className={styles.criteria}>
              {criteria.map((criterion, at) => (
                <article
                  className={`${styles.criterion} ${selected === at ? styles.criterionActive : ""}`}
                  key={criterion.key}
                >
                  <button
                    type="button"
                    aria-pressed={selected === at}
                    onClick={() => setSelected(at)}
                  >
                    <span className={styles.criterionNumber}>{String(at + 1).padStart(2, "0")}</span>
                    <strong>{criterion.expected}</strong>
                    <CriterionResult criterion={criterion} />
                  </button>
                  <div className={styles.finding}>
                    <span>{criterion.grader}</span>
                    <h3>Judge&apos;s finding</h3>
                    <p>{criterion.rationale ?? "This behavior has not been judged yet."}</p>
                    {criterion.citedTurns.length === 0 ? null : (
                      <p className={styles.citations}>
                        Evidence:{" "}
                        {criterion.citedTurns.map((turn, position) => (
                          <span key={turn}>
                            {position === 0 ? "" : ", "}
                            <a href={`#matrix-turn-${String(turn)}`}>turn {turn}</a>
                          </span>
                        ))}
                      </p>
                    )}
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>

        <section className={styles.panel} aria-labelledby="matrix-transcript">
          <header className={styles.panelHead}>
            <div>
              <h2 id="matrix-transcript">Call evidence</h2>
              <p>The full recording and transcript, with cited turns marked.</p>
            </div>
          </header>
          <Recording recording={recording} />
          <TranscriptRows
            evidence={evidence}
            highlighted={active?.citedTurns ?? []}
            idPrefix="matrix"
          />
        </section>
      </div>
    </div>
  );
}
