"use client";

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

/** Narrative-first: every decision reads as expected, found, then evidence. */
export function DecisionDossier({ evidence, recording }: VariantProps) {
  const criteria = criteriaOf(evidence);
  const turns = evidence.transcript?.turns ?? [];

  return (
    <div className={styles.variant}>
      <SummaryStrip evidence={evidence} />
      <Scenario evidence={evidence} />
      <Recording recording={recording} />

      <div className={styles.dossierLayout}>
        <nav className={styles.dossierIndex} aria-label="Expected behaviors">
          <span>In this review</span>
          {criteria.map((criterion, at) => (
            <a href={`#dossier-${String(at + 1)}`} key={criterion.key}>
              <span>{String(at + 1).padStart(2, "0")}</span>
              {criterion.expected}
            </a>
          ))}
          <a href="#dossier-transcript">
            <span>→</span>
            Full transcript
          </a>
        </nav>

        <div className={styles.dossier}>
          {criteria.map((criterion, at) => {
            const cited = criterion.citedTurns
              .map((turn) => ({ position: turn, step: turns[turn - 1] }))
              .filter(
                (one): one is { readonly position: number; readonly step: NonNullable<typeof one.step> } =>
                  one.step !== undefined,
              );
            return (
              <article id={`dossier-${String(at + 1)}`} key={criterion.key}>
                <header>
                  <div>
                    <span>Behavior {String(at + 1).padStart(2, "0")}</span>
                    <h2>{criterion.expected}</h2>
                  </div>
                  <CriterionResult criterion={criterion} />
                </header>
                <section>
                  <h3>Judge&apos;s finding</h3>
                  <p>{criterion.rationale ?? "This behavior has not been judged yet."}</p>
                  <span className={styles.graderName}>{criterion.grader}</span>
                </section>
                <section>
                  <h3>Evidence from the call</h3>
                  {cited.length === 0 ? (
                    <p className={styles.quiet}>The judge did not cite a transcript turn.</p>
                  ) : (
                    <div className={styles.quotes}>
                      {cited.map(({ position, step }) => (
                        <blockquote key={step.span_id}>
                          <span>Turn {position} · {step.kind === "turn:human" ? "Human" : "Agent"}</span>
                          <p>{step.text}</p>
                          <a href={`#dossier-transcript-turn-${String(position)}`}>
                            Find in full transcript
                          </a>
                        </blockquote>
                      ))}
                    </div>
                  )}
                </section>
              </article>
            );
          })}
        </div>
      </div>

      <section className={`${styles.panel} ${styles.fullTranscript}`} id="dossier-transcript">
        <header className={styles.panelHead}>
          <div>
            <h2>Full transcript</h2>
            <p>The complete exchange, without raw clock values.</p>
          </div>
        </header>
        <TranscriptRows evidence={evidence} idPrefix="dossier-transcript" />
      </section>
    </div>
  );
}
