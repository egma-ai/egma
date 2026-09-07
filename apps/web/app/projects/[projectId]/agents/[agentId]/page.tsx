import { redirect } from "next/navigation";

/** Keep existing agent-detail links usable by redirecting them to the Agents list. */
export default async function AgentPage({
  params,
}: {
  readonly params: Promise<{ readonly projectId: string; readonly agentId: string }>;
}) {
  const { projectId } = await params;
  redirect(`/projects/${encodeURIComponent(projectId)}/agents`);
}
