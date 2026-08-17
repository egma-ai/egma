/**
 * Following a run: the changes as they land, and what they add up to.
 *
 * A run is started once and then watched, so this holds the one row per
 * simulation that both the terminal screen and the plain lines are drawn from,
 * and moves those rows as the platform reports changes. It draws nothing and
 * prints nothing — what to do with a change is the caller's, which is why the
 * wizard's pane and `egma run`'s standard output can be the same facts said
 * two ways without being two accounts of them.
 *
 * **The first verdict is marked here and nowhere else.** It is the moment the
 * whole walk is timed against — the point where a developer stops taking
 * egma's word for it and reads a result — so which change it was is a fact
 * about the run, not a decision a screen makes while drawing. Whichever of the
 * four it is: a verdict is a verdict, and a wizard that held out past a
 * `skipped` for something greener would be waiting for the whole suite it
 * promised not to wait for.
 *
 * **A simulation only ever moves forward.** Changes arrive numbered and are
 * taken in that order, once each, so a page delivered twice cannot walk a
 * judged simulation back to the moment it was picked up.
 *
 * **Nothing is folded.** `skipped` and `errored` are counted as themselves all
 * the way through: a test that could not run is not a test that failed, and a
 * tally that said otherwise would be egma quietly marking a suite red on the
 * strength of its own outage.
 */

import type { Fetch } from "../platform/device-flow.ts";
import {
  getRun,
  runEvents,
  type PlatformRun,
  type PlatformSimulation,
  type RunEvent,
  type RunStatus,
  type SimulationStatus,
  type Verdict,
} from "../platform/runs.ts";
import type { SignedIn } from "../platform/signed-in.ts";

/** One simulation, as a line on a screen or a line on standard output. */
export type SimulationRow = {
  readonly id: string;
  readonly position: number;
  /** The test this executes. */
  readonly name: string;
  /** The synthetic person who speaks to the agent in it. */
  readonly persona: string;
  readonly status: SimulationStatus;
  readonly verdict: Verdict | null;
  readonly reason: string | null;
  /** True for the one simulation whose verdict landed first in this run. */
  readonly first: boolean;
};

/**
 * What the run adds up to, right now.
 *
 * The four verdicts, each counted as itself, plus how many have not been
 * judged yet — because a wizard that leaves before the suite finishes has to
 * be able to say "three of twelve so far" and mean it.
 */
export type RunTally = {
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly errored: number;
  /** Simulations with no verdict yet. */
  readonly pending: number;
  /** Simulations with one. */
  readonly graded: number;
  readonly total: number;
};

/** One change worth telling somebody about. */
export type RunChange = {
  readonly row: SimulationRow;
  /** True when this change moved the execution state. */
  readonly statusChanged: boolean;
  /** True when this change is a verdict arriving. */
  readonly verdictLanded: boolean;
  /** True when it is the first verdict of the whole run. */
  readonly first: boolean;
};

/** How a follow ended. */
export type FollowEnding =
  /** Execution and grading both finished. */
  | "finished"
  /** What the caller was waiting for happened, and the run carries on. */
  | "enough"
  /** The developer stopped it. */
  | "interrupted";

function verdictless(simulation: PlatformSimulation): SimulationRow {
  return {
    id: simulation.id,
    position: simulation.position,
    name: simulation.testName,
    persona: simulation.personaName,
    status: simulation.status,
    verdict: simulation.verdict,
    reason: simulation.reason,
    first: false,
  };
}

/**
 * The state of one run being watched.
 *
 * Seeded from the run as it was started or as it was read back, then moved by
 * the changes the platform reports. Reading it is free and gives the same
 * answer to everybody, which is what lets a screen redraw from it as often as
 * it likes.
 */
export class RunFollower {
  private readonly order: string[] = [];
  private readonly byId = new Map<string, SimulationRow>();
  private runStatusHeld: RunStatus;
  private firstHeld: string | null = null;
  private cursor = 0;
  /**
   * The highest change this follower has already acted on.
   *
   * Kept apart from the cursor because the two answer different questions. The
   * cursor is where to ask from and the platform owns it; this is what has
   * already happened here, and it is what makes a change arriving twice a
   * change that is not news. Without it a page delivered again would walk a
   * simulation backwards through its own lifecycle — a judged one would lose
   * its verdict to the `claimed` event that came before it, land the same
   * verdict a second time, and be drawn as though it had started over.
   */
  private taken = 0;

  readonly runId: string;
  readonly resultsUrl: string;

  constructor(run: PlatformRun) {
    this.runId = run.id;
    this.resultsUrl = run.resultsUrl;
    this.runStatusHeld = run.status;
    for (const simulation of run.simulations) {
      this.order.push(simulation.id);
      this.byId.set(simulation.id, verdictless(simulation));
      // A run read back part way through already has verdicts on it, and the
      // first of them is still the first of them.
      if (simulation.verdict !== null && this.firstHeld === null) {
        this.firstHeld = simulation.id;
        this.byId.set(simulation.id, { ...verdictless(simulation), first: true });
      }
    }
  }

  /** Every simulation, in the order the run laid them out. */
  get rows(): readonly SimulationRow[] {
    return this.order.flatMap((id) => {
      const row = this.byId.get(id);
      return row === undefined ? [] : [row];
    });
  }

  get runStatus(): RunStatus {
    return this.runStatusHeld;
  }

  /** Where the next page of changes is asked from. */
  get at(): number {
    return this.cursor;
  }

  /** The simulation whose verdict landed first, or `null` while none has. */
  get firstVerdict(): SimulationRow | null {
    return this.firstHeld === null ? null : (this.byId.get(this.firstHeld) ?? null);
  }

  get tally(): RunTally {
    const rows = this.rows;
    const count = (verdict: Verdict): number =>
      rows.filter((row) => row.verdict === verdict).length;
    const graded = rows.filter((row) => row.verdict !== null).length;
    return {
      passed: count("passed"),
      failed: count("failed"),
      skipped: count("skipped"),
      errored: count("errored"),
      pending: rows.length - graded,
      graded,
      total: rows.length,
    };
  }

  /** True once every simulation has been judged. */
  get everythingGraded(): boolean {
    return this.tally.pending === 0 && this.tally.total > 0;
  }

  /** True while at least one finished simulation is waiting for its grader. */
  get awaitingVerdicts(): boolean {
    return this.rows.some(
      (row) =>
        ["completed", "failed", "canceled", "skipped"].includes(row.status) &&
        row.verdict === null,
    );
  }

  private apply(
    simulationId: string,
    incoming: Pick<SimulationRow, "status" | "verdict" | "reason">,
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
      skipped: 3,
    };
    const statusChanged = statusOrder[incoming.status] > statusOrder[held.status];
    const status = statusChanged ? incoming.status : held.status;
    const verdict = held.verdict ?? incoming.verdict;
    const verdictLanded = held.verdict === null && verdict !== null;
    const reason = incoming.reason ?? held.reason;
    const reasonChanged = reason !== held.reason;
    if (!statusChanged && !verdictLanded && !reasonChanged) return null;

    const first = verdictLanded && this.firstHeld === null;
    if (first) this.firstHeld = simulationId;
    const row: SimulationRow = {
      ...held,
      status,
      verdict,
      reason,
      first: held.first || first,
    };
    this.byId.set(simulationId, row);
    return { row, statusChanged, verdictLanded, first };
  }

  /**
   * Take one page of changes, in order, and answer the ones a caller would
   * want to say out loud. A change to a simulation this follower has never
   * heard of is ignored rather than invented — the run laid its simulations
   * out at creation and their number is stamped there.
   *
   * A change that has already been taken is ignored too, however it arrived
   * again. A page can come twice — a platform that answers with a cursor it
   * has not moved sends the same page on the next ask — and every one of those
   * changes is old news by then, so none of them is said again.
   */
  take(events: readonly RunEvent[], next: number): readonly RunChange[] {
    const changes: RunChange[] = [];
    for (const event of events) {
      if (event.seq <= this.taken) continue;
      this.taken = event.seq;
      if (event.kind === "run") {
        this.runStatusHeld = event.status;
        continue;
      }
      const change = this.apply(event.simulationId, event);
      if (change !== null) changes.push(change);
    }
    this.cursor = Math.max(this.cursor, next);
    return changes;
  }

  /**
   * Merge the platform's current run snapshot.
   *
   * Grading is asynchronous and does not append to the execution event feed,
   * so verdicts arrive here. The merge is monotonic: a snapshot or a later
   * event can move a row forward, but neither can clear a verdict or rewind a
   * finished simulation.
   */
  refresh(run: PlatformRun): readonly RunChange[] {
    if (run.id !== this.runId) return [];
    const runOrder: Readonly<Record<RunStatus, number>> = {
      pending: 0,
      running: 1,
      completed: 2,
      canceled: 2,
    };
    if (runOrder[run.status] > runOrder[this.runStatusHeld]) this.runStatusHeld = run.status;

    const changes: RunChange[] = [];
    for (const simulation of run.simulations) {
      const change = this.apply(simulation.id, simulation);
      if (change !== null) changes.push(change);
    }
    return changes;
  }
}

export type FollowOptions = {
  readonly signedIn: SignedIn;
  readonly follower: RunFollower;
  /** Told about every change, in the order it happened. */
  readonly onChange: (change: RunChange) => void;
  /**
   * Answered after every page. `true` stops the follow with `enough` — which
   * is how the wizard leaves as soon as the developer has seen a verdict,
   * while the suite carries on running on the platform.
   */
  readonly until?: (follower: RunFollower) => boolean;
  /** How long between asks. */
  readonly everyMs?: number;
  readonly signal?: AbortSignal;
  readonly fetchImpl?: Fetch;
};

/**
 * How often a follower asks what has changed.
 *
 * Short enough that a verdict appears when it happened rather than a second
 * later, and long enough that watching a twelve-test suite is a handful of
 * requests a second against one small answer.
 */
export const DEFAULT_POLL_MS = 300;

function pause(ms: number, signal: AbortSignal | undefined): Promise<void> {
  // A signal that has already aborted never fires again, so waiting on it
  // would be waiting out the whole interval for a follow that is over.
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

/**
 * Watch a run until it finishes, until the caller has seen enough, or until
 * the developer stops it.
 *
 * The cursor is the whole of the resumption story: every ask names where the
 * last one got to, so a page that never arrived is asked for again rather than
 * lost, and a change is never handed over twice.
 */
export async function followRun(options: FollowOptions): Promise<FollowEnding> {
  const { signedIn, follower, onChange, signal } = options;
  const everyMs = options.everyMs ?? DEFAULT_POLL_MS;

  /** Asked, never remembered: a signal fires while this function is waiting. */
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
      // A stop that lands mid-request tears the request down, and the error
      // that comes back is the stop rather than anything about the run. Saying
      // "egma stopped answering" because somebody pressed Ctrl-C would be egma
      // blaming the platform for the developer's own decision.
      if (stopped()) return "interrupted";
      throw cause;
    }
    for (const change of follower.take(page.events, page.next)) onChange(change);

    if (follower.awaitingVerdicts) {
      let snapshot;
      try {
        snapshot = await getRun(signedIn, follower.runId, options.fetchImpl, signal);
      } catch (cause) {
        if (stopped()) return "interrupted";
        throw cause;
      }
      if (snapshot !== null) {
        for (const change of follower.refresh(snapshot)) onChange(change);
      }
    }

    if (options.until?.(follower) === true) return "enough";
    if (page.done && follower.everythingGraded) return "finished";

    // Stopping is checked at the top of the loop and nowhere else, so there is
    // one place it can happen; the pause above returns at once on a signal that
    // has already fired.
    await pause(everyMs, signal);
  }
}
