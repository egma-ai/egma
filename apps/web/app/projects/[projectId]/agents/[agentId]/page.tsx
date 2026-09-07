import { redirect } from "next/navigation";

/**
 * The agent's own page, retired — its address lands on the list.
 *
 * **The row is the agent** (founder ruling, 2026-08-24). Everything this page
 * held is already on the agents list or in a panel over it: the name and its
 * rename, the connections and the sheet each one opens, and delete. What was
 * left was a second reading of the same row and the only monitoring switch in
 * the product, and monitoring moved to Transcripts, where the calls it pulls
 * actually land.
 *
 * The address stays because links to it are in the CLI, in the documentation
 * and in people's notes. It redirects rather than rendering the list in place:
 * this address named a record that no longer has a surface, so leaving it in
 * the browser bar would be an address that claims to be somewhere it is not.
 */
export default async function AgentPage({
  params,
}: {
  readonly params: Promise<{ readonly projectId: string; readonly agentId: string }>;
}) {
  const { projectId } = await params;
  redirect(`/projects/${encodeURIComponent(projectId)}/agents`);
}
