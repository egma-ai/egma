"use client";

import { use, useEffect, useState } from "react";

import {
  DETAIL,
  FACTS,
  LIST,
  SPEAKERS,
  stepLabel,
} from "../../../lib/transcript-copy.ts";
import {
  everyStep,
  howFarIn,
  howLong,
  isHuman,
  somethingFailed,
  stepsInside,
  whenItWas,
  turnsCited,
  type Detail,
  type Facts as TraceFacts,
  type Judgment,
  type Step,
} from "../../../lib/transcripts.ts";
import { Card, Screen, styles } from "../../ui.tsx";

/**
 * One exchange, read the way somebody actually reads one: **the transcript
 * first**, and the machinery underneath it only when asked.
 *
 * The order of the page is the argument it makes. A person opening this has a
 * question about an exchange their agent had — what was said, in what order,
 * and where the time went — and the timed steps inside a turn are the answer to
 * the third question, not the first. So turns are the page, each one opens onto
 * the steps that happened inside it, and each of those opens again onto exactly
 * what was recorded. Nothing is hidden and nothing is in the way.
 *
 * **The window travels in the address.** The endpoint under this page requires
 * one — a name is not a prefix of the store's filing order, so a lookup naming
 * only a name would have nothing to prune with and would read every partition
 * there is — and the row that linked here already knew when the exchange
 * happened. That is what makes this page a link somebody can send, and why
 * arriving without the two parameters is answered with an explanation rather
 * than an error.
 *
 * **Sparse coverage renders.** Providers differ in what they report: some send
 * no steps inside a turn at all, and LiveKit sends no recognition step because
 * what was heard rides the turn itself. Every one of those is a real answer
 * here and says so, because a page that quietly showed nothing would be
 * indistinguishable from one that had nothing to show.
 */

type State =
  | { status: "loading" }
  | { status: "signed-out" }
  | { status: "no-window" }
  | { status: "missing" }
  | { status: "failed"; why: string }
  | { status: "read"; detail: Detail };

export default function TranscriptPage({
  params,
}: {
  params: Promise<{ traceId: string }>;
}) {
  const { traceId } = use(params);
  const [state, setState] = useState<State>({ status: "loading" });

  useEffect(() => {
    let current = true;

    // Read from the address rather than from a router hook, because this is the
    // whole of what makes the page deep-linkable and the address is where a
    // link somebody was sent carries it.
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
    return <Card title={DETAIL.title}>{DETAIL.loading}</Card>;
  }

  if (state.status === "signed-out") {
    return (
      <Card title={LIST.signedOut} lead={LIST.signedOutLead}>
        <p style={styles.aside}>
          <a href="/sign-in">{LIST.signIn}</a> ·{" "}
          <a href="/signup">{LIST.setUp}</a>
        </p>
      </Card>
    );
  }

  if (state.status === "no-window") {
    return (
      <Card title={DETAIL.needsWindow} lead={DETAIL.needsWindowLead}>
        <p style={styles.aside}>
          <a href="/traces">{DETAIL.back}</a>
        </p>
      </Card>
    );
  }

  if (state.status === "missing") {
    return (
      <Card title={DETAIL.missing} lead={DETAIL.missingLead}>
        <p style={styles.aside}>
          <a href="/traces">{DETAIL.back}</a>
        </p>
      </Card>
    );
  }

  if (state.status === "failed") {
    return (
      <Card title={DETAIL.title}>
        <p style={styles.problem}>{state.why}</p>
        <p style={styles.aside}>
          <a href="/traces">{DETAIL.back}</a>
        </p>
      </Card>
    );
  }

  const { detail } = state;
  const openedAt = detail.trace.started_at;

  return (
    <Screen
      title={DETAIL.title}
      lead={whenItWas(openedAt)}
      aside={<a href="/traces">{DETAIL.back}</a>}
    >
      <Summary facts={detail.trace} />

      <h2 style={{ ...styles.title, fontSize: "1rem", marginTop: "2rem" }}>
        {DETAIL.transcript}
      </h2>

      {detail.spans_truncated ? (
        <p style={styles.problem}>{DETAIL.truncated}</p>
      ) : null}

      {detail.turns.length === 0 ? (
        <p style={styles.lead}>{DETAIL.noTurns}</p>
      ) : (
        detail.turns.map((turn, at) => (
          <div key={turn.span_id}>
            <Turn turn={turn} openedAt={openedAt} />
            {/* The judgments that read this turn, against the turn itself.
                A verdict citing turn 9 belongs beside turn 9 — reading it on
                another page means holding a transcript in your head. */}
            {(detail.verdicts ?? [])
              .filter((its) => turnsCited(its).includes(at + 1))
              .map((its) => (
                <Judged key={`${its.grader_id}:${its.dimension}:${its.judged_at}`} judgment={its} />
              ))}
          </div>
        ))
      )}

      {detail.spans.length === 0 ? null : (
        <details style={{ marginTop: "2rem" }}>
          <summary style={{ cursor: "pointer", fontWeight: 600 }}>
            {DETAIL.otherSteps}
          </summary>
          <p style={{ ...styles.aside, marginTop: "0.5rem" }}>
            {DETAIL.otherStepsLead}
          </p>
          {detail.spans.map((step) => (
            <Timed key={step.span_id} step={step} openedAt={openedAt} />
          ))}
        </details>
      )}
    </Screen>
  );
}

/** What the list already said about this exchange, said again in full. */
function Summary({ facts }: { facts: TraceFacts }) {
  const shown: readonly (readonly [string, string, boolean])[] = [
    [FACTS.started, whenItWas(facts.started_at), false],
    [FACTS.ended, whenItWas(facts.ended_at), false],
    [FACTS.duration, howLong(facts.duration_ns), false],
    [
      FACTS.turns,
      `${facts.turn_counts.human} ${LIST.human} · ${facts.turn_counts.agent} ${LIST.agent}`,
      false,
    ],
    [FACTS.steps, String(facts.span_count), false],
    [FACTS.tools, String(facts.tool_span_count), false],
    [
      FACTS.errors,
      String(facts.errored_span_count),
      facts.errored_span_count > 0,
    ],
    [FACTS.source, facts.source, false],
    [FACTS.environment, facts.environment, false],
    [FACTS.connection, facts.connection_type, false],
    [FACTS.reference, facts.provider_call_id, false],
  ];

  return (
    <div>
      {shown
        .filter(([, value]) => value !== "")
        .map(([label, value, wrong]) => (
          <div key={label} style={styles.definition}>
            <span style={styles.muted}>{label}</span>
            <strong style={wrong ? styles.wrong : undefined}>{value}</strong>
          </div>
        ))}
    </div>
  );
}

/**
 * One turn: who spoke, what they said, when, and what happened inside it.
 *
 * A `<details>` rather than a click handler, because that is what the element
 * is for — it opens with a keyboard, it is announced as expandable without an
 * aria attribute anybody has to remember to keep in step, and it works before
 * a line of this page's script has run.
 *
 * The failure marker is on the **summary**, not inside. A turn that failed four
 * adapters down is still the turn that failed, and somebody scanning a
 * transcript for what went wrong must not have to open all thirteen to find it.
 */
function Turn({ turn, openedAt }: { turn: Step; openedAt: string }) {
  const inside = stepsInside(turn);
  const failed = somethingFailed(turn);
  const human = isHuman(turn);

  return (
    <details
      style={{
        borderTop: "1px solid #eee",
        padding: "0.75rem 0",
      }}
    >
      <summary style={{ cursor: "pointer" }}>
        <span
          style={{
            display: "inline-block",
            minWidth: "4.5rem",
            fontWeight: 600,
            color: human ? "#444" : "#0b5",
          }}
        >
          {human ? SPEAKERS.human : SPEAKERS.agent}
        </span>
        {turn.text === "" ? (
          <span style={styles.muted}>{DETAIL.nothingSaid}</span>
        ) : (
          turn.text
        )}
        <span
          style={{
            ...styles.aside,
            display: "block",
            marginTop: "0.25rem",
            marginLeft: "4.5rem",
            fontSize: "0.8125rem",
          }}
        >
          {howFarIn(turn.started_at, openedAt)} · {howLong(turn.duration_ns)} ·{" "}
          {DETAIL.steps(inside)}
          {failed ? (
            <>
              {" · "}
              <span style={styles.wrong}>{DETAIL.failedInside}</span>
            </>
          ) : null}
        </span>
      </summary>

      <div style={{ marginLeft: "4.5rem", marginTop: "0.5rem" }}>
        {turn.spans.length === 0 ? (
          <p style={styles.aside}>{DETAIL.noSteps}</p>
        ) : (
          turn.spans.map((step) => (
            <Timed key={step.span_id} step={step} openedAt={openedAt} />
          ))
        )}
      </div>
    </details>
  );
}

/**
 * One timed step, and everything under it.
 *
 * The provider's own name for the step is shown beside egma's word for it,
 * because the two carry different information and neither replaces the other:
 * egma's says what kind of thing this is, and the provider's says which one —
 * LiveKit nests a model request four adapters deep and only the innermost names
 * the model that actually answered.
 *
 * Opening a step reaches exactly what was recorded about it. That is the
 * ticket's line: raw facts are **reachable from the expanded view, and not the
 * default presentation** — a transcript stops being one the moment it is a
 * table of columns.
 */
function Timed({ step, openedAt }: { step: Step; openedAt: string }) {
  const failed = step.status === "error";
  const marked = failed || everyStep(step.spans).some((one) => one.status === "error");

  return (
    <details
      style={{
        borderLeft: `2px solid ${marked ? "#b00020" : "#eee"}`,
        paddingLeft: "0.75rem",
        margin: "0.25rem 0",
      }}
    >
      <summary style={{ cursor: "pointer", fontSize: "0.875rem" }}>
        <strong>{stepLabel(step.kind)}</strong>
        <span style={styles.muted}>
          {" "}
          · <span style={styles.monospace}>{step.name}</span> ·{" "}
          {howLong(step.duration_ns)}
        </span>
        {failed ? (
          <>
            {" · "}
            <span style={styles.wrong}>{DETAIL.failed}</span>
          </>
        ) : null}
      </summary>

      <Recorded step={step} openedAt={openedAt} />

      {step.spans.map((child) => (
        <Timed key={child.span_id} step={child} openedAt={openedAt} />
      ))}
    </details>
  );
}

/** Everything the store holds about one step, once somebody has asked for it. */
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
    <dl
      style={{
        margin: "0.5rem 0",
        fontSize: "0.8125rem",
        display: "grid",
        gridTemplateColumns: "minmax(6rem, max-content) 1fr",
        gap: "0.125rem 0.75rem",
      }}
    >
      {shown
        .filter(([, value]) => value !== "")
        .map(([label, value]) => (
          <div key={label} style={{ display: "contents" }}>
            <dt style={styles.muted}>{label}</dt>
            <dd
              style={{
                ...styles.monospace,
                margin: 0,
                overflowWrap: "anywhere",
              }}
            >
              {value}
            </dd>
          </div>
        ))}
    </dl>
  );
}

const VERDICT_COLOR: Record<string, string> = {
  passed: "#1f7a3f",
  failed: "#b00020",
  skipped: "#8a6d00",
  errored: "#b00020",
};

/**
 * One judgment, against the turn it cites.
 *
 * The judge is named on every one. A verdict nobody can attribute is a verdict
 * nobody can argue with, and arguing with them is how a suite gets better.
 */
function Judged({ judgment }: { judgment: Judgment }) {
  return (
    <div
      style={{
        margin: "0 0 0.5rem 1.25rem",
        padding: "0.5rem 0.75rem",
        borderLeft: `3px solid ${VERDICT_COLOR[judgment.verdict] ?? "#999"}`,
        background: "#fafafa",
      }}
    >
      <div style={{ display: "flex", gap: "0.5rem", alignItems: "baseline" }}>
        <span
          style={{
            color: VERDICT_COLOR[judgment.verdict] ?? "#111",
            fontWeight: 600,
            fontSize: "0.875rem",
          }}
        >
          {judgment.verdict}
        </span>
        <span style={styles.monospace}>{judgment.dimension}</span>
        <span style={{ ...styles.muted, fontSize: "0.8125rem" }}>
          {judgment.priority}
        </span>
      </div>
      <p style={{ margin: "0.25rem 0 0.25rem", fontSize: "0.9375rem", lineHeight: 1.5 }}>
        {judgment.rationale}
      </p>
      <p style={{ ...styles.muted, margin: 0, fontSize: "0.8125rem" }}>
        judged by <span style={styles.monospace}>{judgment.judged_by}</span>
      </p>
    </div>
  );
}
