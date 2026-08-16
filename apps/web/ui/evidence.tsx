"use client";

import type { CSSProperties, ReactNode } from "react";

import {
  citedTurnPositions,
  type EvidenceCoverage,
  type EvidenceMockTool,
  type EvidencePlanItem,
  type EvidenceStep,
  type EvidenceTranscript,
  type JudgedAssertion,
} from "../lib/simulations.ts";
import { howFarIn, howLong, milliseconds } from "../lib/transcripts.ts";
import { Badge, Help } from "./controls.tsx";
import { Empty } from "./page-state.tsx";
import { VerdictBadge } from "./run-status.tsx";
import styles from "./evidence.module.css";

/**
 * The parts one conversation's evidence page is built from.
 *
 * **Each one takes finished data and decides nothing.** A transcript is handed
 * turns; the timed view is handed steps; the verdict block is handed a judged
 * dimension that has already been folded. That is what makes them reusable and
 * what makes them tunable: their appearance is `evidence.module.css` and their
 * contract is `lib/simulations.ts`, and neither can be changed by touching the
 * other. A component that fetched, folded or filtered would put a second opinion
 * inside the page and the two would disagree the day somebody changed one.
 *
 * They live in their own file with their own stylesheet, beside `run-status.tsx`
 * and for the same reason: the shared system in `controls.tsx` and
 * `system.module.css` is deliberately held closed.
 *
 * **Speech, timing and judgement stay three things.** The transcript is what was
 * said and nothing else — tool calls and system work are not interleaved into
 * it, because a transcript with machinery in the middle of it stops being
 * readable as a conversation. The timed view is where those meet, on one clock.
 * And a verdict is never drawn inside a turn: judging is a separate act from
 * speaking, and a page that mixed them would let a reader take a grader's
 * sentence for something the agent said.
 */

/* ------------------------------------------------------------------------ *
 * What was said.
 * ------------------------------------------------------------------------ */

/** The two words the domain model labels a transcript's speakers with. */
export const SPEAKERS = { human: "human:", agent: "agent:" } as const;

function isHuman(turn: EvidenceStep): boolean {
  return turn.kind === "turn:human";
}

function everyStep(steps: readonly EvidenceStep[]): EvidenceStep[] {
  return steps.flatMap((step) => [step, ...everyStep(step.spans)]);
}

export type TranscriptProps = {
  readonly transcript: EvidenceTranscript;
  /**
   * Turn positions to mark, one-based — the turns a judgement somebody is
   * reading cites. Empty marks nothing, which is the ordinary state.
   */
  readonly highlighted?: readonly number[];
};

/**
 * What the persona and the agent said, in the order they said it.
 *
 * Compact `human:` / `agent:` labels and normal reading density, on purpose. A
 * stack of oversized message cards puts two turns on a screen, and this is the
 * one surface where somebody is trying to hold a whole conversation in their
 * head at once.
 *
 * What happened *inside* a turn is counted here and shown in the timed view.
 * Putting a tool call between two sentences would break the reading, and hiding
 * it would lose it — so it is named and lives one component down.
 */
export function Transcript({ transcript, highlighted = [] }: TranscriptProps) {
  const marked = new Set(highlighted);
  const openedAt = transcript.started_at;

  if (transcript.turns.length === 0) {
    return (
      <Empty
        title="Nothing was said"
        lead="Egma filed steps for this simulation but no turns. Whatever happened, nobody spoke."
      />
    );
  }

  return (
    <div className={styles.transcript}>
      {transcript.turns.map((turn, at) => {
        const inside = everyStep(turn.spans);
        const failed = inside.some((step) => step.status === "error");
        return (
          <div
            key={turn.span_id}
            className={`${styles.turn} ${marked.has(at + 1) ? styles.turnCited : ""}`}
            data-turn={String(at + 1)}
          >
            <p
              className={`${styles.speaker} ${isHuman(turn) ? styles.speakerHuman : ""}`}
            >
              {isHuman(turn) ? SPEAKERS.human : SPEAKERS.agent}
            </p>
            <div>
              <p className={styles.said}>
                {turn.text === "" ? (
                  <span className={styles.saidNothing}>Nothing was said.</span>
                ) : (
                  turn.text
                )}
              </p>
              <p className={styles.turnAside}>
                <span>{howFarIn(turn.started_at, openedAt)}</span>
                <span>{howLong(turn.duration_ns)}</span>
                {inside.length === 0 ? null : (
                  <span>
                    {inside.length} step{inside.length === 1 ? "" : "s"}
                  </span>
                )}
                {failed ? (
                  <span className={styles.wrong}>something failed inside</span>
                ) : null}
              </p>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------------ *
 * When it happened.
 * ------------------------------------------------------------------------ */

type Placed = { readonly step: EvidenceStep; readonly depth: number };

function flatten(steps: readonly EvidenceStep[], depth = 0): Placed[] {
  return steps.flatMap((step) => [
    { step, depth },
    ...flatten(step.spans, depth + 1),
  ]);
}

/** What a stored step kind is called where a person reads it. */
const STEP_LABELS: Readonly<Record<string, string>> = {
  "turn:human": "Human turn",
  "turn:agent": "Agent turn",
  tool: "Tool call",
  llm: "Model call",
  stt: "Speech to text",
  tts: "Text to speech",
  system: "System",
};

function labelFor(step: EvidenceStep): string {
  const known = STEP_LABELS[step.kind];
  if (known !== undefined) return known;
  const words = step.name.replaceAll(/[_-]+/gu, " ").trim();
  return words === ""
    ? "Step"
    : `${words.slice(0, 1).toUpperCase()}${words.slice(1)}`;
}

/**
 * Speech, tool work and system steps on one clock.
 *
 * **This is where the three meet, and the transcript is where they do not.** A
 * tool call belongs to a moment in the conversation and a reader who doubts a
 * turn wants to see what the agent was doing while it said that — so every step
 * is here, in time order, indented by where it sat, with a bar for how long it
 * took. What none of it does is get folded into the transcript above: the
 * transcript stays a conversation.
 */
export function ExecutionTimeline({
  transcript,
}: {
  readonly transcript: EvidenceTranscript;
}) {
  const steps = [...flatten(transcript.turns), ...flatten(transcript.spans)];
  if (steps.length === 0) {
    return (
      <Empty
        title="Nothing was timed"
        lead="This simulation filed no steps, so there is nothing to put on a clock."
      />
    );
  }

  const total = Math.max(milliseconds(transcript.duration_ns), 1);
  const openedAt = Date.parse(transcript.started_at);

  return (
    <div className={styles.scrolls}>
      <div className={styles.timeline}>
        {steps.map(({ step, depth }) => {
          const offset = Math.max(Date.parse(step.started_at) - openedAt, 0);
          const took = Math.max(milliseconds(step.duration_ns), 0);
          const left = Math.min((offset / total) * 100, 100);
          // A floor of just under a percent, so a step that took a millisecond
          // is still a mark somebody can see rather than nothing at all.
          const width = Math.max(Math.min((took / total) * 100, 100 - left), 0.8);
          const failed = step.status === "error";

          return (
            <div
              key={step.span_id}
              className={styles.timelineRow}
              style={
                {
                  "--timeline-left": `${String(left)}%`,
                  "--timeline-width": `${String(width)}%`,
                } as CSSProperties
              }
            >
              <span className={styles.timelineAt}>
                {howFarIn(step.started_at, transcript.started_at)}
              </span>
              <span
                className={styles.timelineWhat}
                style={{ paddingLeft: `${String(Math.min(depth, 6) * 12)}px` }}
              >
                <strong>{labelFor(step)}</strong>
                <span>{step.tool_name === "" ? step.name : step.tool_name}</span>
              </span>
              <span
                className={`${styles.timelineTrack} ${failed ? styles.timelineTrackBad : ""}`}
                aria-hidden="true"
              >
                <span />
              </span>
              <span
                className={`${styles.timelineHow} ${failed ? styles.timelineHowBad : ""}`}
              >
                {failed ? "failed" : howLong(step.duration_ns)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------ *
 * What was measured.
 * ------------------------------------------------------------------------ */

/**
 * How each measure is named and written where a person reads it.
 *
 * A measure the simulator never emitted is simply absent from the answer, so
 * there is no row for it here either — a slot drawn for every measure the
 * catalog names would report a zero for something nothing counted.
 */
const MEASURES: Readonly<
  Record<string, { readonly label: string; readonly shown: (n: number) => string }>
> = {
  duration_ms: {
    label: "Duration",
    shown: (n) => (n < 1000 ? `${String(n)} ms` : `${(n / 1000).toFixed(1)} s`),
  },
  turn_count: { label: "Turns", shown: String },
  human_turn_count: { label: "Human turns", shown: String },
  agent_turn_count: { label: "Agent turns", shown: String },
  tool_call_count: { label: "Tool calls", shown: String },
  errored_step_count: { label: "Errored steps", shown: String },
  measured_audio_band_hertz: {
    label: "Audio band",
    shown: (n) => `${String(n)} Hz`,
  },
  interruption_count: { label: "Interruptions", shown: String },
  cost_cents: { label: "Cost", shown: (n) => `${(n / 100).toFixed(2)}` },
};

/**
 * What was **measured**, and never what was judged.
 *
 * A metric measures and a grader judges, and that line is the reason this is its
 * own block instead of sitting among the verdicts. Nobody wrote down that the
 * conversation took four minutes; somebody had to decide that confirming a
 * booking matters. Only what is actually known appears — a chat has no audio
 * band, and a conversation that never connected has no duration.
 */
export function Measures({
  measures,
}: {
  readonly measures: Readonly<Record<string, number>>;
}) {
  const entries = Object.entries(measures);
  if (entries.length === 0) {
    return (
      <Empty
        title="Nothing was measured"
        lead="This simulation reported no measures. Egma does not invent one, and a zero here would be a number nobody counted."
      />
    );
  }

  return (
    <dl className={styles.measures}>
      {entries.map(([name, value]) => {
        const how = MEASURES[name];
        return (
          <div className={styles.measure} key={name}>
            <dt>{how?.label ?? name.replaceAll("_", " ")}</dt>
            <dd>{how === undefined ? String(value) : how.shown(value)}</dd>
          </div>
        );
      })}
    </dl>
  );
}

/* ------------------------------------------------------------------------ *
 * The mocked world.
 * ------------------------------------------------------------------------ */

/**
 * Which of the agent's tools egma answered for, and which ran for real.
 *
 * **The absence of a stamp is a fact of its own**, and it is said out loud: no
 * stamp means nothing ever asked the agent what tools it has, while three empty
 * lists mean the asking happened and nothing came back. A mocked conversation
 * and an unmocked one are different units, exactly as two audio bands are, and
 * this is where a reader comparing two of them finds out which they have.
 *
 * There is no authoring here and there never will be: this is a record of what
 * was served, and a control that edited a mock tool from a conversation's page
 * would edit the project's world from inside evidence about the past.
 */
export function MockToolEvidence({
  coverage,
  defaults,
  overrides,
}: {
  readonly coverage: EvidenceCoverage | null;
  readonly defaults: readonly EvidenceMockTool[];
  readonly overrides: readonly EvidenceMockTool[];
}) {
  const frozen = [...defaults, ...overrides];

  if (coverage === null && frozen.length === 0) {
    return (
      <Empty
        title="Nothing was mocked, and nothing was asked"
        lead="This run froze no mocked answers, and nobody asked the agent what tools it has — so egma stood in the path of nothing and claims nothing about what ran."
      />
    );
  }

  return (
    <div className={styles.tools}>
      {frozen.length === 0 ? null : (
        <div className={styles.toolGroup}>
          <strong>Frozen for this simulation</strong>
          {frozen.map((one) => (
            <span className={styles.tool} key={`frozen:${one.tool_name}`}>
              {one.tool_name}
            </span>
          ))}
        </div>
      )}

      {coverage === null ? (
        <Help>
          Nobody asked the agent what tools it has, so nothing was learned about
          coverage. That is not the same as nothing being mocked.
        </Help>
      ) : (
        <>
          <div className={styles.toolGroup}>
            <strong>Answered by egma</strong>
            {coverage.covered.length === 0 ? (
              <span className={styles.mono}>none</span>
            ) : (
              coverage.covered.map((name) => (
                <span className={styles.tool} key={`covered:${name}`}>
                  {name}
                </span>
              ))
            )}
          </div>
          <div className={styles.toolGroup}>
            <strong>Ran for real</strong>
            {coverage.uncovered.length === 0 ? (
              <span className={styles.mono}>none</span>
            ) : (
              coverage.uncovered.map((name) => (
                <span
                  className={`${styles.tool} ${styles.toolUncovered}`}
                  key={`uncovered:${name}`}
                >
                  {name}
                </span>
              ))
            )}
          </div>
          <Help>
            Egma never stood in the path of a tool it did not answer for, so
            those calls happened natively and unobserved. A simulation with
            uncovered tools is a different unit from one without.
          </Help>
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------------ *
 * What egma made of it.
 * ------------------------------------------------------------------------ */

/**
 * One judged assertion: what counts now, why, and the judgments underneath it.
 *
 * **An earlier judgment is preserved and shown, never replaced.** A re-grade
 * writes a new row beside the old one, and a page that hid the old one would
 * make "this grader was tightened and now disagrees" invisible.
 *
 * **A diagnostic says so on the card.** A `required: false` copy is judged
 * exactly like any other and can fail nothing, so a red badge with no marking
 * beside it would read as a reason the run failed. That marking is what keeps
 * the header and the evidence beneath it from disagreeing.
 *
 * `action` is where a page puts whatever it offers about this judgement, or
 * nothing at all for somebody who may not. This component never decides that:
 * what a role may do is the server's answer and the page's to relay.
 */
export function VerdictEvidence({
  judged,
  turns,
  action,
  children,
}: {
  readonly judged: JudgedAssertion;
  /** The transcript's turns, so cited spans can be named by position. */
  readonly turns: readonly EvidenceStep[];
  readonly action?: ReactNode;
  /** Whatever the page opens under this row. */
  readonly children?: ReactNode;
}) {
  const { speaking } = judged;
  const cited = citedTurnPositions(speaking.cited_turns, turns);

  return (
    <article className={styles.verdict} data-assertion={judged.assertion}>
      <header className={styles.verdictHead}>
        <span className={styles.verdictWhat}>
          {/*
            The words where they could be resolved, and the bare key where they
            could not. A guessed sentence would be unfalsifiable; a key is
            merely terse.
          */}
          <strong>{judged.assertionText ?? judged.assertion}</strong>
          <span className={styles.verdictWho}>{judged.graderId}</span>
        </span>
        {judged.required ? null : (
          <Badge title="A diagnostic: judged and reported, and never able to fail this simulation.">
            Reports only
          </Badge>
        )}
        <VerdictBadge verdict={speaking.verdict} />
        <span className={styles.mono}>
          {speaking.score.toFixed(2)}
        </span>
        {action}
      </header>

      <p className={styles.rationale}>{speaking.rationale}</p>
      {cited.length === 0 ? null : (
        <p className={styles.cited}>
          Cites turn{cited.length === 1 ? "" : "s"} {cited.join(", ")}
        </p>
      )}

      {judged.superseded.length === 0 ? null : (
        <details className={styles.beneath}>
          <summary>
            {judged.superseded.length} earlier judgement
            {judged.superseded.length === 1 ? "" : "s"} of this assertion
          </summary>
          {judged.superseded.map((row) => (
            <p className={styles.cited} key={row.judged_at}>
              <span className={styles.mono}>{row.judged_at}</span>{" "}
              {row.verdict} — {row.rationale}
            </p>
          ))}
        </details>
      )}

      {children}
    </article>
  );
}

/**
 * The plan this conversation was judged under, item by item.
 *
 * The judge is named on every row and never carries a key — a configured choice
 * is a provider, a model and a *reference*, and there is no field here a secret
 * could travel in.
 */
export function PlanItems({
  items,
}: {
  readonly items: readonly EvidencePlanItem[];
}) {
  if (items.length === 0) {
    return (
      <Empty
        title="No grading plan was recorded for this simulation"
        lead="Egma will not reconstruct one from today's graders, because that would be a claim about an old run that nobody can check."
      />
    );
  }

  return (
    <ul className={styles.plan}>
      {items.map((item) => (
        <li
          className={styles.planItem}
          key={`${item.grader_id}:${item.grader_version_id}`}
        >
          <strong>{item.name}</strong>
          <span className={styles.planNote}>
            {`${item.required ? "blocks" : "reports only"} · ${item.grader_version_id}`}
            {" · "}
            {item.judge.tag === "configured"
              ? `${item.judge.provider}/${item.judge.model} · ${item.judge.source === "platform" ? "platform key" : `credential ${item.judge.source}`}`
              : item.judge.tag === "not_required"
                ? "no judge needed"
                : "no judge recorded at capture"}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** The block a page shows while grading is still outstanding. */
export function GradingPending({ what }: { readonly what: string }) {
  return <p className={styles.pending}>{what}</p>;
}

/*
 * **There was a `CorrectionForm` here.** It was where a page put the form it
 * opened under one judgement, and it goes with the endpoint behind it:
 * ADR-0009 takes corrections out of v0, and they return as the reserved
 * `human` grader type writing rows of its own.
 */
