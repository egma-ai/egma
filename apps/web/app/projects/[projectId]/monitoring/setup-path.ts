import { projectPath } from "../../../../lib/project-context.ts";

/**
 * The shared agent-setup address used by every Monitoring entry point.
 *
 * The Agents page owns the flow. Monitoring only states the user's goal and,
 * when one is already known, the agent the flow should start from. The query
 * is durable UI state: a copied link opens Connect agent with Monitoring
 * selected.
 */
export function monitoringSetupPath(
  projectId: string,
  agentId?: string,
): string {
  const query = new URLSearchParams();
  query.set("sheet", "connect");
  if (agentId !== undefined) query.set("agent", agentId);
  query.set("goal", "monitoring");

  return `${projectPath(projectId, "agents")}?${query.toString()}`;
}
