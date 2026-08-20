"use client";

import { useParams } from "next/navigation";

import { projectPath } from "../../../../../../../lib/project-context.ts";
import { Loading } from "../../../../../../../ui/page-state.tsx";
import { ProductStatePage } from "../../../../../../../ui/shell.tsx";

/**
 * What the router draws between the press and
 * `/projects/:projectId/agents/:agentId/connections/new` arriving.
 *
 * **The title is the one word that is true on both ways in.** The page calls
 * itself **Connect the agent** when it is reached from agent setup, which is
 * the common path — registering an agent forwards straight into it — and
 * **Add a connection** when it is reached from the agent later. A fallback
 * cannot read a query string, so guessing would put the wrong half of that
 * either/or on screen for whichever way in it guessed against. **New
 * connection** is the page's own last crumb and is true on both, and the
 * crumbs themselves do not differ between the two paths at all.
 *
 * Its header is the page's own down to its shape — the same eyebrow or the
 * same crumbs, never one standing in for the other — so nothing is redrawn a
 * second way when the page arrives. `agents/loading.tsx` carries the
 * reasoning every one of these shares.
 */
export default function NewConnectionLoading() {
  const { projectId, agentId } = useParams<{ projectId: string; agentId: string }>();

  return (
    <div data-slot="route-loading">
      <ProductStatePage
        title="New connection"
        breadcrumbs={[
          { label: "Agents", href: projectPath(projectId, "agents") },
          { label: "Agent", href: projectPath(projectId, "agents", agentId) },
          { label: "New connection" },
        ]}
      >
        <Loading what="this agent" />
      </ProductStatePage>
    </div>
  );
}
