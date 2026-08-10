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
  type Detail,
  type Facts as TraceFacts,
  type Step,
} from "../../../lib/transcripts.ts";
import { AppShell, Notice, ProductPage, StatePage, styles } from "../../ui.tsx";

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
    return <StatePage title={DETAIL.title} lead={DETAIL.loading} />;
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
      <StatePage title={DETAIL.needsWindow} lead={DETAIL.needsWindowLead}>
        <p className={styles.linkLine}>
          <a href="/traces">{DETAIL.back}</a>
        </p>
      </StatePage>
    );
  }

  if (state.status === "missing") {
    return (
      <StatePage title={DETAIL.missing} lead={DETAIL.missingLead}>
        <p className={styles.linkLine}>
          <a href="/traces">{DETAIL.back}</a>
        </p>
      </StatePage>
    );
  }

  if (state.status === "failed") {
    return (
      <StatePage title={DETAIL.title}>
        <Notice tone="error">{state.why}</Notice>
        <p className={styles.linkLine}>
          <a href="/traces">{DETAIL.back}</a>
        </p>
      </StatePage>
    );
  }

  const { detail } = state;
  const openedAt = detail.trace.started_at;

  return (
    <AppShell active="transcripts">
      <ProductPage>
        <a className={styles.backLink} href="/traces">← {DETAIL.back}</a>
        <header className={styles.detailHeader}>
          <div>
            <p className={styles.eyebrow}>{detail.trace.source} / {detail.trace.environment}</p>
            <h1>{DETAIL.title}</h1>
            <p>{whenItWas(openedAt)} · {howLong(detail.trace.duration_ns)}</p>
            {detail.trace.provider_call_id === "" ? null : <p className={styles.detailReference}>{FACTS.reference}: <span className={styles.mono}>{detail.trace.provider_call_id}</span></p>}
          </div>
          <span className={`${styles.status} ${detail.trace.errored_span_count > 0 ? styles.statusBad : ""}`}>{detail.trace.errored_span_count === 0 ? "Recorded" : `${detail.trace.errored_span_count} errors`}</span>
        </header>
        <Summary facts={detail.trace} />

        <div className={styles.transcript}>
          <h2 className={styles.sectionTitle}>{DETAIL.transcript}</h2>
          {detail.spans_truncated ? <Notice tone="error">{DETAIL.truncated}</Notice> : null}
          {detail.turns.length === 0 ? <Notice>{DETAIL.noTurns}</Notice> : detail.turns.map((turn) => <Turn key={turn.span_id} turn={turn} openedAt={openedAt} />)}
          {detail.spans.length === 0 ? null : (
            <details className={styles.otherSteps}>
              <summary>{DETAIL.otherSteps}</summary><p className={styles.muted}>{DETAIL.otherStepsLead}</p>
              {detail.spans.map((step) => <Timed key={step.span_id} step={step} openedAt={openedAt} />)}
            </details>
          )}
        </div>
      </ProductPage>
    </AppShell>
  );
}

/** What the list already said about this exchange, said again in full. */
function Summary({ facts }: { facts: TraceFacts }) {
  const primary: readonly (readonly [string, string, boolean])[] = [
    [FACTS.duration, howLong(facts.duration_ns), false],
    [
      FACTS.turns,
      `${facts.turn_counts.human} ${LIST.human} · ${facts.turn_counts.agent} ${LIST.agent}`,
      false,
    ],
    [FACTS.tools, String(facts.tool_span_count), false],
    [
      FACTS.errors,
      String(facts.errored_span_count),
      facts.errored_span_count > 0,
    ],
  ];

  const more: readonly (readonly [string, string, boolean])[] = [
    [FACTS.started, whenItWas(facts.started_at), false], [FACTS.ended, whenItWas(facts.ended_at), false],
    [FACTS.steps, String(facts.span_count), false], [FACTS.source, facts.source, false],
    [FACTS.environment, facts.environment, false], [FACTS.connection, facts.connection_type, false],
    [FACTS.reference, facts.provider_call_id, false],
  ];

  return (
    <>
      <section className={styles.detailFacts}>{primary.map(([label, value, wrong]) => <div className={styles.contextFact} key={label}><span>{label}</span><strong className={wrong ? styles.wrong : undefined}>{value}</strong></div>)}</section>
      <details className={styles.otherSteps}>
        <summary>Technical details</summary>
        <dl className={styles.definitionList}>{more.filter(([, value]) => value !== "").map(([label, value, wrong]) => <div className={styles.definitionRow} key={label}><dt>{label}</dt><dd className={wrong ? styles.wrong : undefined}>{value}</dd></div>)}</dl>
      </details>
    </>
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
    <details className={styles.turn}>
      <summary>
        <span className={styles.turnSpeaker}>
          {human ? SPEAKERS.human : SPEAKERS.agent}
        </span>
        <span className={styles.turnText}>
          {turn.text === "" ? <span className={styles.muted}>{DETAIL.nothingSaid}</span> : turn.text}
          <small className={styles.turnMeta}>{howFarIn(turn.started_at, openedAt)} · {howLong(turn.duration_ns)} · {DETAIL.steps(inside)}{failed ? <> · <span className={styles.wrong}>{DETAIL.failedInside}</span></> : null}</small>
        </span>
        <span className={styles.turnMarker}>+</span>
      </summary>

      <div className={styles.turnBody}>
        {turn.spans.length === 0 ? (
          <p className={styles.muted}>{DETAIL.noSteps}</p>
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
    <details className={`${styles.step} ${marked ? styles.stepFailed : ""}`}>
      <summary>
        <strong>{stepLabel(step.kind)}</strong>
        <span className={styles.muted}>
          {" "}· <span className={styles.mono}>{step.name}</span> ·{" "}
          {howLong(step.duration_ns)}
        </span>
        {failed ? (
          <>
            {" · "}
            <span className={styles.wrong}>{DETAIL.failed}</span>
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
    <dl className={styles.recorded}>
      {shown
        .filter(([, value]) => value !== "")
        .map(([label, value]) => (
          <div key={label}>
            <dt className={styles.muted}>{label}</dt>
            <dd className={styles.mono}>
              {value}
            </dd>
          </div>
        ))}
    </dl>
  );
}
