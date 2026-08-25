/** A small simulator and grader for CLI checks that are about another surface. */

import type { RunControls } from "./fixture-platform/index.ts";

type TerminalGradingState = "not_requested" | "complete" | "error";

export type Running = { readonly running: RunControls };

export type GradingOptions = {
  /** How every completed trace's grading ends. */
  readonly state?: TerminalGradingState;
  readonly everyMs?: number;
  /** At most this many trace results per run. */
  readonly atMost?: number;
};

/** Execute queued simulations and make their whole grading state terminal. */
export function gradeWhatIsQueued(
  platform: Running,
  options: GradingOptions = {},
): number {
  const state = options.state ?? "complete";
  let finished = 0;

  for (const run of platform.running.runs) {
    const held = platform.running.simulationsOf(run.id);
    let finishedHere = held.filter(
      (one) =>
        one.gradingState === "complete" ||
        one.gradingState === "error" ||
        one.gradingState === "not_requested",
    ).length;
    for (const simulation of held) {
      if (simulation.status !== "queued") continue;
      if (options.atMost !== undefined && finishedHere >= options.atMost) break;
      platform.running.advance({
        run: run.id,
        simulation: simulation.id,
        status: "claimed",
      });
      platform.running.advance({
        run: run.id,
        simulation: simulation.id,
        status: "running",
      });
      platform.running.advance({
        run: run.id,
        simulation: simulation.id,
        status: "completed",
      });
      platform.running.setGrading({
        run: run.id,
        simulation: simulation.id,
        state,
      });
      finishedHere += 1;
      finished += 1;
    }
  }

  return finished;
}

/** Keep doing that until the check stops the helper. */
export function gradeEveryRun(
  platform: Running,
  options: GradingOptions = {},
): { stop(): void } {
  const timer = setInterval(() => {
    try {
      gradeWhatIsQueued(platform, options);
    } catch {
      // A run can be half-created during a sweep. The next tick sees it whole.
    }
  }, options.everyMs ?? 10);
  timer.unref?.();
  return {
    stop() {
      clearInterval(timer);
    },
  };
}
