/**
 * A run, as something a screen can draw and a plain-line UI can print.
 *
 * The follower holds the state; this is the flat picture of it that crosses
 * the UI seam. It is a value rather than the follower itself for the same
 * reason every other pane is: a screen that held a live object would redraw
 * from something changing underneath it, and a check that built one by hand
 * could not.
 */

import type { RunTally, SimulationRow } from "./follow.ts";

export type RunView = {
  readonly runId: string;
  /** One line per simulation, in the order the run laid them out. */
  readonly rows: readonly SimulationRow[];
  readonly tally: RunTally;
  /**
   * The simulation whose verdict landed first, or `null` while none has.
   *
   * The moment this stops being `null` is the moment the walk is timed
   * against, so the screen marks it rather than letting it scroll past like
   * every other change.
   */
  readonly firstVerdict: SimulationRow | null;
  /** Where a person opens what happened. */
  readonly resultsUrl: string;
};

/** Everything one simulation's line says, in the words the glossary uses. */
export type { SimulationRow, RunTally } from "./follow.ts";
