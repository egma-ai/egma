"use client";

import { useParams } from "next/navigation";

import { projectPath } from "../../../../../lib/project-context.ts";
import { Loading } from "../../../../../ui/page-state.tsx";
import { ProductStatePage } from "../../../../../ui/shell.tsx";

/**
 * What the router draws between the press and
 * `/projects/:projectId/monitoring/setup` arriving.
 *
 * **This route arrived without one.** The boundary sweep gave every route in
 * the application a pending state; production monitoring added this page in a
 * separate lane, and the two merged without meeting, so the one new route was
 * the one route left holding the previous page on press.
 *
 * Its header is the page's own down to its shape — the same eyebrow or the
 * same crumbs, never one standing in for the other — so nothing is redrawn a
 * second way when the page arrives. The page reads its setups behind these
 * crumbs, so a slow read is answered here rather than by a still screen.
 * `agents/loading.tsx` carries the reasoning every one of these shares.
 */
export default function MonitoringSetupLoading() {
  const { projectId } = useParams<{ projectId: string }>();

  return (
    <div data-slot="route-loading">
      <ProductStatePage
        title="Set up monitoring"
        breadcrumbs={[
          {
            label: "Monitoring",
            href: projectPath(projectId, "monitoring", "transcripts"),
          },
          { label: "Setup" },
        ]}
      >
        <Loading what="Monitoring setup" />
      </ProductStatePage>
    </div>
  );
}
