"use client";

import type { VariantProps } from "class-variance-authority";
import type { ReactNode } from "react";

import {
  type GradeTally,
  type GradingWord,
  type RunStatusWord,
  type SimulationStatusWord,
} from "../lib/runs.ts";

import { Badge, badgeVariants } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * Share status appearance across run, simulation, and grading views. Execution
 * completion is not a quality verdict, and pending grading is not failure.
 */

/* ------------------------------------------------------------------------ *
 * Run state, as a word with motion only while work is active.
 * ------------------------------------------------------------------------ */

/**
 * A run's machinery. `completed` means the work finished, which is not the
 * same as the work going well: the verdicts live on each simulation's own
 * square. The run's green square says only that the run is done.
 */
const RUN_STATUS_MEANING: Readonly<Record<RunStatusWord, string>> = {
  pending: "Nothing has been claimed yet.",
  running: "Egma is conducting this run.",
  completed:
    "The run finished. Trace-level grade scores are separate facts.",
  canceled:
    "Somebody stopped this run, or the agent or connection it used was archived. Work already reported stays on the record.",
};

const RUN_STATUS_LABEL: Readonly<Record<RunStatusWord, string>> = {
  pending: "Pending",
  running: "Running",
  completed: "Completed",
  canceled: "Canceled",
};

export type StateMarkKind =
  | "waiting"
  | "active"
  | "complete"
  | "passed"
  | "stopped"
  | "failed"
  | "not-requested"
  | "error";

/**
 * The state colour a filled square wears, by what it stands for. Yellow is
 * work that is not settled, green is finished or passed, red is failed or
 * errored, and grey is stopped or never asked for.
 */
const FILLED_MARK: Readonly<Record<StateMarkKind, string>> = {
  waiting: "border-warning bg-warning",
  active: "border-warning bg-warning",
  complete: "border-success bg-success",
  passed: "border-success bg-success",
  stopped: "border-faint bg-faint",
  "not-requested": "border-faint bg-faint",
  failed: "border-failure bg-failure",
  error: "border-failure bg-failure",
};

/**
 * One square for every state, beside the word that says it.
 *
 * The outline form is the step marker beside a transcript line and the grading
 * chip: only a failure fills. The `filled` form is the run and simulation
 * status square, which wears its state colour and pulses while work is
 * active. `moving` is the older spin for a chip; `pulse` wins when both are
 * set.
 */
export function StateMark({
  kind,
  moving = false,
  filled = false,
  pulse = false,
}: {
  readonly kind: StateMarkKind;
  readonly moving?: boolean;
  readonly filled?: boolean;
  readonly pulse?: boolean;
}) {
  return (
    <span
      className={cn(
        "block size-2.5 flex-none border border-current",
        filled
          ? FILLED_MARK[kind]
          : kind === "failed" || kind === "error"
            ? "border-failure bg-failure"
            : "bg-transparent",
      )}
      data-slot="state-mark"
      data-state-mark={kind}
      data-filled={filled ? "true" : undefined}
      data-motion={pulse ? "pulse" : moving ? "active" : undefined}
      aria-hidden="true"
    />
  );
}

const RUN_STATUS_MARK: Readonly<Record<RunStatusWord, StateMarkKind>> = {
  pending: "waiting",
  running: "active",
  completed: "complete",
  canceled: "stopped",
};

/**
 * The run's word with its filled square in front. Pending and running pulse
 * because the work is not settled; completed is green; canceled is grey, and
 * the word stays in the ordinary ink because a stopped run is not a warning.
 */
export function RunStatus({
  status,
}: {
  readonly status: RunStatusWord;
}) {
  const active = status === "pending" || status === "running";
  return (
    <span
      className="inline-flex min-w-0 items-center gap-2 whitespace-nowrap text-sm text-foreground"
      data-slot="run-status"
      data-status={status}
      title={RUN_STATUS_MEANING[status]}
    >
      <StateMark kind={RUN_STATUS_MARK[status]} filled pulse={active} />
      {RUN_STATUS_LABEL[status]}
    </span>
  );
}

export type SimulationSquare = {
  readonly kind: StateMarkKind;
  readonly pulse: boolean;
  readonly word: string;
};

/**
 * One square and one word for a simulation, read in a fixed order.
 *
 * Execution comes first: a canceled or failed simulation never graded. Then
 * the grading work, which pulses until it settles. Then the verdict, which is
 * per grader and never an overall threshold (ADR-0017 stands): green when
 * every frozen grader passed its own pass threshold, red when any failed. An
 * errored grader makes the grading state `error`, so it never reaches the
 * count. The word beside a graded square is the count, `2/3 passed`, so the
 * colour is never the only carrier. `claimed` is shown as `Queued`, because
 * which simulator holds it is not the reader's business.
 */
export function simulationSquare(row: {
  readonly status: SimulationStatusWord;
  readonly gradingState: GradingWord | null;
  readonly gradeTally: GradeTally | null;
}): SimulationSquare {
  switch (row.status) {
    case "canceled":
      return { kind: "stopped", pulse: false, word: "Canceled" };
    case "failed":
      return { kind: "failed", pulse: false, word: "Execution failed" };
    case "queued":
    case "claimed":
      return { kind: "waiting", pulse: true, word: "Queued" };
    case "running":
      return { kind: "active", pulse: true, word: "Running" };
    case "completed":
      break;
  }
  switch (row.gradingState) {
    case null:
    case "not_requested":
      return { kind: "not-requested", pulse: false, word: "Not graded" };
    case "pending":
    case "running":
      return { kind: "active", pulse: true, word: "Grading" };
    case "error":
      return { kind: "error", pulse: false, word: "Grading failed" };
    case "complete":
      break;
  }
  const tally = row.gradeTally;
  if (tally === null || tally.selected === 0) {
    return { kind: "not-requested", pulse: false, word: "Not graded" };
  }
  const word = `${String(tally.passed)}/${String(tally.selected)} passed`;
  return tally.failed > 0
    ? { kind: "failed", pulse: false, word }
    : { kind: "passed", pulse: false, word };
}

/**
 * The tones a state word can be said in, read off the chip that says them.
 *
 * It is the `Badge`'s own variant union rather than a list repeated here, so a
 * variant that is added or withdrawn from the chip cannot leave this file
 * naming one that no longer exists. `InlineState` is the same word without the
 * chip around it, so it takes the same vocabulary.
 */
type StateTone = NonNullable<VariantProps<typeof badgeVariants>["variant"]>;

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
 * Where the grading work stands. Progress says nothing about the scores it
 * will produce. An error is still a system failure, so its word and mark use
 * the Failure treatment without turning it into a failed grade.
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
  const tone = grading === "error" ? "failure" : "neutral";
  if (compact) {
    return (
      <InlineState tone={tone} title={GRADING_MEANING[grading]}>
        <StateMark kind={GRADING_MARK[grading]} />
        {GRADING_WORD[grading]}
      </InlineState>
    );
  }
  return (
    <Badge variant={tone} title={GRADING_MEANING[grading]}>
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
          /* Use a short linear transform transition when the progress value changes. */
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
  const label: Readonly<Record<SimulationStatusWord, string>> = {
    queued: "queued",
    claimed: "claimed",
    running: "running",
    completed: "completed",
    failed: "execution failed",
    canceled: "canceled",
  };
  const said = (Object.keys(SIMULATION_STATUS_TONE) as SimulationStatusWord[])
    .filter((word) => (counts[word] ?? 0) > 0)
    .map((word) => `${String(counts[word] ?? 0)} ${label[word]}`);
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
