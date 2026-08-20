"use client";

import { useParams } from "next/navigation";

import { projectPath } from "../../../../../lib/project-context.ts";
import { Loading } from "../../../../../ui/page-state.tsx";
import { ProductStatePage } from "../../../../../ui/shell.tsx";

/**
 * What the router draws between the press and
 * `/projects/:projectId/agents/new` arriving.
 *
 * This page reads nothing of its own — it is an empty form — and it still
 * needs a boundary. Without one it would inherit the list's, and somebody
 * pressing **Register an agent** would be told egma was loading agents.
 *
 * Its header is the page's own down to its shape — the same eyebrow or the
 * same crumbs, never one standing in for the other — so nothing is redrawn a
 * second way when the page arrives. `agents/loading.tsx` carries the
 * reasoning every one of these shares.
 */
export default function NewAgentLoading() {
  const { projectId } = useParams<{ projectId: string }>();

  return (
    <div data-slot="route-loading">
      <ProductStatePage
        title="Register an agent"
        breadcrumbs={[
          { label: "Agents", href: projectPath(projectId, "agents") },
          { label: "New agent" },
        ]}
      >
        <Loading what="the agent form" />
      </ProductStatePage>
    </div>
  );
}
