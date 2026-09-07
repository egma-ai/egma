import { redirect } from "next/navigation";

import { transcriptsPath } from "../../../../lib/transcripts.ts";

/** Redirect the monitoring area URL to the project's Traces list. */
export default async function MonitoringPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  redirect(transcriptsPath(projectId));
}
