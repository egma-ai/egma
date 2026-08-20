"use client";

import { useParams } from "next/navigation";

import { projectPath } from "../../../../../lib/project-context.ts";
import { Loading } from "../../../../../ui/page-state.tsx";
import { ProductStatePage } from "../../../../../ui/shell.tsx";

/**
 * What the router draws between the press and
 * `/projects/:projectId/agents/:agentId` arriving.
 *
 * The last crumb is the word rather than the agent's name, because the name
 * is in the answer that has not arrived. The page says the same word in its
 * own loading branch, so nothing is renamed twice on the way in.
 *
 * Its header is the page's own down to its shape — the same eyebrow or the
 * same crumbs, never one standing in for the other — so nothing is redrawn a
 * second way when the page arrives. `agents/loading.tsx` carries the
 * reasoning every one of these shares.
 */
export default function AgentLoading() {
  const { projectId } = useParams<{ projectId: string }>();

  return (
    <div data-slot="route-loading">
      <ProductStatePage
        title="Agent"
        breadcrumbs={[
          { label: "Agents", href: projectPath(projectId, "agents") },
          { label: "Agent" },
        ]}
      >
        <Loading what="this agent" />
      </ProductStatePage>
    </div>
  );
}
