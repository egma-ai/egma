"use client";

import Link from "next/link";
import { use, useEffect, useState } from "react";

import { runProgress } from "../../../lib/run-progress.ts";
import type { Judgment } from "../../../lib/transcripts.ts";
import { JudgmentCard } from "../../judgment-card.tsx";
import {
  RecordingPlayer,
  type RecordingWords,
} from "../../recording-player.tsx";

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
  /** Voice or chat, as the row itself says rather than as the run does. */
  readonly modality: string | null;
  /**
   * Whether there is a recording to hear. Not where it is: the reference is
   * resolved on its own, when somebody opens this conversation, so that the
   * address of this page carries no link and stays something you can send to a
   * colleague.
   */
  readonly has_recording: boolean;
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

function stillMoving(run: Run): boolean {
  return runProgress(run).moving;
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
    return <ProductStatePage title="Run results" lead="Reading the run and its verdicts." />;
  }
  if (state.status === "signed-out") {
    return (
      <StatePage title="Sign in first" lead="Your session decides which run you may read.">
        <p className={styles.linkLine}><a href="/sign-in">Sign in</a></p>
      </StatePage>
    );
  }
  if (state.status === "missing") {
    return <ProductStatePage title="That run is not here" lead="No run in this organization has that address." />;
  }
  if (state.status === "failed") {
    return (
      <ProductStatePage title="Run results">
        <Notice tone="error">{state.why}</Notice>
      </ProductStatePage>
    );
  }

  const { run } = state;
  const progress = runProgress(run);
  const moving = progress.moving;
  const executionFailed = progress.failed > 0;

  return (
    <AppShell>
      <ProductPage>
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
          <span className={`${styles.status} ${executionFailed ? styles.statusBad : run.status === "canceled" ? styles.statusNeutral : ""}`}>
            {moving ? "Updating" : run.status}
          </span>
        </header>

        <section className={styles.runFacts} aria-label="Run summary">
          <RunFact label="Execution" value={`${progress.finished}/${run.expected_simulation_count} finished`} bad={executionFailed} />
          <RunFact label="Grading" value={`${run.graded_count}/${progress.gradable} judged`} />
          <RunFact label="Verdict" value={run.verdict ?? "Awaiting grading"} verdict={run.verdict} />
          <RunFact label="Score" value={shownScore(run.score)} />
        </section>

        {moving ? <Notice>Updating as conversations finish and verdicts arrive.</Notice> : null}
        {executionFailed ? (
          <Notice tone="error">
            {progress.failed} {progress.failed === 1 ? "conversation could" : "conversations could"} not be conducted. This is an execution problem, not a failed grader verdict.
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

/**
 * What the player says here.
 *
 * **`persona` is the right word on this page and only on this page.** A run is
 * a set of conversations each of which a persona had, and this page names the
 * persona of every one of them a line above the player. The transcript surface
 * says `human` instead, because a transcript may be a production exchange
 * nobody simulated and there is no persona in it to name; its words are held
 * against the banned list in `transcript-copy.ts`.
 */
const HEARD_ON_A_RUN: RecordingWords = {
  label: "Recording",
  caption: "Left channel is the persona, right channel is the agent.",
  band: (hertz) => `Heard at ${String(hertz)} Hz.`,
  fallback: "Your browser cannot play audio.",
  unplayable:
    "This recording could not be played. The store it lives in may be unreachable.",
  unreachable: "Egma could not be reached for this recording.",
  refused: (status) => `Egma answered ${String(status)} for this recording.`,
};

function SimulationResult({ simulation }: { simulation: Simulation }) {
  const operationalFailure = simulation.status === "failed";
  // Nothing is asked for until somebody opens this conversation. A run can hold
  // two hundred of them, and resolving a link for every one on arrival would be
  // two hundred requests for audio nobody has asked to hear.
  const [opened, setOpened] = useState(false);

  return (
    <details
      className={styles.runSimulation}
      data-verdict={simulation.verdict ?? undefined}
      // Named on the element so a person reading a run in a browser test can
      // point at one conversation rather than at whichever row happened to be
      // drawn first. Two conversations of one run differ only by who called.
      data-simulation={simulation.id}
      onToggle={(event) => {
        if (event.currentTarget.open) setOpened(true);
      }}
    >
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

        {/*
          Only where there is something to play, and nothing at all where there
          is not. A chat carries no audio and never will; a voice conversation
          whose call never connected wrote none. Neither gets a control that
          does nothing — a disabled player reads as a broken feature rather than
          as an honest absence, and sends somebody looking for the fault.
        */}
        {opened && simulation.modality === "voice" && simulation.has_recording ? (
          <RecordingPlayer
            simulationId={simulation.id}
            words={HEARD_ON_A_RUN}
            // This run's own answer already said there is one, so a link that
            // will not resolve here is a fault and says so.
            knownToExist
          />
        ) : null}

        <p className={styles.runTally}>{tally(simulation.counts)}</p>

        {simulation.verdicts.length === 0 ? (
          <p className={styles.muted}>No written verdict has arrived yet.</p>
        ) : (
          <div className={styles.runJudgments}>
            {simulation.verdicts.map((judgment) => (
              <JudgmentCard
                key={`${judgment.grader_id}:${judgment.dimension}:${judgment.judged_at}`}
                judgment={judgment}
                placement="result"
              />
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
