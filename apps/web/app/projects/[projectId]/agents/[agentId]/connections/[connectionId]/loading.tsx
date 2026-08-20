"use client";

import { useParams } from "next/navigation";

import { projectPath } from "../../../../../../../lib/project-context.ts";
import { Loading } from "../../../../../../../ui/page-state.tsx";
import { ProductStatePage } from "../../../../../../../ui/shell.tsx";

/**
 * What the router draws between the press and
 * `/projects/:projectId/agents/:agentId/connections/:connectionId` arriving.
 *
 * How egma reaches an agent is the slowest read in this family — the
 * platform is asked about the target as well — so this is the boundary that
 * shows for longest, and the one that most needed to exist.
 *
 * Its header is the page's own down to its shape — the same eyebrow or the
 * same crumbs, never one standing in for the other — so nothing is redrawn a
 * second way when the page arrives. `agents/loading.tsx` carries the
 * reasoning every one of these shares.
 */
export default function ConnectionLoading() {
  const { projectId, agentId } = useParams<{ projectId: string; agentId: string }>();

  return (
    <div data-slot="route-loading">
      <ProductStatePage
        title="Connection"
        breadcrumbs={[
          { label: "Agents", href: projectPath(projectId, "agents") },
          { label: "Agent", href: projectPath(projectId, "agents", agentId) },
          { label: "Connection" },
        ]}
      >
        <Loading what="this connection" />
      </ProductStatePage>
    </div>
  );
}
