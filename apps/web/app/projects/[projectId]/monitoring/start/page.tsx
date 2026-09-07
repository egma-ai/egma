import { redirect } from "next/navigation";

import { monitoringSetupPath } from "../setup-path.ts";

/**
 * Forward existing setup links to Agents with goal=monitoring, retaining
 * the selected agent query parameter.
 */
export default async function StartMonitoringPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly projectId: string }>;
  readonly searchParams: Promise<{
    readonly agent?: string | readonly string[];
  }>;
}) {
  const [{ projectId }, asked] = await Promise.all([params, searchParams]);
  const agentId = typeof asked.agent === "string" ? asked.agent : undefined;
  redirect(monitoringSetupPath(projectId, agentId));
}
