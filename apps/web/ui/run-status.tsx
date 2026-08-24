"use client";

import type { ReactNode } from "react";

import {
  type GradingWord,
  type RunStatusWord,
  type SimulationStatusWord,
} from "../lib/runs.ts";
import type { VariantProps } from "class-variance-authority";

import { Badge, badgeVariants } from "@/components/ui/badge";
import { cn } from "@/lib/utils";


/**
 * The parts every surface that shows a run is built from — and the reason they
 * are shared rather than written per page.
 *
 * Run state, simulation state, and grading state answer different questions.
 * An execution failure must never look like a low grade, and unfinished grading
 * must never look like a failure.
 *
 * A page that decided its own colours for those words would be free to decide
 * differently from its neighbour, and the first one to paint `completed` green
 * would have turned a machinery word into a quality result. So the mapping from word
 * to appearance is here, once, and the pages ask for it.
 *
 * These live in their own file with their own stylesheet rather than in
 * the shared control set, which the shared system deliberately
 * holds closed.
 */

/* ------------------------------------------------------------------------ *
 * The four facts, as words with a tone.
 * ------------------------------------------------------------------------ */

/**
 * A run's machinery. **Nothing here is ever `good`.**
 *
 * `completed` means the work finished, which is not the same as the work going
 * well. Painting it green would answer a question this word does not ask.
 */
/**
 * The tones a state word can be said in, read off the chip that says them.
 *
 * It is the `Badge`'s own variant union rather than a list repeated here, so a
 * variant that is added or withdrawn from the chip cannot leave this file
 * naming one that no longer exists. `InlineState` is the same word without the
 * chip around it, so it takes the same vocabulary.
 */
type StateTone = NonNullable<VariantProps<typeof badgeVariants>["variant"]>;

const RUN_STATUS_TONE: Readonly<Record<RunStatusWord, StateTone>> = {
  pending: "neutral",
  running: "neutral",
  completed: "neutral",
  canceled: "warning",
};

const RUN_STATUS_MEANING: Readonly<Record<RunStatusWord, string>> = {
  pending: "Nothing has been claimed yet.",
  running: "Egma is conducting this run.",
  completed:
    "The run finished. Trace-level grade scores are separate facts.",
  canceled:
    "Somebody stopped this run, or the agent or connection it used was archived. Work already reported stays on the record.",
};

export type StateMarkKind =
  | "waiting"
  | "active"
  | "complete"
  | "stopped"
  | "failed"
  | "not-requested"
  | "error";

/**
 * A second, non-colour signal beside every state word.
 *
 * The word remains the source of meaning. The small line mark makes nearby
 * badges easier to scan and keeps their difference visible without asking a
 * reader to learn the temporary green, amber, and red compatibility palette.
 */
export function StateMark({
  kind,
  moving = false,
}: {
  readonly kind: StateMarkKind;
  readonly moving?: boolean;
}) {
  return (
    <svg
      className="block size-3 flex-none"
      data-slot="state-mark"
      data-state-mark={kind}
      data-motion={moving ? "active" : undefined}
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={1.4}
      aria-hidden="true"
      focusable="false"
    >
      {kind === "waiting" ? <circle cx="6" cy="6" r="3.75" /> : null}
      {kind === "active" ? <path d="M6 2a4 4 0 1 1-4 4" /> : null}
      {kind === "complete" ? <path d="m2.5 6 2.25 2.25L9.5 3.5" /> : null}
      {kind === "stopped" || kind === "failed" ? (
        <path d="m3 3 6 6M9 3 3 9" />
      ) : null}
      {kind === "not-requested" ? <path d="M3 6h6" /> : null}
      {kind === "error" ? (
        <>
          <circle cx="6" cy="6" r="4" />
          <path d="M6 3.5v3M6 8.5h.01" />
        </>
      ) : null}
    </svg>
  );
}

const RUN_STATUS_MARK: Readonly<Record<RunStatusWord, StateMarkKind>> = {
  pending: "waiting",
  running: "active",
  completed: "complete",
  canceled: "stopped",
};

export function RunStatus({
  status,
  compact = false,
}: {
  readonly status: RunStatusWord;
  readonly compact?: boolean;
}) {
  const mark = (
    <StateMark
      kind={RUN_STATUS_MARK[status]}
      moving={status === "running"}
    />
  );
  if (compact) {
    return (
      <InlineState
        tone={RUN_STATUS_TONE[status]}
        title={RUN_STATUS_MEANING[status]}
      >
        {mark}
        {status}
      </InlineState>
    );
  }
  return (
    <Badge variant={RUN_STATUS_TONE[status]} title={RUN_STATUS_MEANING[status]}>
      {mark}
      {status}
    </Badge>
  );
}

/**
 * One simulation's machinery.
 *
 * `failed` is the only `bad` one, and it is bad about **egma** rather than about
 * the agent: it means the simulation could not be conducted. A canceled
 * simulation was stopped; it says nothing about the agent and is never red.
 */
const SIMULATION_STATUS_TONE: Readonly<
  Record<SimulationStatusWord, StateTone>
> = {
  queued: "neutral",
  claimed: "neutral",
  running: "neutral",
  completed: "neutral",
  failed: "failure",
  canceled: "warning",
};

const SIMULATION_STATUS_MEANING: Readonly<
  Record<SimulationStatusWord, string>
> = {
  queued: "Waiting for a simulator to pick it up.",
  claimed: "A simulator has taken it and is about to start.",
  running: "The simulation is happening now.",
  completed:
    "The simulation finished. Its trace-level grade scores are separate facts.",
  failed:
    "Egma could not conduct this simulation. This is an execution problem, not a grade, and it says nothing about the agent.",
  canceled: "This simulation was stopped before it finished.",
};

const SIMULATION_STATUS_MARK: Readonly<
  Record<SimulationStatusWord, StateMarkKind>
> = {
  queued: "waiting",
  claimed: "waiting",
  running: "active",
  completed: "complete",
  failed: "failed",
  canceled: "stopped",
};

export function SimulationStatus({
  status,
  compact = false,
}: {
  readonly status: SimulationStatusWord;
  readonly compact?: boolean;
}) {
  const mark = (
    <StateMark
      kind={SIMULATION_STATUS_MARK[status]}
      moving={status === "running"}
    />
  );
  if (compact) {
    return (
      <InlineState
        tone={SIMULATION_STATUS_TONE[status]}
        title={SIMULATION_STATUS_MEANING[status]}
      >
        {mark}
        {status}
      </InlineState>
    );
  }
  return (
    <Badge
      variant={SIMULATION_STATUS_TONE[status]}
      title={SIMULATION_STATUS_MEANING[status]}
    >
      {mark}
      {status}
    </Badge>
  );
}

/**
 * Where the grading work stands. **Never good and never bad**: how far along the
 * grading is says nothing about the scores it will produce.
 */
const GRADING_WORD: Readonly<Record<GradingWord, string>> = {
  not_requested: "No grading",
  pending: "Queued",
  running: "Grading",
  complete: "Graded",
  error: "Grading error",
};

const GRADING_MEANING: Readonly<Record<GradingWord, string>> = {
  not_requested: "No grader was asked to grade this trace.",
  pending: "The grading work is waiting to start.",
  running: "The graders are grading this trace.",
  complete: "All requested grades are available.",
  error: "Egma could not complete every requested grade.",
};

const GRADING_MARK: Readonly<Record<GradingWord, StateMarkKind>> = {
  not_requested: "not-requested",
  pending: "waiting",
  running: "active",
  complete: "complete",
  error: "error",
};

export function GradingState({
  grading,
  compact = false,
}: {
  readonly grading: GradingWord;
  readonly compact?: boolean;
}) {
  if (compact) {
    return (
      <InlineState title={GRADING_MEANING[grading]}>
        <StateMark kind={GRADING_MARK[grading]} />
        {GRADING_WORD[grading]}
      </InlineState>
    );
  }
  return (
    <Badge title={GRADING_MEANING[grading]}>
      <StateMark kind={GRADING_MARK[grading]} />
      {GRADING_WORD[grading]}
    </Badge>
  );
}

function InlineState({
  tone = "neutral",
  title,
  children,
}: {
  readonly tone?: StateTone;
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex min-w-0 items-center gap-2 text-sm whitespace-nowrap",
        "text-muted-foreground",
        "data-[tone=success]:text-success",
        "data-[tone=warning]:text-warning",
        "data-[tone=failure]:text-failure",
      )}
      data-tone={tone}
      title={title}
    >
      {children}
    </span>
  );
}

/**
 * How far the machinery has got, drawn as a bar.
 *
 * **The bar measures simulations, not grading**, and it says so beside
 * itself. A single bar over both would have to decide which of the two a
 * half-full bar meant, and the two settle at different moments — a run whose
 * simulations have all finished is not a run whose grades are all available.
 */
export function RunProgress({
  finished,
  expected,
}: {
  readonly finished: number;
  readonly expected: number;
}) {
  const share = expected === 0 ? 0 : Math.min(1, finished / expected);
  return (
    <div
      className="relative h-1.5 overflow-hidden rounded-chip bg-surface-soft"
      role="progressbar"
      aria-label="Simulations finished"
      aria-valuenow={finished}
      aria-valuemin={0}
      aria-valuemax={expected}
      aria-valuetext={`${String(finished)} of ${String(expected)} simulations finished`}
    >
      <span
        className={cn(
          "block size-full origin-left rounded-chip bg-foreground",
          /*
           * 200ms is written here rather than read from the theme, and it is
           * the one duration in this file that is not a `DESIGN.md` motion
           * token. Those name interface motion — a press, a popover, a dialog
           * — and this is a value catching up to a new value, which
           * `DESIGN.md` gives a behaviour for ("transform-based fill, linear
           * while active") and no token. It is the duration the stylesheet
           * this replaces already used and it is under the 300ms ceiling.
           * Called out in the pull request for the developer to overrule.
           */
          "transition-transform duration-200 ease-linear",
          "motion-reduce:transition-none",
        )}
        style={{ transform: `scaleX(${String(share)})` }}
      />
    </div>
  );
}

/**
 * How many simulations stand in each machinery state, in words.
 *
 * Only states that have at least one simulation are shown.
 */
export function SimulationTally({
  counts,
}: {
  readonly counts: Readonly<Record<SimulationStatusWord, number>>;
}) {
  const said = (Object.keys(SIMULATION_STATUS_TONE) as SimulationStatusWord[])
    .filter((word) => (counts[word] ?? 0) > 0)
    .map((word) => `${String(counts[word] ?? 0)} ${word}`);
  return (
    <span className="text-sm tabular-nums text-muted-foreground">
      {said.length === 0 ? "No simulations yet" : said.join(" · ")}
    </span>
  );
}

/** A score between nought and one, or an honest dash where there is none. */
export function shownScore(score: number | null): string {
  return score === null ? "—" : String(Math.round(score * 1000) / 1000);
}
