import type { PlatformOperationMap } from "./definition.ts";
import { agentOperations } from "./operations/agents.ts";
import { apiKeyOperations } from "./operations/api-keys.ts";
import { graderLibraryOperations } from "./operations/grader-library.ts";
import { graderOperations } from "./operations/graders.ts";
import { memberOperations } from "./operations/members.ts";
import { monitoringOperations } from "./operations/monitoring.ts";
import { organizationOperations } from "./operations/organization.ts";
import { personaOperations } from "./operations/personas.ts";
import { projectOperations } from "./operations/projects.ts";
import { recordingOperations } from "./operations/recordings.ts";
import { repositoryOperations } from "./operations/repository.ts";
import { runOperations } from "./operations/runs.ts";
import { simulationOperations } from "./operations/simulations.ts";
import { testSuiteOperations } from "./operations/test-suites.ts";
import { testOperations } from "./operations/tests.ts";
import { traceReadOperations } from "./operations/trace-reads.ts";

export * from "./definition.ts";
export * from "./schemas.ts";

/**
 * The explicit allowlist for the customer-facing platform API.
 *
 * Route groups add their operation maps here. Auth, self-host settings,
 * simulator work traffic, OTLP, and health never enter this map.
 */
export { agentOperations } from "./operations/agents.ts";
export { apiKeyOperations } from "./operations/api-keys.ts";
export { graderLibraryOperations } from "./operations/grader-library.ts";
export { graderOperations } from "./operations/graders.ts";
export { memberOperations } from "./operations/members.ts";
export { monitoringOperations } from "./operations/monitoring.ts";
export { organizationOperations } from "./operations/organization.ts";
export { personaOperations } from "./operations/personas.ts";
export { projectOperations } from "./operations/projects.ts";
export { recordingOperations } from "./operations/recordings.ts";
export { repositoryOperations } from "./operations/repository.ts";
export { runOperations } from "./operations/runs.ts";
export { simulationOperations } from "./operations/simulations.ts";
export { testSuiteOperations } from "./operations/test-suites.ts";
export { testOperations } from "./operations/tests.ts";
export { traceReadOperations } from "./operations/trace-reads.ts";

export const platformOperations = {
  ...agentOperations,
  ...apiKeyOperations,
  ...graderLibraryOperations,
  ...graderOperations,
  ...memberOperations,
  ...monitoringOperations,
  ...organizationOperations,
  ...personaOperations,
  ...projectOperations,
  ...recordingOperations,
  ...repositoryOperations,
  ...runOperations,
  ...simulationOperations,
  ...testSuiteOperations,
  ...testOperations,
  ...traceReadOperations,
} as const satisfies PlatformOperationMap;
