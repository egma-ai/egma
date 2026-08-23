"use client";

import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

import { asSecond } from "../lib/instants.ts";
import {
  citedTurnPositions,
  type EvidenceCoverage,
  type EvidenceMockTool,
  type EvidencePlanItem,
  type EvidenceStep,
  type EvidenceTranscript,
  type JudgedAssertion,
} from "../lib/simulations.ts";
import { graderDisplayName } from "../lib/presentation.ts";
import { howFarIn, howLong } from "../lib/transcripts.ts";
import { Help } from "./form.tsx";
import { Empty } from "./page-state.tsx";
import { VerdictBadge } from "./run-status.tsx";

/**
 * The parts one conversation's evidence page is built from.
 *
 * **Each one takes finished data and decides nothing.** A transcript is handed
 * turns; the timed view is handed steps; the verdict block is handed a judged
 * dimension that has already been folded. That is what makes them reusable and
 * what makes them tunable: their appearance is the class list on each element
 * and their contract is `lib/simulations.ts`, and neither can be changed by
 * touching the other. A component that fetched, folded or filtered would put a
 * second opinion inside the page and the two would disagree the day somebody
 * changed one.
 *
 * They live in their own file, beside `run-status.tsx` and for the same
 * reason: the shared component set is deliberately held closed.
 *
 * **Speech, timing and judgement stay three things.** The transcript is what was
 * said and nothing else — tool calls and system work are not interleaved into
 * it, because a transcript with machinery in the middle of it stops being
 * readable as a conversation. The timed view is where those meet, on one clock.
 * And a verdict is never drawn inside a turn: judging is a separate act from
 * speaking, and a page that mixed them would let a reader take a grader's
 * sentence for something the agent said.
 *
 * **The appearance is Tailwind on the shadcn base**, and `evidence.module.css`
 * is gone with it. What it said about these surfaces still holds and is worth
 * keeping: a transcript stays prose, a timeline stays a clock, a measure stays
 * a number, and a verdict stays a judgement. They share the palette and the
 * hairlines without those four different facts becoming one card pattern.
 *
 * What each surface *is* moved from a module class name onto `data-slot`, and
 * the one state a class name used to carry moved onto `data-cited`. Neither is
 * styled by anything. They are there because a name like `turnCited` was
 * readable in an inspector or a test and a class list is not.
 */

/**
 * The quiet hover tint on a row, and the one colour here that is written out
 * rather than named.
 *
 * The theme names the derived values that mean something on their own — a
 * status chip's edge, the dialog scrim. This is not one of those. It is
 * `--surface-soft` held back to 62% so a row lights up under the pointer
 * without becoming a surface of its own, and nothing else in the product wants
 * it. A token would be a name with one caller, so the recipe stays an arbitrary
 * value here; a second surface that ever wants the same tint earns the token
 * then.
 */
const ROW_HOVER =
  "pointer-hover:bg-[color-mix(in_srgb,var(--surface-soft)_62%,transparent)]";

/** Identifiers, scores and clock times, in the shared monospace face. */
const MONO = "font-mono text-sm text-muted-foreground";

/** The same face for a paragraph, which has a margin to drop. */
const CITED = ["m-0", MONO];

/**
 * The marker on a disclosure, drawn rather than typed.
 *
 * It is a clipped square in the current colour, so it follows the text it sits
 * beside instead of arriving as a second colour decision, and it turns on
 * `transform` alone. Reduced motion keeps the turn and drops the movement.
 */
const DISCLOSURE = [
  "list-none [&::-webkit-details-marker]:hidden",
  "before:flex-none before:bg-current before:content-['']",
  "before:[clip-path:polygon(25%_12%,75%_50%,25%_88%)]",
  "before:origin-center before:transition-transform",
  "before:duration-(--duration-popover-in) before:ease-in-out",
  "group-open:before:rotate-90",
  "motion-reduce:before:transition-none",
];

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
  /**
   * Timing and nested-step metadata belong on diagnostic views, not on the
   * evidence reading surface. The transcript remains the same semantic list.
   */
  readonly showMetadata?: boolean;
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
export function Transcript({
  transcript,
  highlighted = [],
  showMetadata = true,
}: TranscriptProps) {
  const marked = new Set(highlighted);
  const openedAt = transcript.startedAt;

  if (transcript.turns.length === 0) {
    return (
      <Empty
        title="Nothing was said"
        lead="Egma filed steps for this simulation but no turns. Whatever happened, nobody spoke."
      />
    );
  }

  return (
    <div
      className="flex flex-col overflow-hidden rounded-card border border-border bg-surface"
      data-slot="transcript"
    >
      {/*
       * The head the board draws over a transcript (`WU-0`): what this panel
       * is at the leading edge, and how much of it there is at the other. The
       * count and the clock are the mono tabular pair every figure in this
       * product wears, so two transcripts side by side line up.
       */}
      <div
        className={cn(
          "flex min-h-(--row-height) flex-none items-center justify-between gap-3",
          "border-b border-border bg-surface-soft px-5 py-2",
        )}
      >
        <strong className="text-sm font-medium text-foreground">Transcript</strong>
        <span className="font-mono text-sm text-faint tabular-nums">
          {transcript.turns.length} turn{transcript.turns.length === 1 ? "" : "s"}
          {" · "}
          {howLong(transcript.durationNs)}
        </span>
      </div>
      {transcript.turns.map((turn, at) => {
        const inside = everyStep(turn.spans);
        const failed = inside.some((step) => step.status === "error");
        const cited = marked.has(at + 1);
        return (
          <div
            key={turn.spanId}
            id={`transcript-turn-${String(at + 1)}`}
            className={cn(
              "grid grid-cols-[68px_minmax(0,1fr)] items-baseline gap-4 px-5 py-4",
              /* The leading edge is always there and usually invisible, so a
                 cited turn colours it rather than moving the text along. */
              "border-s-[3px] border-s-transparent",
              /* The head above supplies the first line, so every turn takes one. */
              "border-t border-t-border",
              /* A verdict points here. */
              cited && "border-s-brand bg-selected",
              /* Somebody followed a `Cites turn 3` link to this turn. The
                 scroll margin keeps it clear of whatever is pinned above. */
              "target:scroll-mt-10 target:border-s-brand target:bg-surface-soft",
              /* A cited turn is already lit, so it does not also light up. */
              !cited && ROW_HOVER,
              /* Narrow, the speaker label sits above what was said. */
              "max-[40rem]:grid-cols-[1fr] max-[40rem]:gap-1",
            )}
            data-turn={String(at + 1)}
            data-cited={cited ? "true" : undefined}
          >
            <p
              className={cn(
                "m-0 font-mono text-sm whitespace-nowrap text-muted-foreground",
                isHuman(turn) && "text-foreground",
              )}
            >
              {isHuman(turn) ? SPEAKERS.human : SPEAKERS.agent}
            </p>
            <div>
              <p className="m-0 text-sm whitespace-pre-wrap text-foreground">
                {turn.text === "" ? (
                  <span className="text-faint italic">Nothing was said.</span>
                ) : (
                  turn.text
                )}
              </p>
              {!showMetadata ? null : (
                <p
                  className={cn(
                    "mx-0 mt-1 mb-0 flex flex-wrap gap-2",
                    "text-sm text-muted-foreground tabular-nums",
                    /*
                     * The dot between two facts. It is a child selector because
                     * which facts are here changes with the turn, and only the
                     * ones after the first take a separator.
                     */
                    "[&>*+*]:before:me-2 [&>*+*]:before:content-['·']",
                  )}
                >
                  <span>{howFarIn(turn.startedAt, openedAt)}</span>
                  <span>{howLong(turn.durationNs)}</span>
                  {inside.length === 0 ? null : (
                    <span>
                      {inside.length} step{inside.length === 1 ? "" : "s"}
                    </span>
                  )}
                  {failed ? (
                    <span className="font-medium text-failure">
                      something failed inside
                    </span>
                  ) : null}
                  {cited ? (
                    <span className="text-foreground">cited by a verdict</span>
                  ) : null}
                </p>
              )}
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

/** Whether this stored tree is another wrapper around a projected turn. */
function containsTurn(
  step: EvidenceStep,
  turnIds: ReadonlySet<string>,
): boolean {
  return (
    turnIds.has(step.spanId) ||
    step.spans.some((inside) => containsTurn(inside, turnIds))
  );
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
 * Speech, tool work and system steps in one ordered flow.
 *
 * **This is where the three meet, and the transcript is where they do not.** A
 * tool call belongs to a moment in the conversation and a reader who doubts a
 * turn wants to see what the agent was doing while it said that. The default
 * flow therefore shows turns and top-level system events as milestones. Work
 * inside one milestone stays in a closed disclosure until somebody asks for
 * it. Stored span ids and raw internal names do not become the interface.
 */
export function ExecutionTimeline({
  transcript,
}: {
  readonly transcript: EvidenceTranscript;
}) {
  const turnIds = new Set(transcript.turns.map((turn) => turn.spanId));
  const standalone = transcript.spans.filter(
    (step) => !containsTurn(step, turnIds),
  );
  const milestones = [...transcript.turns, ...standalone].sort(
    (left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt),
  );
  if (milestones.length === 0) {
    return (
      <Empty
        title="Nothing was timed"
        lead="This simulation filed no steps, so there is nothing to put on a clock."
      />
    );
  }

  return (
    <ol
      className={cn(
        "m-0 flex list-none flex-col overflow-hidden p-0",
        "rounded-card border border-border bg-surface",
      )}
      aria-label="Execution flow"
      data-slot="execution-timeline"
    >
      {milestones.map((step) => {
        const inside = flatten(step.spans);
        const failed = step.status === "error";
        const containsFailedStep = inside.some(
          (nested) => nested.step.status === "error",
        );
        const detail = step.kind === "tool" ? step.toolName : "";
        return (
          <li
            className={cn(
              "min-w-0 px-4 py-2 text-sm",
              "not-first:border-t not-first:border-t-border",
              ROW_HOVER,
            )}
            key={step.spanId}
          >
            <div
              className={cn(
                "grid min-h-(--tap-target) items-center gap-3",
                "grid-cols-[56px_12px_minmax(0,1fr)_max-content]",
                /* Narrow, the duration drops under the step it belongs to. */
                "max-[40rem]:grid-cols-[48px_12px_minmax(0,1fr)]",
              )}
            >
              <span className="font-mono text-muted-foreground tabular-nums">
                {howFarIn(step.startedAt, transcript.startedAt)}
              </span>
              <span
                className="size-2 rounded-chip border-2 border-foreground bg-surface"
                aria-hidden="true"
              />
              <span className="flex min-w-0 items-baseline gap-2">
                <strong className="font-medium text-foreground">
                  {labelFor(step)}
                </strong>
                {detail === "" ? null : (
                  <span className="overflow-hidden font-mono text-ellipsis whitespace-nowrap text-muted-foreground">
                    {detail}
                  </span>
                )}
              </span>
              <span
                className={cn(
                  "flex flex-col items-end gap-1 text-end",
                  "font-mono text-muted-foreground tabular-nums",
                  "max-[40rem]:col-start-3 max-[40rem]:items-start max-[40rem]:text-start",
                  failed && "font-medium text-failure",
                )}
              >
                <span>{failed ? "Failed" : howLong(step.durationNs)}</span>
                {containsFailedStep ? (
                  <span className="font-sans text-sm font-medium whitespace-nowrap text-failure">
                    Contains failed step
                  </span>
                ) : null}
              </span>
            </div>

            {inside.length === 0 ? null : (
              <details
                className={cn(
                  /* `group`, so the marker on the summary can read `[open]`. */
                  "group mt-0 mb-2 ms-20 text-muted-foreground",
                  "max-[40rem]:ms-18",
                )}
              >
                <summary
                  className={cn(
                    DISCLOSURE,
                    "inline-flex min-h-(--tap-target) cursor-pointer items-center gap-2",
                    "text-foreground before:size-2.5",
                  )}
                >
                  Show {inside.length} step{inside.length === 1 ? "" : "s"}
                </summary>
                <ul className="mx-0 mt-1 mb-2 flex list-none flex-col gap-2 p-0">
                  {inside.map(({ step: nested, depth }) => (
                    <li
                      className="flex min-w-0 items-baseline justify-between gap-3"
                      key={nested.spanId}
                      style={{ paddingInlineStart: `${String(Math.min(depth, 5) * 12)}px` }}
                    >
                      <span className="flex min-w-0 items-baseline gap-2">
                        <strong className="font-medium text-foreground">
                          {labelFor(nested)}
                        </strong>
                        {nested.kind === "tool" && nested.toolName !== "" ? (
                          <span className="overflow-hidden font-mono text-ellipsis whitespace-nowrap">
                            {nested.toolName}
                          </span>
                        ) : null}
                      </span>
                      <span
                        className={
                          nested.status === "error"
                            ? "font-medium text-failure"
                            : undefined
                        }
                      >
                        {nested.status === "error"
                          ? "Failed"
                          : howLong(nested.durationNs)}
                      </span>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </li>
        );
      })}
    </ol>
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
  durationMs: {
    label: "Duration",
    shown: (n) => (n < 1000 ? `${String(n)} ms` : `${(n / 1000).toFixed(1)} s`),
  },
  turnCount: { label: "Turns", shown: String },
  humanTurnCount: { label: "Human turns", shown: String },
  agentTurnCount: { label: "Agent turns", shown: String },
  toolCallCount: { label: "Tool calls", shown: String },
  erroredStepCount: { label: "Errored steps", shown: String },
  interruption_count: { label: "Interruptions", shown: String },
  cost_cents: { label: "Cost", shown: (n) => `${(n / 100).toFixed(2)}` },
};

/**
 * What was **measured**, and never what was judged.
 *
 * A metric measures and a grader judges, and that line is the reason this is its
 * own block instead of sitting among the verdicts. Nobody wrote down that the
 * conversation took four minutes; somebody had to decide that confirming a
 * booking matters. Only what is actually known appears — a conversation that
 * never connected has no duration.
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
    <div
      className="flex min-w-0 flex-col overflow-hidden rounded-card border border-border bg-surface"
      data-slot="measures"
    >
      <div
        className={cn(
          "flex min-h-(--row-height) flex-none items-center justify-between gap-3",
          "border-b border-border bg-surface-soft px-5 py-2",
        )}
      >
        <strong className="text-sm font-medium text-foreground">Measures</strong>
        <span className="font-mono text-sm text-faint tabular-nums">
          {entries.length} captured
        </span>
      </div>
      {/*
       * **A label at the leading edge and a figure in a fixed slot at the
       * other**, which is what `1E8-0` asks for in as many words: "Value
       * columns use a stable mono slot, so scans do not jump." A grid of cards
       * put every figure at a different left edge, so reading four measures
       * meant finding four of them.
       */}
      <dl className="m-0 flex min-w-0 flex-col">
        {entries.map(([name, value]) => {
          const how = MEASURES[name];
          return (
            <div
              className={cn(
                "flex min-w-0 items-baseline justify-between gap-4 px-5 py-2.5",
                "not-first:border-t not-first:border-t-border",
              )}
              key={name}
            >
              <dt className="min-w-0 text-sm text-muted-foreground">
                {how?.label ?? name.replaceAll("_", " ")}
              </dt>
              <dd className="m-0 w-[12ch] flex-none text-end font-mono text-sm text-foreground tabular-nums">
                {how === undefined ? String(value) : how.shown(value)}
              </dd>
            </div>
          );
        })}
      </dl>
    </div>
  );
}

/* ------------------------------------------------------------------------ *
 * The mocked world.
 * ------------------------------------------------------------------------ */

/** One tool name, as a chip. Not a `Badge`: that one is an uppercase verdict. */
const TOOL_CHIP =
  "rounded-chip border border-border px-3 py-1 font-mono text-sm text-foreground";

/**
 * Which of the agent's tools egma answered for, and which ran for real.
 *
 * **The absence of a stamp is a fact of its own**, and it is said out loud: no
 * stamp means nothing ever asked the agent what tools it has, while three empty
 * lists mean the asking happened and nothing came back. A mocked conversation
 * and an unmocked one are different units, and this is where a reader comparing
 * two of them finds out which they have.
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
        lead="This run froze no mocked answers, and nobody asked the agent what tools it has — so Egma stood in the path of nothing and claims nothing about what ran."
      />
    );
  }

  return (
    <div
      className="flex min-w-0 flex-col overflow-hidden rounded-card border border-border bg-surface"
      data-slot="mock-tools"
    >
      {/* The head `1EZ-0` draws: what this record is, and whether it matched. */}
      <div
        className={cn(
          "flex min-h-(--row-height) flex-none items-center justify-between gap-3",
          "border-b border-border bg-surface-soft px-5 py-2",
        )}
      >
        <strong className="text-sm font-medium text-foreground">Mock tools</strong>
        <span
          className={cn(
            "text-sm",
            coverage !== null && coverage.uncovered.length === 0
              ? "text-success"
              : "text-faint",
          )}
        >
          {coverage === null
            ? "Nothing was asked"
            : coverage.uncovered.length === 0
              ? "Matched"
              : `${String(coverage.uncovered.length)} ran for real`}
        </span>
      </div>
      <div className="flex flex-col gap-4 p-5">
      {frozen.length === 0 ? null : (
        <div className="flex flex-wrap items-baseline gap-2">
          <strong className="me-2 text-sm font-medium text-foreground">
            Frozen for this simulation
          </strong>
          {frozen.map((one) => (
            <span className={TOOL_CHIP} key={`frozen:${one.tool}`}>
              {one.tool}
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
          {/*
           * The good half of the record, on the quiet wash behind a narrow
           * success edge — a state colour, never the brand one.
           */}
          <div className="flex flex-wrap items-baseline gap-2 border-s-[3px] border-s-success bg-surface-soft px-3 py-2">
            <strong className="me-2 text-sm font-medium text-foreground">
              Answered by Egma
            </strong>
            {coverage.covered.length === 0 ? (
              <span className={MONO}>none</span>
            ) : (
              coverage.covered.map((name) => (
                <span className={TOOL_CHIP} key={`covered:${name}`}>
                  {name}
                </span>
              ))
            )}
          </div>
          <div className="flex flex-wrap items-baseline gap-2">
            <strong className="me-2 text-sm font-medium text-foreground">
              Ran for real
            </strong>
            {coverage.uncovered.length === 0 ? (
              <span className={MONO}>none</span>
            ) : (
              coverage.uncovered.map((name) => (
                <span
                  className={cn(TOOL_CHIP, "border-brand")}
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
    </div>
  );
}

/* ------------------------------------------------------------------------ *
 * What egma made of it.
 * ------------------------------------------------------------------------ */

/**
 * One judged assertion: what counts now, why, and the judgments underneath it.
 *
 * **Different grader-version judgments are preserved and shown.** A re-grade
 * replaces the row for this simulation's same pinned version. Any row already
 * stored under another version remains visible as superseded evidence.
 *
 * The page groups rows under their grader and marks that whole grader as
 * required or reports-only once. Repeating a storage id and lane on every
 * assertion makes the judgement harder to scan without adding information.
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
  const cited = citedTurnPositions(speaking.citedTurns, turns);

  return (
    <article
      className="flex flex-col gap-4 border-t border-t-border py-4"
      data-assertion={judged.assertion}
      data-slot="verdict"
      data-verdict={speaking.verdict ?? "pending"}
    >
      <header className="flex flex-wrap items-center gap-3">
        <span className="flex min-w-0 flex-[1_1_260px] flex-col gap-1">
          {/*
            The words where they could be resolved, and the bare key where they
            could not. A guessed sentence would be unfalsifiable; a key is
            merely terse.
          */}
          <strong className="text-sm font-medium text-foreground">
            {judged.assertionText ?? judged.assertion}
          </strong>
        </span>
        <VerdictBadge verdict={speaking.verdict} />
        <span className={MONO}>
          {speaking.score.toFixed(2)}
        </span>
        {action}
      </header>

      <p className="m-0 max-w-[88ch] text-sm text-foreground">
        {speaking.rationale}
      </p>
      {cited.length === 0 ? null : (
        /*
         * The citation, on the wash `DESIGN.md` reserves for "cited" and behind
         * the one narrow Ember edge this surface is allowed. It is decoration
         * pointing at the words, never a verdict — the chip above says that.
         */
        <p className={cn(CITED, "border-s-[3px] border-s-brand bg-selected px-3 py-2")}>
          Cites {cited.map((turn, at) => (
            <span key={turn}>
              {at === 0 ? "" : ", "}
              <a
                className="text-foreground decoration-brand underline-offset-3"
                href={`#transcript-turn-${String(turn)}`}
              >
                turn {turn}
              </a>
            </span>
          ))}
        </p>
      )}

      {judged.superseded.length === 0 ? null : (
        <details
          className={cn(
            /* `group`, so the marker on the summary can read `[open]`. */
            "group flex flex-col gap-2 ps-4 text-muted-foreground",
            /* An older judgement is filed under this one, not beside it. */
            "border-s-2 border-s-border",
          )}
        >
          <summary
            className={cn(
              DISCLOSURE,
              "inline-flex w-fit cursor-pointer items-center gap-2",
              "text-sm text-foreground before:size-3",
              /* A keyboard opening is immediate: no motion delays input. */
              "focus-visible:before:transition-none",
            )}
          >
            {judged.superseded.length} earlier judgement
            {judged.superseded.length === 1 ? "" : "s"} of this assertion
          </summary>
          {judged.superseded.map((row) => (
            <p className={cn(CITED)} key={row.judgedAt}>
              <span className={MONO}>{asSecond(row.judgedAt)}</span>{" "}
              {row.verdict} — {row.rationale}
            </p>
          ))}
        </details>
      )}

      {children}
    </article>
  );
}

/** The pinned grader versions this conversation was judged under. */
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
    <ul
      className={cn(
        "m-0 flex list-none flex-col overflow-hidden p-0",
        "rounded-card border border-border bg-surface",
      )}
      data-slot="grading-plan"
    >
      {items.map((item) => (
        <li
          className={cn(
            "grid grid-cols-[minmax(140px,0.7fr)_minmax(0,1.3fr)] gap-4 px-5 py-4 text-sm",
            "not-first:border-t not-first:border-t-border",
            /* Narrow, the note sits under the grader it describes. */
            "max-[40rem]:grid-cols-[1fr] max-[40rem]:gap-1",
          )}
          key={`${item.graderId}:${item.graderVersionId}`}
        >
          <strong className="font-medium text-foreground">
            {graderDisplayName(item.name)}
          </strong>
          <span className="min-w-0 font-mono wrap-anywhere text-muted-foreground">
            {`${item.required ? "blocks" : "reports only"} · ${item.graderVersionId}`}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** The block a page shows while grading is still outstanding. */
export function GradingPending({ what }: { readonly what: string }) {
  return (
    <p
      className={cn(
        "m-0 px-4 py-3 text-sm text-foreground",
        /* Attention, not a verdict: Ember Wash behind an Ember edge. */
        "border-s-[3px] border-s-brand bg-selected",
      )}
      data-slot="grading-pending"
    >
      {what}
    </p>
  );
}

/*
 * **There was a `CorrectionForm` here.** It was where a page put the form it
 * opened under one judgement, and it goes with the endpoint behind it:
 * ADR-0009 takes corrections out of v0, and they return as the reserved
 * `human` grader type writing rows of its own.
 */
