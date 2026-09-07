"use client";

import { useParams } from "next/navigation";

import { projectPath } from "../../../../../lib/project-context.ts";
import { Loading } from "../../../../../ui/page-state.tsx";
import { ProductStatePage } from "../../../../../ui/shell.tsx";

/** Match the run page's header and breadcrumbs while the route loads. */
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
