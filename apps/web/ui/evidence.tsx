"use client";

import { cn } from "@/lib/utils";

import {
  type EvidencePlanItem,
  type EvidenceStep,
  type EvidenceTranscript,
} from "../lib/simulations.ts";
import { graderDisplayName } from "../lib/presentation.ts";
import { howFarIn, howLong } from "../lib/transcripts.ts";
import { Empty } from "./page-state.tsx";

/**
 * The parts one conversation's evidence page is built from.
 *
 * **Each one takes finished data and decides nothing.** A transcript is handed
 * turns; the grade block is handed a completed grade. That is what makes them
 * reusable and what makes them tunable: their appearance is the class list on
 * each element and their contract is `lib/simulations.ts`, and neither can be
 * changed by touching the other. A component that fetched, folded or filtered
 * would put a second opinion inside the page and the two would disagree the day
 * somebody changed one.
 *
 * They live in their own file, beside `run-status.tsx` and for the same
 * reason: the shared component set is deliberately held closed.
 *
 * **Speech, timing and grading stay three things.** The transcript is what was
 * said and nothing else — tool calls and system work are not interleaved into
 * it, because a transcript with machinery in the middle of it stops being
 * readable as a conversation. A page that wants speech and machinery on one
 * clock builds that view for itself; it is not one of these. And a grade is
 * never drawn inside a turn: grading is a separate act from speaking, and a
 * page that mixed them would let a reader take a grader's sentence for
 * something the agent said.
 *
 * **The appearance is Tailwind on the shadcn base**, and `evidence.module.css`
 * is gone with it. What it said about these surfaces still holds and is worth
 * keeping: a transcript stays prose, a measure stays a number, and a grade
 * stays a grade. They share the palette and the hairlines without those three
 * different facts becoming one card pattern.
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
 * then. The data table's activatable rows are that second surface, so the
 * recipe is exported rather than retyped — still one string, now with two
 * callers instead of a copy.
 */
export const ROW_HOVER =
  "pointer-hover:bg-[color-mix(in_srgb,var(--surface-soft)_62%,transparent)]";

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
   * Turn positions to mark, one-based — the turns a grade somebody is
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
 * What happened *inside* a turn is counted here and drawn nowhere here.
 * Putting a tool call between two sentences would break the reading, and
 * dropping the count would lose it — so the count is named and the detail
 * belongs to whatever timed view a page builds for it.
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
              /* The panel header supplies the first division; every turn
                 after it keeps the same row boundary. */
              "border-t border-t-border",
              /* A grade points here. */
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
                    <span className="text-foreground">cited by a grade</span>
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
 * What was **measured**, and never what was graded.
 *
 * A metric measures and a grader grades, and that line is the reason this is its
 * own block instead of sitting among the grades. Nobody wrote down that the
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

/** The pinned grader versions this simulation was graded under. */
export function PlanItems({
  items,
}: {
  readonly items: readonly EvidencePlanItem[];
}) {
  if (items.length === 0) {
    return (
      <Empty
        title="No graders were frozen for this simulation"
        lead="No project grader matched this simulation when the run started."
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
          key={item.projectGraderId}
        >
          <strong className="font-medium text-foreground">
            {graderDisplayName(item.graderName)}
          </strong>
          <span className="min-w-0 font-mono wrap-anywhere text-muted-foreground">
            {`Definition v${String(item.graderDefinitionVersion)} · pass threshold ${item.passThreshold.toFixed(2)}`}
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
        /* Attention, not a grade result: Ember Wash behind an Ember edge. */
        "border-s-[3px] border-s-brand bg-selected",
      )}
      data-slot="grading-pending"
    >
      {what}
    </p>
  );
}
