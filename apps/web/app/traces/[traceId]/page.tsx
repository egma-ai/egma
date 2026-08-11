"use client";

import Link from "next/link";
import { Fragment, use, useEffect, useState, type CSSProperties } from "react";

import {
  DETAIL,
  FACTS,
  LIST,
  RECORDING,
  SPEAKERS,
  UNKNOWN_STEP_LABEL,
  stepLabel,
} from "../../../lib/transcript-copy.ts";
import {
  everyStep,
  howFarIn,
  howLong,
  isHuman,
  milliseconds,
  somethingFailed,
  stepsInside,
  whenItWas,
  turnsCited,
  type Detail,
  type Facts as TraceFacts,
  type Outcome,
  type Step,
} from "../../../lib/transcripts.ts";
import { JudgmentCard } from "../../judgment-card.tsx";
import { RecordingPlayer } from "../../recording-player.tsx";
import {
  AppShell,
  Notice,
  ProductPage,
  ProductStatePage,
  StatePage,
  styles,
} from "../../ui.tsx";

type State =
  | { status: "loading" }
  | { status: "signed-out" }
  | { status: "no-window" }
  | { status: "missing" }
  | { status: "failed"; why: string }
  | { status: "read"; detail: Detail };

type View = "transcript" | "timeline" | "execution";
type PositionedStep = { readonly step: Step; readonly depth: number };

const VIEWS: readonly { readonly id: View; readonly label: string }[] = [
  { id: "transcript", label: DETAIL.views.transcript },
  { id: "timeline", label: DETAIL.views.timeline },
  { id: "execution", label: DETAIL.views.execution },
];

export default function TranscriptPage({
  params,
}: {
  params: Promise<{ traceId: string }>;
}) {
  const { traceId } = use(params);
  const [state, setState] = useState<State>({ status: "loading" });
  const [view, setView] = useState<View>("transcript");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    const asked = new URLSearchParams(globalThis.location.search);
    const from = asked.get("from");
    const to = asked.get("to");
    if (from === null || to === null) {
      setState({ status: "no-window" });
      return undefined;
    }

    const query = new URLSearchParams({ from, to });
    void fetch(`/v1/traces/${encodeURIComponent(traceId)}?${query.toString()}`)
      .then(async (answer) => {
        if (!current) return;
        if (answer.status === 401) {
          setState({ status: "signed-out" });
          return;
        }
        if (answer.status === 404) {
          setState({ status: "missing" });
          return;
        }
        if (!answer.ok) {
          const said = (await answer.json().catch(() => ({}))) as {
            message?: string;
          };
          setState({
            status: "failed",
            why: said.message ?? DETAIL.unreachable,
          });
          return;
        }
        setState({ status: "read", detail: (await answer.json()) as Detail });
      })
      .catch(() => {
        if (current) setState({ status: "failed", why: DETAIL.unreachable });
      });

    return () => {
      current = false;
    };
  }, [traceId]);

  if (state.status === "loading") {
    return <ProductStatePage active="transcripts" title={DETAIL.title} lead={DETAIL.loading} />;
  }

  if (state.status === "signed-out") {
    return (
      <StatePage title={LIST.signedOut} lead={LIST.signedOutLead}>
        <p className={styles.linkLine}>
          <a href="/sign-in">{LIST.signIn}</a> ·{" "}
          <a href="/signup">{LIST.setUp}</a>
        </p>
      </StatePage>
    );
  }

  if (state.status === "no-window") {
    return (
      <ProductStatePage active="transcripts" title={DETAIL.needsWindow} lead={DETAIL.needsWindowLead}>
        <p className={styles.linkLine}>
          <Link href="/traces">{DETAIL.back}</Link>
        </p>
      </ProductStatePage>
    );
  }

  if (state.status === "missing") {
    return (
      <ProductStatePage active="transcripts" title={DETAIL.missing} lead={DETAIL.missingLead}>
        <p className={styles.linkLine}>
          <Link href="/traces">{DETAIL.back}</Link>
        </p>
      </ProductStatePage>
    );
  }

  if (state.status === "failed") {
    return (
      <ProductStatePage active="transcripts" title={DETAIL.title}>
        <Notice tone="error">{state.why}</Notice>
        <p className={styles.linkLine}>
          <Link href="/traces">{DETAIL.back}</Link>
        </p>
      </ProductStatePage>
    );
  }

  const { detail } = state;
  const openedAt = detail.trace.started_at;
  const positioned = positionedSteps(detail);
  const selected = positioned.find(({ step }) => step.span_id === selectedId)?.step
    ?? detail.turns[0]
    ?? detail.spans[0]
    ?? null;
  const failures = positioned
    .map(({ step }) => step)
    .filter((step) => step.status === "error");

  function select(step: Step): void {
    setSelectedId(step.span_id);
  }

  function moveBetweenFailures(direction: -1 | 1): void {
    if (failures.length === 0) return;
    const selectedFailure = failures.findIndex((step) => step.span_id === selected?.span_id);
    const from = selectedFailure < 0 ? (direction > 0 ? -1 : 0) : selectedFailure;
    const next = (from + direction + failures.length) % failures.length;
    setSelectedId(failures[next]?.span_id ?? null);
    setView("execution");
  }

  return (
    <AppShell active="transcripts">
      <ProductPage wide>
        <Link className={styles.backLink} href="/traces">← {DETAIL.back}</Link>
        <header className={styles.detailHeader}>
          <div>
            <p className={styles.eyebrow}>{detail.trace.source} / {detail.trace.environment}</p>
            <h1>{DETAIL.title}</h1>
            <p className={styles.detailLead}>{whenItWas(openedAt)} · {howLong(detail.trace.duration_ns)}</p>
          </div>
          <span className={`${styles.status} ${detail.trace.errored_span_count > 0 ? styles.statusBad : ""}`}>
            {detail.trace.errored_span_count === 0 ? DETAIL.recorded : DETAIL.errors(detail.trace.errored_span_count)}
          </span>
        </header>

        <Summary facts={detail.trace} />
        {detail.outcome ? <OutcomeSummary outcome={detail.outcome} /> : null}

        {/*
          The audio of this exchange, where egma is the one who had it.

          **Beside the turns, because this is where the doubt is.** Somebody
          reading a transcript who cannot tell a misbehaving agent from a bad
          transcription is already looking at the turn; sending them to the run
          to hear it would put the evidence a page away from the doubt.

          Above the views rather than inside the transcript one, so that
          switching to the timeline never leaves audio playing behind a panel
          with no controls on it — a hidden `<audio>` keeps going, and a person
          hunting for the sound would have no way to stop it.

          `simulation_id` is present only for an exchange egma conducted, which
          is the one question this page can answer for itself; whether that
          conversation recorded anything is the recording route's answer, and a
          refusal there shows nothing at all rather than a control that does
          nothing.
        */}
        {typeof detail.simulation_id === "string" ? (
          <RecordingPlayer
            simulationId={detail.simulation_id}
            words={RECORDING}
            knownToExist={false}
          />
        ) : null}

        <div className={styles.traceToolbar}>
          <div className={styles.traceViewTabs} role="tablist" aria-label={DETAIL.viewLabel}>
            {VIEWS.map((item) => (
              <button
                key={item.id}
                className={view === item.id ? styles.traceViewTabActive : undefined}
                type="button"
                role="tab"
                aria-selected={view === item.id}
                onClick={() => setView(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>
          {failures.length === 0 ? null : (
            <div className={styles.issueNavigator}>
              <span>{DETAIL.problems(failures.length)}</span>
              <button type="button" aria-label={DETAIL.previousProblem} onClick={() => moveBetweenFailures(-1)}>←</button>
              <button type="button" aria-label={DETAIL.nextProblem} onClick={() => moveBetweenFailures(1)}>→</button>
            </div>
          )}
        </div>

        {detail.spans_truncated ? <Notice tone="error">{DETAIL.truncated}</Notice> : null}

        <div className={styles.traceLayout}>
          <section className={styles.traceViews}>
            <div role="tabpanel" hidden={view !== "transcript"}>
              <TranscriptView detail={detail} selectedId={selected?.span_id ?? null} onSelect={select} />
            </div>
            <div role="tabpanel" hidden={view !== "timeline"}>
              <TimelineView detail={detail} steps={positioned} selectedId={selected?.span_id ?? null} onSelect={select} />
            </div>
            <div role="tabpanel" hidden={view !== "execution"}>
              <ExecutionView detail={detail} selectedId={selected?.span_id ?? null} onSelect={select} />
            </div>
          </section>
          <Inspector selected={selected} facts={detail.trace} openedAt={openedAt} />
        </div>
      </ProductPage>
    </AppShell>
  );
}

function Summary({ facts }: { facts: TraceFacts }) {
  const primary: readonly (readonly [string, string, boolean])[] = [
    [FACTS.duration, howLong(facts.duration_ns), false],
    [FACTS.turns, `${facts.turn_counts.human} ${LIST.human} · ${facts.turn_counts.agent} ${LIST.agent}`, false],
    [FACTS.steps, String(facts.span_count), false],
    [FACTS.tools, String(facts.tool_span_count), false],
    [FACTS.errors, String(facts.errored_span_count), facts.errored_span_count > 0],
  ];

  return (
    <section className={styles.detailFacts} aria-label={DETAIL.summary}>
      {primary.map(([label, value, wrong]) => (
        <div className={styles.contextFact} key={label}>
          <span>{label}</span>
          <strong className={wrong ? styles.wrong : undefined}>{value}</strong>
        </div>
      ))}
    </section>
  );
}

function OutcomeSummary({ outcome }: { outcome: Outcome }) {
  const checks = [`${outcome.counts.passed}/${outcome.counts.total} passed`];
  if (outcome.counts.failed > 0) checks.push(`${outcome.counts.failed} failed`);
  if (outcome.counts.skipped > 0) checks.push(`${outcome.counts.skipped} skipped`);
  if (outcome.counts.errored > 0) checks.push(`${outcome.counts.errored} errored`);

  return (
    <section className={`${styles.runFacts} ${styles.traceOutcome}`} aria-label="Grading outcome">
      <div className={styles.contextFact} data-verdict={outcome.verdict}>
        <span>Verdict</span>
        <strong>{outcome.verdict}</strong>
      </div>
      <div className={styles.contextFact}>
        <span>Score</span>
        <strong>{outcome.score === null ? "—" : String(Math.round(outcome.score * 1000) / 1000)}</strong>
      </div>
      <div className={styles.contextFact}>
        <span>Checks</span>
        <strong>{checks.join(" · ")}</strong>
      </div>
    </section>
  );
}

function TranscriptView({
  detail,
  selectedId,
  onSelect,
}: {
  detail: Detail;
  selectedId: string | null;
  onSelect: (step: Step) => void;
}) {
  const openedAt = detail.trace.started_at;

  return (
    <div className={styles.transcript}>
      <div className={styles.traceViewHeading}>
        <h2>{DETAIL.transcript}</h2>
        <p>{DETAIL.transcriptLead}</p>
      </div>
      {detail.turns.length === 0 ? (
        <Notice>{DETAIL.noTurns}</Notice>
      ) : (
        detail.turns.map((turn, position) => (
          <Fragment key={turn.span_id}>
            <Turn
              turn={turn}
              openedAt={openedAt}
              selectedId={selectedId}
              onSelect={onSelect}
            />
            {(detail.verdicts ?? [])
              .filter((judgment) => turnsCited(judgment).includes(position + 1))
              .map((judgment) => (
                <JudgmentCard
                  key={`${judgment.grader_id}:${judgment.dimension}:${judgment.judged_at}`}
                  judgment={judgment}
                />
              ))}
          </Fragment>
        ))
      )}
      {detail.spans.length === 0 ? null : (
        <details className={styles.otherSteps}>
          <summary>{DETAIL.otherSteps}</summary>
          <p className={styles.muted}>{DETAIL.otherStepsLead}</p>
          <div className={styles.stepStack}>
            {detail.spans.map((step) => (
              <Timed key={step.span_id} step={step} openedAt={openedAt} selectedId={selectedId} onSelect={onSelect} />
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

function Turn({
  turn,
  openedAt,
  selectedId,
  onSelect,
}: {
  turn: Step;
  openedAt: string;
  selectedId: string | null;
  onSelect: (step: Step) => void;
}) {
  const inside = stepsInside(turn);
  const failed = turn.status === "error" || somethingFailed(turn);
  const human = isHuman(turn);
  const selected = turn.span_id === selectedId;

  return (
    <details
      className={`${styles.turn} ${human ? styles.turnHuman : styles.turnAgent} ${selected ? styles.turnSelected : ""}`}
      data-turn="true"
      onToggle={(event) => {
        if (event.currentTarget.open) onSelect(turn);
      }}
    >
      <summary>
        <span className={styles.turnRail}>
          <span>{howFarIn(turn.started_at, openedAt)}</span>
          <span aria-hidden="true" />
        </span>
        <span className={styles.turnText}>
          <span className={styles.turnHeading}>
            <strong>{human ? SPEAKERS.human : SPEAKERS.agent}</strong>
            <small>{howLong(turn.duration_ns)} · {DETAIL.steps(inside)}</small>
          </span>
          <span className={styles.turnWords}>
            {turn.text === "" ? <span className={styles.muted}>{DETAIL.nothingSaid}</span> : turn.text}
          </span>
          {failed ? <small className={styles.turnProblem}>{DETAIL.failedInside}</small> : null}
        </span>
        <span className={styles.turnMarker} aria-hidden="true">+</span>
      </summary>
      <div className={styles.turnBody}>
        {turn.spans.length === 0 ? (
          <p className={styles.muted}>{DETAIL.noSteps}</p>
        ) : (
          <div className={styles.stepStack}>
            {turn.spans.map((step) => (
              <Timed key={step.span_id} step={step} openedAt={openedAt} selectedId={selectedId} onSelect={onSelect} />
            ))}
          </div>
        )}
      </div>
    </details>
  );
}

function Timed({
  step,
  openedAt,
  selectedId,
  onSelect,
}: {
  step: Step;
  openedAt: string;
  selectedId: string | null;
  onSelect: (step: Step) => void;
}) {
  const failed = step.status === "error";
  const marked = failed || everyStep(step.spans).some((one) => one.status === "error");

  return (
    <details
      className={`${styles.step} ${marked ? styles.stepFailed : ""} ${selectedId === step.span_id ? styles.stepSelected : ""}`}
      onToggle={(event) => {
        if (event.currentTarget.open) onSelect(step);
      }}
    >
      <summary>
        <span className={styles.stepIdentity}>
          <strong>{presentedStepLabel(step)}</strong>
          <span className={styles.mono}>{step.name}</span>
        </span>
        <span className={styles.stepTiming}>
          {howFarIn(step.started_at, openedAt)} · {howLong(step.duration_ns)}
          {failed ? <span className={styles.wrong}> · {DETAIL.failed}</span> : null}
        </span>
      </summary>
      <div className={styles.stepBody}>
        <Recorded step={step} openedAt={openedAt} />
        {step.spans.length === 0 ? null : (
          <div className={styles.stepStack}>
            {step.spans.map((child) => (
              <Timed key={child.span_id} step={child} openedAt={openedAt} selectedId={selectedId} onSelect={onSelect} />
            ))}
          </div>
        )}
      </div>
    </details>
  );
}

function TimelineView({
  detail,
  steps,
  selectedId,
  onSelect,
}: {
  detail: Detail;
  steps: readonly PositionedStep[];
  selectedId: string | null;
  onSelect: (step: Step) => void;
}) {
  const total = Math.max(milliseconds(detail.trace.duration_ns), 1);
  const openedAt = Date.parse(detail.trace.started_at);

  return (
    <div>
      <div className={styles.traceViewHeading}>
        <h2>{DETAIL.views.timeline}</h2>
        <p>{DETAIL.timelineLead}</p>
      </div>
      {steps.length === 0 ? <Notice>{DETAIL.noStepsAtAll}</Notice> : (
        <div className={styles.timelineList}>
          {steps.map(({ step, depth }) => {
            const offset = Math.max(Date.parse(step.started_at) - openedAt, 0);
            const duration = Math.max(milliseconds(step.duration_ns), 0);
            const left = Math.min((offset / total) * 100, 100);
            const width = Math.max(Math.min((duration / total) * 100, 100 - left), .8);
            const style = {
              "--timeline-indent": `${Math.min(depth, 6) * 12}px`,
              "--timeline-left": `${left}%`,
              "--timeline-width": `${width}%`,
            } as CSSProperties;

            return (
              <button
                key={step.span_id}
                className={`${styles.timelineRow} ${selectedId === step.span_id ? styles.timelineRowSelected : ""}`}
                type="button"
                style={style}
                onClick={() => onSelect(step)}
              >
                <span className={styles.timelineName}>
                  <strong>{presentedStepLabel(step)}</strong>
                  <span>{step.name}</span>
                </span>
                <span className={styles.timelineTrack} aria-hidden="true">
                  <span className={step.status === "error" ? styles.timelineBarBad : undefined} />
                </span>
                <span className={styles.timelineDuration}>{howLong(step.duration_ns)}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ExecutionView({
  detail,
  selectedId,
  onSelect,
}: {
  detail: Detail;
  selectedId: string | null;
  onSelect: (step: Step) => void;
}) {
  const groups = [
    ...detail.turns.map((turn) => ({
      id: turn.span_id,
      label: `${isHuman(turn) ? SPEAKERS.human : SPEAKERS.agent} ${howFarIn(turn.started_at, detail.trace.started_at)}`,
      steps: flatten(turn.spans),
    })),
    ...(detail.spans.length === 0 ? [] : [{ id: "outside", label: DETAIL.otherSteps, steps: flatten(detail.spans) }]),
  ].filter((group) => group.steps.length > 0);

  return (
    <div>
      <div className={styles.traceViewHeading}>
        <h2>{DETAIL.views.execution}</h2>
        <p>{DETAIL.executionLead}</p>
      </div>
      {groups.length === 0 ? <Notice>{DETAIL.noStepsAtAll}</Notice> : (
        <div className={styles.executionGroups}>
          {groups.map((group) => (
            <section className={styles.executionGroup} key={group.id}>
              <h3>{group.label}</h3>
              {group.steps.map(({ step, depth }) => (
                <button
                  key={step.span_id}
                  className={`${styles.executionRow} ${selectedId === step.span_id ? styles.executionRowSelected : ""}`}
                  type="button"
                  style={{ "--execution-indent": `${Math.min(depth, 6) * 14}px` } as CSSProperties}
                  onClick={() => onSelect(step)}
                >
                  <span>
                    <strong>{presentedStepLabel(step)}</strong>
                    <small className={styles.mono}>{step.name}</small>
                  </span>
                  <span className={step.status === "error" ? styles.wrong : styles.muted}>
                    {step.status === "error" ? DETAIL.failed : howLong(step.duration_ns)}
                  </span>
                </button>
              ))}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

function Inspector({
  selected,
  facts,
  openedAt,
}: {
  selected: Step | null;
  facts: TraceFacts;
  openedAt: string;
}) {
  return (
    <aside className={styles.traceInspector} aria-label={DETAIL.inspector}>
      {selected === null ? (
        <p className={styles.muted}>{DETAIL.nothingSelected}</p>
      ) : (
        <>
          <div className={styles.inspectorHeader}>
            <p className={styles.eyebrow}>{presentedStepLabel(selected)}</p>
            <h2>{selected.text || selected.tool_name || selected.name}</h2>
            <p>{howFarIn(selected.started_at, openedAt)} · {howLong(selected.duration_ns)}</p>
          </div>

          <dl className={styles.inspectorFacts}>
            <div><dt>{FACTS.status}</dt><dd className={selected.status === "error" ? styles.wrong : undefined}>{readableStatus(selected.status)}</dd></div>
            <div><dt>{FACTS.started}</dt><dd>{whenItWas(selected.started_at)}</dd></div>
            <div><dt>{FACTS.duration}</dt><dd>{howLong(selected.duration_ns)}</dd></div>
          </dl>

          {selected.tool_name === "" ? null : (
            <section className={styles.inspectorSection}>
              <h3>{DETAIL.toolWork}</h3>
              <p className={styles.mono}>{selected.tool_name}</p>
              {selected.tool_arguments === "" ? null : <Payload label={FACTS.toolArguments} value={selected.tool_arguments} />}
              {selected.tool_result === "" ? null : <Payload label={FACTS.toolResult} value={selected.tool_result} />}
            </section>
          )}

          {selected.audio_url === "" ? null : (
            <p className={styles.inspectorLink}><a href={selected.audio_url}>{DETAIL.openAudio}</a></p>
          )}

          <details className={styles.inspectorDetails}>
            <summary>{DETAIL.technicalDetails}</summary>
            <Recorded step={selected} openedAt={openedAt} />
          </details>
        </>
      )}

      <details className={styles.inspectorDetails}>
        <summary>{DETAIL.recordingDetails}</summary>
        <RecordingDetails facts={facts} />
      </details>
    </aside>
  );
}

function Payload({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.payload}>
      <span>{label}</span>
      <pre>{value}</pre>
    </div>
  );
}

function RecordingDetails({ facts }: { facts: TraceFacts }) {
  const shown: readonly (readonly [string, string])[] = [
    [FACTS.started, whenItWas(facts.started_at)],
    [FACTS.ended, whenItWas(facts.ended_at)],
    [FACTS.source, facts.source],
    [FACTS.environment, facts.environment],
    [FACTS.connection, facts.connection_type],
    [FACTS.reference, facts.provider_call_id],
  ];

  return (
    <dl className={styles.recorded}>
      {shown.filter(([, value]) => value !== "").map(([label, value]) => (
        <div key={label}>
          <dt className={styles.muted}>{label}</dt>
          <dd className={styles.mono}>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Recorded({ step, openedAt }: { step: Step; openedAt: string }) {
  const shown: readonly (readonly [string, string])[] = [
    [FACTS.kind, stepLabel(step.kind)],
    [FACTS.name, step.name],
    [FACTS.status, step.status],
    [FACTS.started, `${whenItWas(step.started_at)} (${howFarIn(step.started_at, openedAt)})`],
    [FACTS.duration, howLong(step.duration_ns)],
    [FACTS.nanoseconds, step.duration_ns],
    [FACTS.identifier, step.span_id],
    [FACTS.within, step.parent_span_id],
    [FACTS.toolName, step.tool_name],
    [FACTS.toolArguments, step.tool_arguments],
    [FACTS.toolResult, step.tool_result],
    [FACTS.audio, step.audio_url],
  ];

  return (
    <dl className={styles.recorded}>
      {shown.filter(([, value]) => value !== "").map(([label, value]) => (
        <div key={label}>
          <dt className={styles.muted}>{label}</dt>
          <dd className={styles.mono}>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function flatten(steps: readonly Step[], depth = 0): PositionedStep[] {
  return steps.flatMap((step) => [
    { step, depth },
    ...flatten(step.spans, depth + 1),
  ]);
}

function positionedSteps(detail: Detail): PositionedStep[] {
  const seen = new Set<string>();
  return [...flatten(detail.turns), ...flatten(detail.spans)].filter(({ step }) => {
    if (seen.has(step.span_id)) return false;
    seen.add(step.span_id);
    return true;
  });
}

function readableStatus(status: string): string {
  return status === "" || status === "unset" ? DETAIL.notReported : status;
}

function presentedStepLabel(step: Step): string {
  const known = stepLabel(step.kind);
  if (known !== UNKNOWN_STEP_LABEL || step.name === "") return known;
  const words = step.name.replaceAll(/[_-]+/g, " ").trim();
  return words === "" ? known : `${words.slice(0, 1).toUpperCase()}${words.slice(1)}`;
}
