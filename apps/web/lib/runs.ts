import type {
  CreateRunResponse,
  GetRunResponse,
  ListRunEventsResponse,
  ListRunsResponse,
  ListRunSimulationsResponse,
} from "@egma/platform-api/client";

/** Run wire shapes from the generated platform contract. */
export type StartedRun = CreateRunResponse;
export type RunRow = ListRunsResponse["runs"][number];
export type RunHistoryPage = ListRunsResponse;
export type RunDetail = GetRunResponse;
export type RunSimulationPage = ListRunSimulationsResponse;
export type RunSimulation = RunSimulationPage["simulations"][number];
export type RunEventFeed = ListRunEventsResponse;
export type RunEventRow = RunEventFeed["events"][number];
export type RunStatusWord = RunRow["status"];
export type SimulationStatusWord = RunSimulation["status"];
export type GradingWord = NonNullable<RunSimulation["gradingState"]>;

/**
 * The execution failure sentence shown to a person.
 *
 * New failures retain the simulator's credential-redacted report. Older rows
 * have only the ending category, so each category still has an actionable
 * fallback instead of exposing an internal enum or collapsing to one generic
 * error.
 */
export function executionFailureMessage(
  reason: string | null,
  reported: string | null | undefined,
): string {
  const exact = reported?.trim();
  if (exact !== undefined && exact !== "") return exact;

  switch (reason) {
    case "agent_never_joined":
      return "The agent did not join before the simulation deadline.";
    case "not_answered":
      return "The agent did not answer the simulation.";
    case "capacity":
      return "Egma did not have simulator capacity for this simulation.";
    case "simulator_error":
      return "The simulator encountered an error and could not continue.";
    case "orphaned":
      return "The simulator stopped reporting before this simulation finished.";
    case "dispatch_failed":
      return "Egma could not dispatch this simulation to a simulator.";
    default:
      return "Egma could not conduct this simulation.";
  }
}

export const RUN_STATUS_WORDS: readonly RunStatusWord[] = [
  "pending",
  "running",
  "completed",
  "canceled",
];
