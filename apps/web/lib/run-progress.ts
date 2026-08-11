type SimulationProgress = {
  readonly status: string;
};

type RunProgressInput = {
  readonly expected_simulation_count: number;
  readonly graded_count: number;
  readonly simulations: readonly SimulationProgress[];
};

const TERMINAL = new Set(["completed", "failed", "canceled"]);
const GRADABLE = new Set(["completed", "failed"]);

/**
 * Progress comes from the simulation rows, which settle one at a time. The
 * aggregate counters stay null until the complete run settles, so using them
 * here would hide real progress. Canceled simulations are terminal but are not
 * sent to graders.
 */
export function runProgress(run: RunProgressInput): {
  readonly finished: number;
  readonly gradable: number;
  readonly failed: number;
  readonly moving: boolean;
} {
  const finished = run.simulations.filter((one) => TERMINAL.has(one.status)).length;
  const gradable = run.simulations.filter((one) => GRADABLE.has(one.status)).length;
  const failed = run.simulations.filter((one) => one.status === "failed").length;

  return {
    finished,
    gradable,
    failed,
    moving:
      finished < run.expected_simulation_count || run.graded_count < gradable,
  };
}
