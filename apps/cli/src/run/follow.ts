/**
 * Follow one run through execution and trace-level grading.
 *
 * Run events report execution. Grading is asynchronous and does not add run
 * events, so each poll also refreshes the bounded simulation page. The
 * follower joins those two views into one row per simulation. It never turns a
 * grade score into a run verdict.
 */

import type { Fetch } from "../platform/device-flow.ts";
import {
  getSimulationGradeProjection,
  getRun,
  hydrateRun,
  runEvents,
  type GradeProjection,
  type GradingState,
  type PlatformRun,
  type PlatformSimulation,
  type RunEvent,
  type RunStatus,
  type SimulationStatus,
} from "../platform/runs.ts";
import type { SignedIn } from "../platform/signed-in.ts";

const TERMINAL_EXECUTION: readonly SimulationStatus[] = [
  "completed",
  "failed",
  "canceled",
];

const TERMINAL_GRADING: readonly GradingState[] = [
  "not_requested",
  "complete",
  "error",
];

export function isTerminalGrading(state: GradingState | null): boolean {
  return state !== null && TERMINAL_GRADING.includes(state);
}

/** One simulation, as a line on a screen or standard output. */
export type SimulationRow = {
  readonly id: string;
  readonly position: number;
  readonly name: string;
  readonly persona: string;
  readonly status: SimulationStatus;
  readonly gradingState: GradingState | null;
  readonly reason: string | null;
  /** Current grades and combined score, once terminal detail was read. */
  readonly gradeProjection: GradeProjection | null;
  /** True for the first completed trace whose whole grading became terminal. */
  readonly firstResult: boolean;
};

/** Execution and grading progress for the run. These are not quality counts. */
export type RunProgress = {
  readonly executionFinished: number;
  readonly executionFailed: number;
  readonly executionCanceled: number;
  readonly gradingTerminal: number;
  readonly gradingComplete: number;
  readonly gradingNotRequested: number;
  readonly gradingErrors: number;
  readonly gradingPending: number;
  readonly gradingRunning: number;
  /** Completed traces that have grading work or an empty grading plan. */
  readonly gradingTotal: number;
  readonly total: number;
};

/** One change worth showing. */
export type RunChange = {
  readonly row: SimulationRow;
  readonly statusChanged: boolean;
  readonly gradingChanged: boolean;
  readonly reasonChanged: boolean;
  readonly gradeProjectionChanged: boolean;
  /** True when this row became the run's first terminal trace result. */
  readonly firstResult: boolean;
};

export type FollowEnding = "finished" | "enough" | "interrupted";

function rowFrom(simulation: PlatformSimulation): SimulationRow {
  return {
    id: simulation.id,
    position: simulation.position,
    name: simulation.testName,
    persona: simulation.personaName,
    status: simulation.status,
    gradingState: simulation.gradingState,
    reason: simulation.reason,
    gradeProjection: simulation.gradeProjection,
    firstResult: false,
  };
}

function hasTerminalResult(row: SimulationRow): boolean {
  return (
    row.status === "completed" &&
    isTerminalGrading(row.gradingState) &&
    row.gradeProjection !== null
  );
}

export class RunFollower {
  private readonly order: string[] = [];
  private readonly byId = new Map<string, SimulationRow>();
  private runStatusHeld: RunStatus;
  private firstResultHeld: string | null = null;
  private cursor = 0;
  private taken = 0;

  readonly runId: string;
  readonly resultsUrl: string;

  constructor(run: PlatformRun) {
    this.runId = run.id;
    this.resultsUrl = run.resultsUrl;
    this.runStatusHeld = run.status;
    for (const simulation of run.simulations) {
      this.order.push(simulation.id);
      const row = rowFrom(simulation);
      if (this.firstResultHeld === null && hasTerminalResult(row)) {
        this.firstResultHeld = row.id;
        this.byId.set(row.id, { ...row, firstResult: true });
      } else {
        this.byId.set(row.id, row);
      }
    }
  }

  get rows(): readonly SimulationRow[] {
    return this.order.flatMap((id) => {
      const row = this.byId.get(id);
      return row === undefined ? [] : [row];
    });
  }

  get runStatus(): RunStatus {
    return this.runStatusHeld;
  }

  get at(): number {
    return this.cursor;
  }

  get firstResult(): SimulationRow | null {
    return this.firstResultHeld === null
      ? null
      : (this.byId.get(this.firstResultHeld) ?? null);
  }

  get progress(): RunProgress {
    const rows = this.rows;
    const completed = rows.filter((row) => row.status === "completed");
    const gradingCount = (state: GradingState): number =>
      completed.filter((row) => row.gradingState === state).length;
    const gradingComplete = gradingCount("complete");
    const gradingNotRequested = gradingCount("not_requested");
    const gradingErrors = gradingCount("error");
    return {
      executionFinished: rows.filter((row) => TERMINAL_EXECUTION.includes(row.status)).length,
      executionFailed: rows.filter((row) => row.status === "failed").length,
      executionCanceled: rows.filter((row) => row.status === "canceled").length,
      gradingTerminal: gradingComplete + gradingNotRequested + gradingErrors,
      gradingComplete,
      gradingNotRequested,
      gradingErrors,
      gradingPending: completed.filter(
        (row) => row.gradingState === null || row.gradingState === "pending",
      ).length,
      gradingRunning: gradingCount("running"),
      gradingTotal: completed.length,
      total: rows.length,
    };
  }

  /** All execution ended, and each completed trace has terminal grading. */
  get everythingTerminal(): boolean {
    return (
      this.rows.length > 0 &&
      this.rows.every(
        (row) =>
          TERMINAL_EXECUTION.includes(row.status) &&
          (row.status !== "completed" ||
            (isTerminalGrading(row.gradingState) && row.gradeProjection !== null)),
      )
    );
  }

  private remember(
    row: SimulationRow,
    change: Omit<RunChange, "row" | "firstResult">,
  ): RunChange {
    const firstResult = hasTerminalResult(row) && this.firstResultHeld === null;
    if (firstResult) this.firstResultHeld = row.id;
    const held = { ...row, firstResult: row.firstResult || firstResult };
    this.byId.set(row.id, held);
    return { row: held, ...change, firstResult };
  }

  private applyExecution(
    simulationId: string,
    incoming: Pick<SimulationRow, "status" | "reason">,
  ): RunChange | null {
    const held = this.byId.get(simulationId);
    if (held === undefined) return null;
    const statusOrder: Readonly<Record<SimulationStatus, number>> = {
      queued: 0,
      claimed: 1,
      running: 2,
      completed: 3,
      failed: 3,
      canceled: 3,
    };
    const statusChanged = statusOrder[incoming.status] > statusOrder[held.status];
    const status = statusChanged ? incoming.status : held.status;
    const reason = incoming.reason ?? held.reason;
    const reasonChanged = reason !== held.reason;
    if (!statusChanged && !reasonChanged) return null;
    return this.remember(
      { ...held, status, reason },
      {
        statusChanged,
        gradingChanged: false,
        reasonChanged,
        gradeProjectionChanged: false,
      },
    );
  }

  private applySnapshot(incoming: PlatformSimulation): RunChange | null {
    const held = this.byId.get(incoming.id);
    if (held === undefined) return null;
    const execution = this.applyExecution(incoming.id, incoming);
    const current = execution?.row ?? held;
    const gradingState = isTerminalGrading(current.gradingState)
      ? current.gradingState
      : (incoming.gradingState ?? current.gradingState);
    const gradingChanged = gradingState !== current.gradingState;
    const gradeProjection = current.gradeProjection ?? incoming.gradeProjection;
    const gradeProjectionChanged =
      current.gradeProjection === null && gradeProjection !== null;
    if (!gradingChanged && !gradeProjectionChanged) return execution;
    const changed = this.remember(
      { ...current, gradingState, gradeProjection },
      {
        statusChanged: execution?.statusChanged ?? false,
        gradingChanged,
        reasonChanged: execution?.reasonChanged ?? false,
        gradeProjectionChanged,
      },
    );
    return changed;
  }

  take(events: readonly RunEvent[], next: number): readonly RunChange[] {
    const changes: RunChange[] = [];
    for (const event of events) {
      if (event.seq <= this.taken) continue;
      this.taken = event.seq;
      if (event.kind === "run") {
        this.runStatusHeld = event.status;
        continue;
      }
      const change = this.applyExecution(event.simulationId, event);
      if (change !== null) changes.push(change);
    }
    this.cursor = Math.max(this.cursor, next);
    return changes;
  }

  /** Merge the current bounded simulation page, including grading progress. */
  refresh(run: PlatformRun): readonly RunChange[] {
    if (run.id !== this.runId) return [];
    const runOrder: Readonly<Record<RunStatus, number>> = {
      pending: 0,
      running: 1,
      completed: 2,
      canceled: 2,
    };
    if (runOrder[run.status] > runOrder[this.runStatusHeld]) {
      this.runStatusHeld = run.status;
    }
    return run.simulations.flatMap((simulation) => {
      const change = this.applySnapshot(simulation);
      return change === null ? [] : [change];
    });
  }
}

export type FollowOptions = {
  readonly signedIn: SignedIn;
  readonly follower: RunFollower;
  readonly onChange: (change: RunChange) => void;
  /** Stop after a caller-specific milestone, such as onboarding's first result. */
  readonly until?: (follower: RunFollower) => boolean;
  readonly everyMs?: number;
  readonly signal?: AbortSignal;
  readonly fetchImpl?: Fetch;
};

export const DEFAULT_POLL_MS = 300;

async function withTerminalGradeProjections(
  options: FollowOptions,
  run: PlatformRun,
): Promise<PlatformRun> {
  const held = new Map(options.follower.rows.map((row) => [row.id, row] as const));
  const simulations: PlatformSimulation[] = [];
  for (const simulation of run.simulations) {
    const known = held.get(simulation.id);
    if (
      simulation.status !== "completed" ||
      !isTerminalGrading(simulation.gradingState) ||
      (known !== undefined && known.gradeProjection !== null)
    ) {
      simulations.push(simulation);
      continue;
    }
    simulations.push({
      ...simulation,
      gradeProjection: await getSimulationGradeProjection(
        options.signedIn,
        simulation.id,
        options.fetchImpl,
        options.signal,
      ),
    });
  }
  return { ...run, simulations };
}

function pause(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted === true) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", stop);
      resolve();
    }, ms);
    function stop(): void {
      clearTimeout(timer);
      resolve();
    }
    signal?.addEventListener("abort", stop, { once: true });
  });
}

/** Watch until execution and grading are terminal, a caller has enough, or Ctrl-C. */
export async function followRun(options: FollowOptions): Promise<FollowEnding> {
  const { signedIn, follower, onChange, signal } = options;
  const everyMs = options.everyMs ?? DEFAULT_POLL_MS;
  const stopped = (): boolean => signal?.aborted === true;

  for (;;) {
    if (stopped()) return "interrupted";

    let page;
    try {
      page = await runEvents(signedIn, follower.runId, follower.at, {
        ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (cause) {
      if (stopped()) return "interrupted";
      throw cause;
    }
    for (const change of follower.take(page.events, page.next)) onChange(change);

    let current;
    try {
      const header = await getRun(signedIn, follower.runId, options.fetchImpl, signal);
      current =
        header === null
          ? null
          : await hydrateRun(signedIn, header, options.fetchImpl, signal);
      if (current !== null) {
        current = await withTerminalGradeProjections(options, current);
      }
    } catch (cause) {
      if (stopped()) return "interrupted";
      throw cause;
    }
    if (current !== null) {
      for (const change of follower.refresh(current)) onChange(change);
    }

    if (options.until?.(follower) === true) return "enough";
    if (page.done && follower.everythingTerminal) return "finished";
    await pause(everyMs, signal);
  }
}
