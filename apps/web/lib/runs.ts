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

export const RUN_STATUS_WORDS: readonly RunStatusWord[] = [
  "pending",
  "running",
  "completed",
  "canceled",
];
