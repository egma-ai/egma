"use client";

import Link from "next/link";
import { use, useEffect, useState } from "react";

import { humanizeIdentifier } from "../../../lib/transcript-copy.ts";

import {
  AppShell,
  Notice,
  ProductPage,
  ProductStatePage,
  StatePage,
  styles,
} from "../../ui.tsx";

type Counts = {
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly errored: number;
  readonly total: number;
};

type Judgment = {
  readonly grader_id: string;
  readonly dimension: string;
  readonly verdict: string;
  readonly score: number;
  readonly priority: string;
  readonly rationale: string;
  readonly cited_turns: readonly string[];
  readonly judged_by: string;
  readonly judged_at: string;
};

type Simulation = {
  readonly id: string;
  readonly position: number;
  readonly test_name: string | null;
  readonly persona_name: string | null;
  readonly status: string;
  readonly grading: "pending" | "graded";
  readonly verdict: string | null;
  readonly score: number | null;
  readonly counts: Counts | null;
  readonly verdicts: readonly Judgment[];
  readonly reason: string | null;
};

type Run = {
  readonly id: string;
  readonly status: string;
  readonly connection_type: string | null;
  readonly modality: string | null;
  readonly label: string | null;
  readonly expected_simulation_count: number;
  readonly completed_count: number | null;
  readonly failed_count: number | null;
  readonly canceled_count: number | null;
  readonly graded_count: number;
  readonly verdict: string | null;
  readonly score: number | null;
  readonly counts: Counts | null;
  readonly by_grader: readonly {
    readonly grader_id: string;
    readonly verdict: string;
    readonly score: number | null;
    readonly counts: Counts;
  }[];
  readonly created_at: string;
  readonly finished_at: string | null;
  readonly simulations: readonly Simulation[];
};

type State =
  | { status: "loading" }
  | { status: "signed-out" }
  | { status: "missing" }
  | { status: "failed"; why: string }
  | { status: "read"; run: Run };

const AGAIN_MS = 4000;

function conducted(run: Run): number {
  return (run.completed_count ?? 0) + (run.failed_count ?? 0) + (run.canceled_count ?? 0);
}

function stillMoving(run: Run): boolean {
  const finished = conducted(run);
  return finished < run.expected_simulation_count || run.graded_count < finished;
}

function tally(counts: Counts | null): string {
  if (counts === null) return "Awaiting grading";
  const parts = [`${counts.passed}/${counts.total} passed`];
  if (counts.failed > 0) parts.push(`${counts.failed} failed`);
  if (counts.skipped > 0) parts.push(`${counts.skipped} skipped`);
  if (counts.errored > 0) parts.push(`${counts.errored} errored`);
  return parts.join(" · ");
}

function shownScore(score: number | null): string {
  return score === null ? "—" : String(Math.round(score * 1000) / 1000);
}

function when(value: string | null): string {
  if (value === null) return "Not finished";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export default function RunPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = use(params);
  const [state, setState] = useState<State>({ status: "loading" });

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const read = async (): Promise<void> => {
      try {
        const answer = await fetch(`/api/runs/${encodeURIComponent(runId)}`, {
          headers: { accept: "application/json" },
          cache: "no-store",
        });
        if (stopped) return;
        if (answer.status === 401) return setState({ status: "signed-out" });
        if (answer.status === 404) return setState({ status: "missing" });
        if (!answer.ok) {
          return setState({
            status: "failed",
            why: `Egma answered ${String(answer.status)} while reading this run.`,
          });
        }
        const run = (await answer.json()) as Run;
        if (stopped) return;
        setState({ status: "read", run });
        if (stillMoving(run)) timer = setTimeout(read, AGAIN_MS);
      } catch {
        if (!stopped) {
          setState({
            status: "failed",
            why: "Egma could not be reached. It may still be starting.",
          });
        }
      }
    };

    void read();
    return () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [runId]);

  if (state.status === "loading") {
    return <ProductStatePage active="transcripts" title="Run results" lead="Reading the run and its verdicts." />;
  }
  if (state.status === "signed-out") {
    return (
      <StatePage title="Sign in first" lead="Your session decides which run you may read.">
        <p className={styles.linkLine}><a href="/sign-in">Sign in</a></p>
      </StatePage>
    );
  }
  if (state.status === "missing") {
    return <ProductStatePage active="transcripts" title="That run is not here" lead="No run in this organization has that address." />;
  }
  if (state.status === "failed") {
    return (
      <ProductStatePage active="transcripts" title="Run results">
        <Notice tone="error">{state.why}</Notice>
      </ProductStatePage>
    );
  }

  const { run } = state;
  const finished = conducted(run);
  const moving = stillMoving(run);
  const executionFailed = (run.failed_count ?? 0) > 0;

  return (
    <AppShell active="transcripts">
      <ProductPage wide>
        <Link className={styles.backLink} href="/traces">← Transcripts</Link>

        <header className={styles.detailHeader}>
          <div>
            <p className={styles.eyebrow}>Run results</p>
            <h1>{run.label ?? "Run"}</h1>
            <p className={styles.detailLead}>
              {when(run.created_at)}
              {run.connection_type === null ? "" : ` · ${run.connection_type}`}
              {run.modality === null ? "" : ` · ${run.modality}`}
            </p>
          </div>
          <span className={`${styles.status} ${executionFailed ? styles.statusBad : ""}`}>
            {moving ? "Updating" : run.status}
          </span>
        </header>

        <section className={styles.runFacts} aria-label="Run summary">
          <RunFact label="Execution" value={`${finished}/${run.expected_simulation_count} finished`} bad={executionFailed} />
          <RunFact label="Grading" value={`${run.graded_count}/${finished || run.expected_simulation_count} judged`} />
          <RunFact label="Verdict" value={run.verdict ?? "Awaiting grading"} verdict={run.verdict} />
          <RunFact label="Score" value={shownScore(run.score)} />
        </section>

        {moving ? <Notice>Updating as conversations finish and verdicts arrive.</Notice> : null}
        {executionFailed ? (
          <Notice tone="error">
            {run.failed_count} {run.failed_count === 1 ? "conversation could" : "conversations could"} not be conducted. This is an execution problem, not a failed grader verdict.
          </Notice>
        ) : null}

        <section className={styles.runSection}>
          <div className={styles.runSectionHeading}>
            <div>
              <p className={styles.eyebrow}>Grading</p>
              <h2>What the judges decided</h2>
            </div>
            <p>{tally(run.counts)}</p>
          </div>

          {run.by_grader.length === 0 ? (
            <p className={styles.muted}>No grader has finished yet.</p>
          ) : (
            <div className={styles.graderGrid}>
              {run.by_grader.map((grader) => (
                <article className={styles.graderCard} data-verdict={grader.verdict} key={grader.grader_id}>
                  <div>
                    <span className={styles.verdictChip}>{grader.verdict}</span>
                    <strong className={styles.mono}>{grader.grader_id}</strong>
                  </div>
                  <p>{tally(grader.counts)}</p>
                  <small>Score {shownScore(grader.score)}</small>
                </article>
              ))}
            </div>
          )}
        </section>

        <section className={styles.runSection}>
          <div className={styles.runSectionHeading}>
            <div>
              <p className={styles.eyebrow}>Conversations</p>
              <h2>Simulations</h2>
            </div>
            <p>{run.simulations.length} of {run.expected_simulation_count}</p>
          </div>

          {run.simulations.length === 0 ? (
            <Notice>This run has no conversations yet.</Notice>
          ) : (
            <div className={styles.runSimulations}>
              {run.simulations.map((simulation) => (
                <SimulationResult key={simulation.id} simulation={simulation} />
              ))}
            </div>
          )}
        </section>

        <details className={styles.runTechnical}>
          <summary>Run details</summary>
          <dl className={styles.recorded}>
            <div><dt>Run identifier</dt><dd className={styles.mono}>{run.id}</dd></div>
            <div><dt>Started</dt><dd>{when(run.created_at)}</dd></div>
            <div><dt>Finished</dt><dd>{when(run.finished_at)}</dd></div>
          </dl>
        </details>
      </ProductPage>
    </AppShell>
  );
}

function RunFact({
  label,
  value,
  bad = false,
  verdict = null,
}: {
  label: string;
  value: string;
  bad?: boolean;
  verdict?: string | null;
}) {
  return (
    <div className={styles.contextFact} data-verdict={verdict ?? undefined}>
      <span>{label}</span>
      <strong className={bad ? styles.wrong : undefined}>{value}</strong>
    </div>
  );
}

function SimulationResult({ simulation }: { simulation: Simulation }) {
  const operationalFailure = simulation.status === "failed";

  return (
    <details className={styles.runSimulation} data-verdict={simulation.verdict ?? undefined}>
      <summary>
        <span className={styles.runPosition}>{String(simulation.position).padStart(2, "0")}</span>
        <span className={styles.runSimulationIdentity}>
          <strong>{simulation.test_name ?? "Untitled test"}</strong>
          <small>{simulation.persona_name ?? "No persona name"}</small>
        </span>
        <ResultValue label="Execution" value={simulation.status} bad={operationalFailure} />
        <ResultValue label="Grading" value={simulation.grading} />
        <ResultValue label="Verdict" value={simulation.verdict ?? "Pending"} verdict={simulation.verdict} />
        <ResultValue label="Score" value={shownScore(simulation.score)} />
        <span className={styles.runDisclosure} aria-hidden="true">+</span>
      </summary>

      <div className={styles.runSimulationBody}>
        {simulation.reason === null ? null : (
          <Notice tone="error">{simulation.reason}</Notice>
        )}
        <p className={styles.runTally}>{tally(simulation.counts)}</p>

        {simulation.verdicts.length === 0 ? (
          <p className={styles.muted}>No written verdict has arrived yet.</p>
        ) : (
          <div className={styles.runJudgments}>
            {simulation.verdicts.map((judgment) => (
              <article
                className={styles.runJudgment}
                data-verdict={judgment.verdict}
                key={`${judgment.grader_id}:${judgment.dimension}:${judgment.judged_at}`}
              >
                <div className={styles.judgmentHeading}>
                  <span className={styles.verdictChip}>{judgment.verdict}</span>
                  <strong>{humanizeIdentifier(judgment.dimension)}</strong>
                  <span>{judgment.priority}</span>
                </div>
                <p>{judgment.rationale}</p>
                <small>
                  Judged by <span className={styles.mono}>{judgment.judged_by}</span>
                  {judgment.cited_turns.length === 0 ? "" : ` · ${judgment.cited_turns.join(", ")}`}
                </small>
              </article>
            ))}
          </div>
        )}
      </div>
    </details>
  );
}

function ResultValue({
  label,
  value,
  bad = false,
  verdict = null,
}: {
  label: string;
  value: string;
  bad?: boolean;
  verdict?: string | null;
}) {
  return (
    <span className={styles.runResultValue} data-verdict={verdict ?? undefined}>
      <small>{label}</small>
      <strong className={bad ? styles.wrong : undefined}>{value}</strong>
    </span>
  );
}
