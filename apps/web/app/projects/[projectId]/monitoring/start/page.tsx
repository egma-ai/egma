import { redirect } from "next/navigation";

import { monitoringSetupPath } from "../setup-path.ts";

/**
 * The old Start-monitoring address, kept as a forwarding deep link.
 *
 * **There is one setup handoff.** This route carries an old link to the three
 * current coding-agent prompts instead of restoring the retired wizard state.
 */
export default async function StartMonitoringPage({
  params,
}: {
  readonly params: Promise<{ readonly projectId: string }>;
}) {
  const { projectId } = await params;
  redirect(monitoringSetupPath(projectId));
}
