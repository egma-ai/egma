import { redirect } from "next/navigation";

import { transcriptsPath } from "../../../../lib/transcripts.ts";

/**
 * The monitoring area's own address, which lands on the transcript list.
 *
 * **It forwards rather than drawing anything**, and that is what keeps the
 * landing a decision rather than an accident: there is exactly one page under
 * this area today, the navigation points straight at it, and somebody who typed
 * or bookmarked the area gets the same page as somebody who clicked.
 *
 * `monitoring/dashboard` is **reserved and undecided**. Nothing ships there,
 * nothing links to it, and nothing here claims it — a forward that guessed at a
 * dashboard would be this file deciding a question the effort deliberately left
 * open.
 */
export default async function MonitoringPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  redirect(transcriptsPath(projectId));
}
