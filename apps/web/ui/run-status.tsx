"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { listRuns } from "@egma/platform-api/client";

import { platformAnswer, platformClient } from "../lib/platform-client.ts";
import { projectPath } from "../lib/project-context.ts";
import {
  type GradingWord,
  type RunHistoryPage,
  type RunRow,
  type RunStatusWord,
  type SimulationStatusWord,
  type VerdictCounts,
  type VerdictWord,
} from "../lib/runs.ts";
import type { VariantProps } from "class-variance-authority";

import { Badge, badgeVariants } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { DataTable, type Column } from "./data-table.tsx";
import { Empty, Failure, Loading } from "./page-state.tsx";
import { RelativeInstant, useMinuteClock } from "./relative-time.tsx";
import { useProjectRead } from "./resource.ts";
import { Section } from "./section.tsx";

/**
 * The parts every surface that shows a run is built from — and the reason they
 * are shared rather than written per page.
 *
 * **A run holds four different facts and every page has to show each of them as
 * itself.** The run's machinery, each simulation's machinery, where the
 * grading work stands, and the verdict. Folding any into any other is the defect
 * this whole area exists to prevent: an execution failure drawn as a failed
 * verdict tells a team their agent is broken when egma is, and pending grading
 * drawn as a failure tells them something failed when nobody has looked.
 *
 * A page that decided its own colours for those words would be free to decide
 * differently from its neighbour, and the first one to paint `completed` green
 * would have turned a machinery word into a judgement. So the mapping from word
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
 * well — a completed run may hold nothing but failed verdicts. Painting it green
 * would answer a question this word does not ask.
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
    "The machinery finished. What the graders made of it is the verdict, which is a separate fact.",
  canceled:
    "Somebody stopped this run, or the agent or connection it used was archived. Work already reported stays on the record.",
};

export type StateMarkKind =
  | "waiting"
  | "active"
  | "complete"
  | "stopped"
  | "failed"
  | "skipped"
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
      {kind === "skipped" ? <path d="M3 6h6" /> : null}
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
 * the agent: it means the simulation could not be conducted. `skipped` is a
 * simulation egma declined to conduct at all, and `canceled` one that was
 * stopped; neither says anything about the agent, and neither is ever red.
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
  skipped: "warning",
};

const SIMULATION_STATUS_MEANING: Readonly<
  Record<SimulationStatusWord, string>
> = {
  queued: "Waiting for a simulator to pick it up.",
  claimed: "A simulator has taken it and is about to start.",
  running: "The simulation is happening now.",
  completed:
    "The simulation finished. Whether it went well is the verdict, which is a separate fact.",
  failed:
    "Egma could not conduct this simulation. This is an execution problem, not a failed grader verdict, and it says nothing about the agent.",
  canceled: "This simulation was stopped before it finished.",
  skipped:
    "Egma never conducted this simulation, because the test required something this connection could not be shown to do. Nothing about the agent is being said.",
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
  skipped: "skipped",
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
 * judging is says nothing about what it will decide.
 */
const GRADING_WORD: Readonly<Record<GradingWord, string>> = {
  not_required: "No grading",
  waiting: "Not yet",
  pending: "Grading",
  graded: "Graded",
};

const GRADING_MEANING: Readonly<Record<GradingWord, string>> = {
  not_required:
    "There is nothing to judge and there never will be. Egma either never conducted this simulation or it was stopped, so no grading work was filed for it.",
  waiting: "The simulation has not finished, so grading has not begun.",
  pending: "The simulation finished and no verdict has arrived yet.",
  graded: "Verdicts have arrived.",
};

const GRADING_MARK: Readonly<Record<GradingWord, StateMarkKind>> = {
  not_required: "skipped",
  waiting: "waiting",
  pending: "active",
  graded: "complete",
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

/**
 * What was decided — and `null`, which is **nobody has decided yet** and is not
 * a verdict.
 *
 * Four words and never three. `skipped` and `errored` are answers in their own
 * right: a check that could not run is not a check that failed, and a broken
 * judge is not a failing agent. Both are amber rather than red for exactly that
 * reason.
 */
const VERDICT_TONE: Readonly<Record<VerdictWord, StateTone>> = {
  passed: "success",
  failed: "failure",
  skipped: "warning",
  errored: "warning",
};

const VERDICT_MEANING: Readonly<Record<VerdictWord, string>> = {
  passed: "Every check that could be scored passed.",
  failed: "At least one check failed. This is a judgement about the agent.",
  skipped:
    "Nothing was scored. Egma judged nothing here, so no result has been earned either way.",
  errored:
    "Egma could not produce a judgement. This is a platform problem, not a failing agent.",
};

const VERDICT_MARK: Readonly<Record<VerdictWord, StateMarkKind>> = {
  passed: "complete",
  failed: "failed",
  skipped: "skipped",
  errored: "error",
};

export const NOT_JUDGED_YET = "Not judged yet";

export function VerdictBadge({
  verdict,
  compact = false,
}: {
  readonly verdict: VerdictWord | null;
  readonly compact?: boolean;
}) {
  if (verdict === null) {
    const title =
      "Nobody has finished judging this yet. That is not a result, and it is certainly not a failure.";
    if (compact) {
      return (
        <InlineState title={title}>
          <StateMark kind="waiting" />
          Not judged
        </InlineState>
      );
    }
    return (
      <Badge title={title}>
        <StateMark kind="waiting" />
        {NOT_JUDGED_YET}
      </Badge>
    );
  }
  if (compact) {
    return (
      <InlineState tone={VERDICT_TONE[verdict]} title={VERDICT_MEANING[verdict]}>
        <StateMark kind={VERDICT_MARK[verdict]} />
        {verdict}
      </InlineState>
    );
  }
  return (
    <Badge variant={VERDICT_TONE[verdict]} title={VERDICT_MEANING[verdict]}>
      <StateMark kind={VERDICT_MARK[verdict]} />
      {verdict}
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

/* ------------------------------------------------------------------------ *
 * The four facts together.
 * ------------------------------------------------------------------------ */

/**
 * Machinery beside judgment, labelled, in one strip.
 *
 * The labels are not decoration. "Run", "Simulations", "Grading" and "Verdict"
 * are what stops somebody reading one number as an answer to another's question,
 * and they are the same four words on the list, on the detail page and on a
 * mobile screen.
 */
export function RunFacts({
  status,
  finished,
  expected,
  graded,
  gradable,
  verdict,
}: {
  readonly status: RunStatusWord;
  readonly finished: number;
  readonly expected: number;
  readonly graded: number;
  readonly gradable: number;
  readonly verdict: VerdictWord | null;
}) {
  return (
    <div
      className={cn(
        "grid grid-cols-4 overflow-hidden rounded-card border border-border bg-surface",
        /*
         * The dividing lines live on the strip rather than on each fact,
         * because which edge a fact carries depends on where the strip wrapped
         * it. Four across draws one line between neighbours; two across moves
         * the third fact to a new line, so it loses its leading edge and the
         * bottom row gains a top one; one across turns every line horizontal.
         */
        "[&>*+*]:border-s [&>*+*]:border-border",
        "max-[52rem]:grid-cols-2",
        "max-[52rem]:[&>*:nth-child(3)]:border-s-0",
        "max-[52rem]:[&>*:nth-child(n+3)]:border-t max-[52rem]:[&>*:nth-child(n+3)]:border-border",
        "max-[32rem]:grid-cols-1",
        "max-[32rem]:[&>*+*]:border-s-0 max-[32rem]:[&>*+*]:border-t",
      )}
    >
      <Fact label="Run">
        <RunStatus status={status} />
      </Fact>
      <Fact label="Simulations">
        <span className="tabular-nums">
          {finished} of {expected} finished
        </span>
      </Fact>
      <Fact label="Grading">
        <span className="tabular-nums">
          {graded} of {gradable} judged
        </span>
      </Fact>
      <Fact label="Verdict">
        <VerdictBadge verdict={verdict} />
      </Fact>
    </div>
  );
}

function Fact({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-2 px-5 py-4">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="flex min-w-0 items-center gap-2 text-sm text-foreground">
        {children}
      </span>
    </div>
  );
}

/**
 * How far the machinery has got, drawn as a bar.
 *
 * **The bar measures simulations, not judgment**, and it says so beside
 * itself. A single bar over both would have to decide which of the two a
 * half-full bar meant, and the two settle at different moments — a run whose
 * simulations have all finished is not a run whose judgment is in.
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
 * Only the states that have somebody in them, and `skipped` never merged into
 * anything: a summary that hid it would be hiding the one number that says egma
 * declined to conduct part of this run.
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

/**
 * What the graders decided, counted — and `null`, which is not zero.
 *
 * A simulation nobody has judged has no counts at all, and a page that
 * rendered that as "0 of 0 passed" would be putting a finished-looking figure
 * against work nobody has done.
 */
export function VerdictTally({ counts }: { readonly counts: VerdictCounts | null }) {
  if (counts === null || counts.total === 0) {
    return (
      <span className="text-sm tabular-nums text-muted-foreground">
        {NOT_JUDGED_YET}
      </span>
    );
  }
  const parts = [`${String(counts.passed)}/${String(counts.total)} passed`];
  if (counts.failed > 0) parts.push(`${String(counts.failed)} failed`);
  if (counts.skipped > 0) parts.push(`${String(counts.skipped)} skipped`);
  if (counts.errored > 0) parts.push(`${String(counts.errored)} errored`);
  return (
    <span className="text-sm tabular-nums text-muted-foreground">
      {parts.join(" · ")}
    </span>
  );
}

/** A score between nought and one, or an honest dash where there is none. */
export function shownScore(score: number | null): string {
  return score === null ? "—" : String(Math.round(score * 1000) / 1000);
}

/**
 * The last few runs of one agent or one test, and a way through to each.
 *
 * **One component for both pages, because it is one question**: what has this
 * been run against lately, and how did it go. Written twice it would be two
 * chances to fold a machinery word into a verdict, and the second copy is always
 * the one that drifts.
 *
 * It narrows on the server, in the address, and never in the browser: a filter
 * applied to what came back would answer differently depending on how much had
 * already been fetched, and there is no page here to fetch more of — this is
 * deliberately the newest handful with a way through to the whole history.
 */
export function RecentRuns({
  projectId,
  title,
  lead,
  filters,
  limit = 5,
}: {
  readonly projectId: string;
  readonly title: string;
  readonly lead: string;
  /** Which runs these are: one agent's, or one test's. */
  readonly filters: {
    readonly agentId?: string;
    readonly connectionId?: string;
    readonly testId?: string;
    readonly status?: RunStatusWord;
    readonly verdict?: VerdictWord;
    readonly since?: string;
  };
  readonly limit?: number;
}) {
  const now = useMinuteClock();
  const requestKey = JSON.stringify({ filters, limit });
  const { answer, reload } = useProjectRead<RunHistoryPage>(
    (projectId) =>
      platformAnswer(
        listRuns(
          { projectId, ...filters, pageSize: limit },
          { client: platformClient },
        ),
      ),
    projectId,
    requestKey,
  );

  const columns: readonly Column<RunRow>[] = [
    {
      key: "run",
      header: "Run",
      primary: true,
      cell: (run) => (
        <Link href={projectPath(projectId, "runs", run.id)}>
          {run.label ?? <RelativeInstant instant={run.createdAt} now={now} />}
        </Link>
      ),
    },
    {
      key: "status",
      header: "Status",
      width: "110px",
      cell: (run) => <RunStatus status={run.status} />,
    },
    {
      key: "simulations",
      header: "Simulations",
      hideOnMobile: true,
      width: "200px",
      cell: (run) => <SimulationTally counts={run.simulationCounts} />,
    },
    {
      key: "verdict",
      header: "Verdict",
      width: "130px",
      cell: (run) => <VerdictBadge verdict={run.verdict} />,
    },
  ];

  return (
    <Section
      title={title}
      lead={lead}
      action={
        <Button asChild variant="secondary">
          <Link href={projectPath(projectId, "runs")}>All runs</Link>
        </Button>
      }
    >
      {answer === null || answer.status === "signed-out" ? (
        <Loading what="recent runs" />
      ) : answer.status === "ready" ? (
        answer.value.runs.length === 0 ? (
          <Empty
            title="Nothing has been run here yet"
            lead="Create a run and its results appear here, with a link to each one."
          />
        ) : (
          <DataTable
            label={title}
            columns={columns}
            rows={answer.value.runs}
            keyOf={(run) => run.id}
            stretchPrimaryLink
            stackWhenConstrained
          />
        )
      ) : (
        <Failure message={answer.refusal.message} onRetry={reload} />
      )}
    </Section>
  );
}
