import type { RunStatus, SimulationStatus } from "../schema/runs.ts";
import type { FoldedOutcome, VerdictCounts, Verdict } from "./fold.ts";

/**
 * The one place execution and judgment are read together — and kept apart.
 *
 * A run holds **four different facts**, and every page that shows one of them
 * has to show it as itself:
 *
 * 1. the **run**'s machinery status — `pending`, `running`, `completed`,
 *    `canceled`;
 * 2. each **simulation**'s machinery status — including `failed`, which is a
 *    conversation egma tried and could not, and `canceled`, which somebody
 *    stopped;
 * 3. the state of the **grading work** — whether anybody has looked yet;
 * 4. the **verdict** — what the graders made of what happened.
 *
 * Folding any of those into any other is the defect this module exists to make
 * unwritable. An execution failure shown as a failed verdict tells a team their
 * agent is broken when egma is. Pending grading shown as a failure tells them
 * something failed when nobody has looked. A canceled conversation shown as
 * either says egma judged something that produced no grading evidence.
 *
 * **The rules, from the effort spec, in one place.** For a `completed`
 * simulation the verdict comes from grader verdict rows and from nowhere else.
 * Execution `failed` reads `errored`. Execution `canceled` reads `skipped`.
 * Nothing here invents a grader row for work that produced no
 * evidence, and nothing here turns an absence into a pass. The run's verdict is
 * folded over its simulations' verdicts, so a completed run may perfectly well
 * hold failed verdicts — the machinery finished, and what it found was bad.
 *
 * Pure: no store, no context, no query. It is handed what two stores already
 * answered and says what the pair means.
 */

/**
 * Where the judging of one conversation stands — never what it decided.
 *
 * Four states, and each is a different sentence to a person waiting:
 *
 * - `not_required` — there is nothing to judge and there never will be. A
 *   canceled conversation was stopped, so no grading job exists for it. Saying
 *   `pending` about one would leave a
 *   progress bar waiting forever on work nobody filed.
 * - `waiting` — the conversation has not finished, so grading has not begun.
 * - `pending` — the conversation finished and no verdict has landed yet.
 * - `graded` — verdicts have landed.
 */
export type GradingStanding =
  | "not_required"
  | "waiting"
  | "pending"
  | "graded";

/** Which machinery states leave something for a grader to read. */
const GRADABLE: ReadonlySet<SimulationStatus> = new Set([
  "completed",
  "failed",
]);

/** Which machinery states are over, however they got there. */
const TERMINAL: ReadonlySet<SimulationStatus> = new Set([
  "completed",
  "failed",
  "canceled",
]);

/** One conversation's four facts, each as itself. */
export type SimulationFold = {
  /** Fact two: the machinery. Carried through untouched. */
  readonly status: SimulationStatus;
  /** Fact three: whether anybody has looked. */
  readonly grading: GradingStanding;
  /**
   * Fact four: what was decided — and `null` for *nobody has decided yet*,
   * which is not a verdict and must never be drawn as one.
   */
  readonly verdict: Verdict | null;
  /** Present only where grader rows produced one. */
  readonly score: number | undefined;
  /** The judged dimensions, or `null` where nothing was judged. */
  readonly counts: VerdictCounts | null;
};

/**
 * One conversation, read from its machinery status and whatever its grader rows
 * folded to.
 *
 * `graded` is the fold over that conversation's verdict rows, or `undefined`
 * where it has none. It is deliberately the caller's to supply: the rows live in
 * the trace store and this module reaches nothing.
 */
export function foldSimulation(
  status: SimulationStatus,
  graded: FoldedOutcome | undefined,
): SimulationFold {
  // Stopped. There is no conversation to judge, no job was
  // filed, and the honest verdict is that grading was skipped — not that the
  // agent failed, and not that egma is still thinking about it.
  if (status === "canceled") {
    return {
      status,
      grading: "not_required",
      verdict: "skipped",
      score: undefined,
      counts: null,
    };
  }

  // Tried, and could not. Egma's own failure, said in the verdict vocabulary as
  // `errored` — the word that exists precisely so a platform outage cannot be
  // reported as a failing agent.
  if (status === "failed") {
    return {
      status,
      grading: graded === undefined ? "pending" : "graded",
      verdict: "errored",
      score: undefined,
      counts: graded?.counts ?? null,
    };
  }

  if (!GRADABLE.has(status)) {
    // Still moving. Nothing has been judged and nothing is claimed.
    return {
      status,
      grading: "waiting",
      verdict: null,
      score: undefined,
      counts: null,
    };
  }

  return {
    status,
    grading: graded === undefined ? "pending" : "graded",
    verdict: graded?.verdict ?? null,
    score: graded?.score,
    counts: graded?.counts ?? null,
  };
}

/** How many conversations of a run stand in each machinery state. */
export type SimulationStatusCounts = Readonly<
  Record<SimulationStatus, number>
>;

/** Bounded summary inputs read with aggregate queries. */
export type RunSummaryFacts = {
  readonly simulations: Readonly<Partial<Record<SimulationStatus, number>>>;
  readonly judged?: FoldedOutcome | undefined;
};

/** One run's four facts, each as itself. */
export type RunFold = {
  /** Fact one: the run's own machinery. Carried through untouched. */
  readonly status: RunStatus;
  /**
   * Fact four, one grain up: `null` until every conversation has a verdict.
   *
   * A run part-way through judging has no answer yet, and the available lies
   * are both bad: the fold so far reads as a finished result, and `passed`
   * because nothing has failed reads as a clean sweep nobody has earned.
   */
  readonly verdict: Verdict | null;
  readonly score: number | undefined;
  /** Over the conversations' verdicts, so far. Zeroes on a run nobody has judged. */
  readonly counts: VerdictCounts;
  readonly simulations: SimulationStatusCounts;
  /** How many conversations have landed terminal, whichever way. */
  readonly finished: number;
  /** How many left something a grader could read. */
  readonly gradable: number;
  /** How many of those have verdicts. */
  readonly graded: number;
  /** True while machinery or judgment still has somewhere to go. */
  readonly moving: boolean;
};

const NO_SIMULATIONS: SimulationStatusCounts = {
  queued: 0,
  claimed: 0,
  running: 0,
  completed: 0,
  failed: 0,
  canceled: 0,
};

/**
 * A run, read from its own machinery status and from its conversations' folds.
 *
 * **The counts are over simulation verdicts, not over grader rows.** One
 * conversation contributes exactly one verdict here, so a test with forty
 * expected behaviors does not outvote a test with two — which is the difference
 * between "how many conversations went well" and "how many checks passed", and
 * a run header is asking the first.
 *
 * `expected` is the run's own frozen count rather than the number of rows handed
 * over, so a page reading a run whose conversations have not all been written
 * yet still divides by the right denominator.
 */
export function foldRun(
  status: RunStatus,
  expected: number,
  simulations: readonly SimulationFold[],
): RunFold {
  const byStatus: Record<SimulationStatus, number> = { ...NO_SIMULATIONS };
  for (const one of simulations) byStatus[one.status] += 1;

  const counts = { passed: 0, failed: 0, skipped: 0, errored: 0, total: 0 };
  let undecided = simulations.length < expected;
  for (const one of simulations) {
    if (one.verdict === null) {
      undecided = true;
      continue;
    }
    counts[one.verdict] += 1;
    counts.total += 1;
  }

  const scored = counts.total - counts.skipped;
  const decided: Verdict =
    counts.failed > 0
      ? "failed"
      : counts.errored > 0
        ? "errored"
        : scored > 0
          ? "passed"
          : "skipped";

  const finished = simulations.filter((one) => TERMINAL.has(one.status)).length;
  const gradable = simulations.filter((one) => GRADABLE.has(one.status)).length;
  const graded = simulations.filter((one) => one.grading === "graded").length;

  return {
    status,
    verdict: undecided ? null : decided,
    score: scored === 0 ? undefined : counts.passed / scored,
    counts,
    simulations: byStatus,
    finished,
    gradable,
    graded,
    moving: finished < expected || graded < gradable,
  };
}

/**
 * Fold one run header without loading its simulation or verdict rows.
 * Machinery counts come from Postgres GROUP BY and judged counts come from one
 * ClickHouse aggregate row per run. Exact evidence stays on the paged
 * simulation surface.
 */
export function foldRunSummary(
  status: RunStatus,
  expected: number,
  facts: RunSummaryFacts,
): RunFold {
  const simulations: Record<SimulationStatus, number> = { ...NO_SIMULATIONS };
  for (const state of Object.keys(simulations) as SimulationStatus[]) {
    simulations[state] = facts.simulations[state] ?? 0;
  }

  const judged = facts.judged;
  const counts = judged?.counts ?? {
    passed: 0,
    failed: 0,
    skipped: 0,
    errored: 0,
    total: 0,
  };
  const finished =
    simulations.completed + simulations.failed + simulations.canceled;
  const gradable = simulations.completed + simulations.failed;
  const graded = Math.min(judged?.counts.total ?? 0, gradable);
  const decided = finished === expected && graded === gradable;

  return {
    status,
    verdict: decided ? (judged?.verdict ?? (gradable === 0 ? "skipped" : null)) : null,
    score: decided ? judged?.score : undefined,
    counts,
    simulations,
    finished,
    gradable,
    graded,
    moving: finished < expected || graded < gradable,
  };
}
