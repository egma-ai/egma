"use client";

import { useParams } from "next/navigation";

import { projectPath } from "../../../../../lib/project-context.ts";
import { Loading } from "../../../../../ui/page-state.tsx";
import { ProductStatePage } from "../../../../../ui/shell.tsx";

/**
 * What the router draws between the press and
 * `/projects/:projectId/runs/new` arriving.
 *
 * Planning a run starts with one suite and one agent, so those are what this
 * page is genuinely waiting for, and it says so.
 *
 * Its header is the page's own down to its shape — the same eyebrow or the
 * same crumbs, never one standing in for the other — so nothing is redrawn a
 * second way when the page arrives. `agents/loading.tsx` carries the
 * reasoning every one of these shares.
 */
export default function NewRunLoading() {
  const { projectId } = useParams<{ projectId: string }>();

  return (
    <div data-slot="route-loading">
      <ProductStatePage
        title="Create a run"
        breadcrumbs={[
          { label: "Simulation runs", href: projectPath(projectId, "runs") },
          { label: "New run" },
        ]}
      >
        <Loading what="the test suites and agents in this project" />
      </ProductStatePage>
    </div>
  );
}
