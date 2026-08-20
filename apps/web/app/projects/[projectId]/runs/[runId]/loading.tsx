"use client";

import { useParams } from "next/navigation";

import { projectPath } from "../../../../../lib/project-context.ts";
import { Loading } from "../../../../../ui/page-state.tsx";
import { ProductStatePage } from "../../../../../ui/shell.tsx";

/**
 * What the router draws between the press and
 * `/projects/:projectId/runs/:runId` arriving.
 *
 * A run is opened while it is still moving, often repeatedly. The wait is
 * short and the flash it would otherwise make is exactly what the entrance
 * delay in the theme is for.
 *
 * Its header is the page's own down to its shape — the same eyebrow or the
 * same crumbs, never one standing in for the other — so nothing is redrawn a
 * second way when the page arrives. `agents/loading.tsx` carries the
 * reasoning every one of these shares.
 */
export default function RunLoading() {
  const { projectId } = useParams<{ projectId: string }>();

  return (
    <div data-slot="route-loading">
      <ProductStatePage
        title="Run"
        breadcrumbs={[
          { label: "Runs", href: projectPath(projectId, "runs") },
          { label: "Run" },
        ]}
      >
        <Loading what="this run" />
      </ProductStatePage>
    </div>
  );
}
