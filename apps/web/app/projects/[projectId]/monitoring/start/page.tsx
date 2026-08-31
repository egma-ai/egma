import { redirect } from "next/navigation";

import { monitoringSetupPath } from "../setup-path.ts";

/**
 * The old Start-monitoring address, kept as a forwarding deep link.
 *
 * **There is one setup flow.** Agents owns Connect agent and the provider-
 * specific Monitoring goal. This route carries an old link into that flow
 * instead of rendering a second monitoring form.
 *
 * `?agent=` rides through. It still names the agent the setup flow should
 * begin from; `goal=monitoring` states why the person entered the flow.
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
