"use client";

import { useParams } from "next/navigation";

import { projectPath } from "../../../../../../lib/project-context.ts";
import { Loading } from "../../../../../../ui/page-state.tsx";
import { ProductStatePage } from "../../../../../../ui/shell.tsx";

/**
 * What the router draws between the press and
 * `/projects/:projectId/agents/:agentId/onboarding` arriving.
 *
 * Setup is a sequence somebody is walked through, so the step's own title
 * lands immediately and only the agent it is about is waited for. The middle
 * crumb is the agent's name once the page has it and the word until then,
 * which is exactly what the page itself shows while it waits.
 *
 * Its header is the page's own down to its shape — the same eyebrow or the
 * same crumbs, never one standing in for the other — so nothing is redrawn a
 * second way when the page arrives. `agents/loading.tsx` carries the
 * reasoning every one of these shares.
 */
export default function AgentOnboardingLoading() {
  const { projectId, agentId } = useParams<{ projectId: string; agentId: string }>();

  return (
    <div data-slot="route-loading">
      <ProductStatePage
        title="Attach tests"
        breadcrumbs={[
          { label: "Agents", href: projectPath(projectId, "agents") },
          { label: "Agent", href: projectPath(projectId, "agents", agentId) },
          { label: "Attach tests" },
        ]}
      >
        <Loading what="this agent" />
      </ProductStatePage>
    </div>
  );
}
