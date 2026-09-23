import type { InstructionStep } from "./copy-block.tsx";

/** The pieces the Pipecat testing and monitoring instructions share. */

export const PIPECAT_INSTALL = 'pip install "egma[pipecat]"';

/**
 * The key a Pipecat bot exports with. Production traces are filed under the
 * agent whose guarded monitoring key sent them, so a plain project key would
 * leave them with no agent.
 */
export const MONITORING_KEY_PLACEHOLDER = "<agent-monitoring-key>";

/** The CLI command that mints one agent's monitoring key. */
export function monitoringKeyCommand(agentId: string | null): string {
  return `egma agent monitoring --agent ${agentId ?? "<agent-id>"}`;
}

/**
 * The step that gets the agent's monitoring key.
 *
 * With no agent yet, a monitoring-only setup registers one first; a Both
 * setup registers it with its simulation connection, and the testing
 * instructions repeat this step with the real agent id.
 */
export function monitoringKeyStep(
  agentId: string | null,
  registers: boolean,
): InstructionStep {
  if (agentId === null && registers) {
    return {
      title: "Register the agent and get its monitoring key",
      value: `egma agent register --platform pipecat\n${monitoringKeyCommand(null)}`,
      copyLabel: "monitoring key commands",
    };
  }
  return {
    title: "Get this agent's monitoring key",
    value: monitoringKeyCommand(agentId),
    copyLabel: "monitoring key command",
  };
}
