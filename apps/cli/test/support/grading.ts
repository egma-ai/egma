/**
 * A simulator, for checks that are not about the simulator.
 *
 * The walk now ends in a run, and a run ends when verdicts arrive. Nothing in
 * CI conducts a simulation, so a check about anything earlier in the walk —
 * finding the voice agent, connecting it, writing the tests — would otherwise
 * sit watching a list that never moves.
 *
 * This is the least a fixture platform needs to look like one that has a
 * simulator attached: every queued simulation is claimed, run, and judged. What
 * verdict it is given is the caller's, so a check that wants a red suite gets
 * one and a check that only wants the run to end does not have to care.
 *
 * A check that is *about* the run screen scripts the lifecycle itself, step by
 * step, and never uses this.
 *
 * What it is handed is the run controls and nothing else, so the smoke check —
 * which points a real wizard at half a real platform — reaches for the same
 * simulator the offline checks do rather than one written twice.
 */

import type { RunControls, Verdict } from "./fixture-platform/index.ts";

/** Anything holding a run's controls: the whole fixture, or half of one. */
export type Running = { readonly running: RunControls };

export type GradingOptions = {
  /** What every simulation is judged. Passed when nothing says otherwise. */
  readonly verdict?: Verdict;
  /** How often the platform is looked at, for the sweeping version. */
  readonly everyMs?: number;
  /**
   * At most this many verdicts per run. Left out, every queued simulation is
   * judged.
   *
   * It is what a check reaches for when the count in the exit line has to come
   * out the same number twice. The wizard leaves at the first verdict, so a
   * sweep that judged a whole suite would leave "1 of 3 graded so far" or "all
   * 3 graded" depending on which poll landed first.
   */
  readonly atMost?: number;
};

/**
 * Judge every simulation of every run this platform holds, once.
 *
 * Answers how many were judged, so a caller can wait for the number it
 * expected rather than for a length of time.
 */
export function gradeWhatIsQueued(platform: Running, options: GradingOptions = {}): number {
  const verdict = options.verdict ?? "passed";
  let judged = 0;

  for (const run of platform.running.runs) {
    const held = platform.running.simulationsOf(run.id);
    let judgedHere = held.filter((one) => one.verdict !== null).length;
    for (const simulation of held) {
      if (simulation.status !== "queued") continue;
      if (options.atMost !== undefined && judgedHere >= options.atMost) break;
      platform.running.advance({ run: run.id, simulation: simulation.id, status: "claimed" });
      if (verdict === "errored") {
        platform.running.advance({
          run: run.id,
          simulation: simulation.id,
          status: "failed",
          verdict: "errored",
        });
      } else {
        platform.running.advance({ run: run.id, simulation: simulation.id, status: "running" });
        platform.running.advance({
          run: run.id,
          simulation: simulation.id,
          status: "completed",
          verdict,
        });
      }
      judgedHere += 1;
      judged += 1;
    }
  }

  return judged;
}

/** A sweep that keeps doing that until it is stopped. */
export function gradeEveryRun(
  platform: Running,
  options: GradingOptions = {},
): { stop(): void } {
  const timer = setInterval(() => {
    try {
      gradeWhatIsQueued(platform, options);
    } catch {
      // A run being written while the sweep looks at it is nothing to say
      // anything about; the next tick sees it whole.
    }
  }, options.everyMs ?? 10);
  timer.unref?.();
  return {
    stop() {
      clearInterval(timer);
    },
  };
}
