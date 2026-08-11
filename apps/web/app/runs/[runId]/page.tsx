"use client";

import { use, useEffect, useState } from "react";

import { Screen, styles } from "../../ui.tsx";

/**
 * One run, and what egma made of it.
 *
 * **Execution and grading are two facts and this page never merges them.** A
 * conversation finishes when the call ends; it is judged some time after that,
 * by a separate service reading what the call left behind. A page that showed
 * one number would be telling somebody a run was done while its verdicts were
 * still being written — so the header carries both counts, and a conversation
 * that has run but not been judged says `awaiting grading` rather than showing
 * an empty verdict that reads like a pass.
 *
 * **A failed verdict is not a failure of this page.** An agent that said the
 * wrong thing is the product working: the run completed, the judge read it, and
 * the answer was no. What is red here is a conversation that could not be
 * conducted or could not be judged — an operational problem — and those two are
 * kept apart in the wording, because blaming a customer's agent for a carrier
 * fault is the one mistake this whole product exists to avoid.
 *
 * **It refreshes itself while anything is outstanding.** Verdicts arrive after
 * the calls do, sometimes minutes after, and somebody who followed a link from
 * the terminal is watching this page for exactly that. It stops once execution
 * and grading are both settled, so a finished run is not polled forever.
 */

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

/** How often to look again while anything is still outstanding. */
const AGAIN_MS = 4000;

/** Whether anything about this run is still moving. */
function stillMoving(run: Run): boolean {
  const ran =
    (run.completed_count ?? 0) + (run.failed_count ?? 0) + (run.canceled_count ?? 0);
  return ran < run.expected_simulation_count || run.graded_count < ran;
}

const VERDICT_COLOR: Record<string, string> = {
  passed: "#1f7a3f",
  failed: "#b00020",
  skipped: "#8a6d00",
  errored: "#b00020",
};

function Verdict({ what }: { what: string | null }) {
  if (what === null) return <span style={styles.muted}>awaiting grading</span>;
  return (
    <span style={{ color: VERDICT_COLOR[what] ?? "#111", fontWeight: 600 }}>{what}</span>
  );
}

/** Passed, failed, skipped and errored, each kept whole. */
function Tally({ counts }: { counts: Counts | null }) {
  if (counts === null) return <span style={styles.muted}>—</span>;
  return (
    <span style={styles.monospace}>
      {counts.passed}/{counts.total} passed
      {counts.failed > 0 ? ` · ${counts.failed} failed` : ""}
      {/* Never folded into passed or failed. Missing judgment is not a pass,
          and a judge that broke is not an agent that misbehaved. */}
      {counts.skipped > 0 ? ` · ${counts.skipped} skipped` : ""}
      {counts.errored > 0 ? ` · ${counts.errored} errored` : ""}
    </span>
  );
}

export default function RunPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = use(params);
  const [state, setState] = useState<State>({ status: "loading" });

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const look = async (): Promise<void> => {
      try {
        const answer = await fetch(`/api/runs/${encodeURIComponent(runId)}`, {
          headers: { accept: "application/json" },
        });
        if (stopped) return;
        if (answer.status === 401) return setState({ status: "signed-out" });
        if (answer.status === 404) return setState({ status: "missing" });
        if (!answer.ok) {
          return setState({
            status: "failed",
            why: `egma answered ${String(answer.status)} reading this run.`,
          });
        }
        const run = (await answer.json()) as Run;
        if (stopped) return;
        setState({ status: "read", run });
        if (stillMoving(run)) timer = setTimeout(look, AGAIN_MS);
      } catch {
        if (!stopped) {
          setState({
            status: "failed",
            why: "egma could not be reached. It may still be starting.",
          });
        }
      }
    };

    void look();
    return () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [runId]);

  if (state.status === "loading") {
    return (
      <Screen title="Run">
        <p style={styles.lead}>Reading…</p>
      </Screen>
    );
  }
  if (state.status === "signed-out") {
    return (
      <Screen title="Run">
        <p style={styles.lead}>
          Sign in to read this run. The address carries no key, so it is the browser
          you are already signed in with that decides what you may see.
        </p>
        <a href="/sign-in">Sign in</a>
      </Screen>
    );
  }
  if (state.status === "missing") {
    return (
      <Screen title="Run">
        <p style={styles.lead}>No run of yours has that id.</p>
      </Screen>
    );
  }
  if (state.status === "failed") {
    return (
      <Screen title="Run">
        <p style={styles.problem}>{state.why}</p>
      </Screen>
    );
  }

  const { run } = state;
  const ran =
    (run.completed_count ?? 0) + (run.failed_count ?? 0) + (run.canceled_count ?? 0);

  return (
    <Screen title={run.label ?? "Run"}>
      <p style={styles.lead}>
        <span style={styles.monospace}>{run.id}</span>
        {run.connection_type === null ? null : (
          <>
            {" · "}
            {run.connection_type}
            {run.modality === null ? "" : ` (${run.modality})`}
          </>
        )}
      </p>

      <div style={styles.definition}>
        <span>Execution</span>
        <span>
          {ran} of {run.expected_simulation_count} finished
          {run.failed_count ? ` · ${String(run.failed_count)} could not be conducted` : ""}
        </span>
      </div>
      <div style={styles.definition}>
        <span>Grading</span>
        <span>
          {run.graded_count} of {ran || run.expected_simulation_count} judged
        </span>
      </div>
      <div style={styles.definition}>
        <span>Verdict</span>
        <span>
          <Verdict what={run.verdict} /> {run.counts === null ? null : "· "}
          <Tally counts={run.counts} />
        </span>
      </div>
      {run.by_grader.map((its) => (
        <div key={its.grader_id} style={styles.definition}>
          <span style={styles.muted}>{its.grader_id}</span>
          <span>
            <Verdict what={its.verdict} /> · <Tally counts={its.counts} />
          </span>
        </div>
      ))}

      <h2 style={{ ...styles.title, marginTop: "2rem" }}>Simulations</h2>
      <div style={styles.scroller}>
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.columnHeading}>#</th>
              <th style={styles.columnHeading}>Test</th>
              <th style={styles.columnHeading}>Persona</th>
              <th style={styles.columnHeading}>Execution</th>
              <th style={styles.columnHeading}>Grading</th>
              <th style={styles.columnHeading}>Verdict</th>
              <th style={styles.columnHeading}>Behaviours</th>
            </tr>
          </thead>
          <tbody>
            {run.simulations.map((one) => (
              <tr key={one.id}>
                <td style={styles.cell}>{one.position}</td>
                <td style={styles.cell}>{one.test_name ?? "—"}</td>
                <td style={styles.cell}>{one.persona_name ?? "—"}</td>
                <td style={styles.cell}>
                  {/* Red here means the conversation could not be held — a
                      platform or carrier problem, never the agent's answer. */}
                  <span style={one.status === "failed" ? styles.wrong : undefined}>
                    {one.status}
                  </span>
                  {one.reason === null ? null : (
                    <span style={styles.muted}> · {one.reason}</span>
                  )}
                </td>
                <td style={styles.cell}>
                  {one.grading === "graded" ? (
                    "graded"
                  ) : (
                    <span style={styles.muted}>pending</span>
                  )}
                </td>
                <td style={styles.cell}>
                  <Verdict what={one.verdict} />
                </td>
                <td style={styles.cell}>
                  <Tally counts={one.counts} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* What each judge actually decided, and why. The table above says how
          many passed; this is the part somebody came to read. Every row names
          the judge that wrote it and the turns it cited, so a verdict can be
          argued with rather than only accepted. */}
      {run.simulations
        .filter((one) => one.verdicts.length > 0)
        .map((one) => (
          <section key={one.id} style={{ marginTop: "2rem" }}>
            <h3 style={{ ...styles.label, fontSize: "0.9375rem" }}>
              {one.position}. {one.test_name ?? one.id}
              {one.persona_name === null ? null : (
                <span style={styles.muted}> · {one.persona_name}</span>
              )}
            </h3>
            {one.verdicts.map((its) => (
              <div
                key={`${its.grader_id}:${its.dimension}:${its.judged_at}`}
                style={{
                  borderTop: "1px solid #eee",
                  padding: "0.75rem 0",
                }}
              >
                <div style={{ display: "flex", gap: "0.5rem", alignItems: "baseline" }}>
                  <Verdict what={its.verdict} />
                  <span style={styles.monospace}>{its.dimension}</span>
                  <span style={styles.muted}>{its.priority}</span>
                </div>
                <p style={{ margin: "0.375rem 0 0.25rem", lineHeight: 1.5 }}>
                  {its.rationale}
                </p>
                <p style={{ ...styles.aside, margin: 0, fontSize: "0.8125rem" }}>
                  judged by <span style={styles.monospace}>{its.judged_by}</span>
                  {its.cited_turns.length === 0 ? null : (
                    <>
                      {" · citing "}
                      <span style={styles.monospace}>
                        {its.cited_turns.join(", ")}
                      </span>
                    </>
                  )}
                </p>
              </div>
            ))}
          </section>
        ))}

      {run.simulations.length === 0 ? (
        <p style={styles.aside}>This run has no conversations yet.</p>
      ) : null}
      <p style={styles.aside}>
        {stillMoving(run)
          ? "Updating as calls finish and verdicts arrive."
          : "Every conversation has finished and every one has been judged."}
      </p>
    </Screen>
  );
}
