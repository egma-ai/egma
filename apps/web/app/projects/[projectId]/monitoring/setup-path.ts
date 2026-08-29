import { projectPath } from "../../../../lib/project-context.ts";

/**
 * The shared coding-agent handoff used by every Monitoring entry point.
 *
 * The sheet always shows all three outcomes. Monitoring does not encode a
 * hidden selection or an old wizard step in its address.
 */
export function monitoringSetupPath(projectId: string): string {
  return `${projectPath(projectId, "agents")}?sheet=connect`;
}
