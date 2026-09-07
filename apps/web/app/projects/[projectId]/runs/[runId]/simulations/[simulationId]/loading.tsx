"use client";

import { useParams } from "next/navigation";

import { projectPath } from "../../../../../../../lib/project-context.ts";
import { Loading } from "../../../../../../../ui/page-state.tsx";
import { ProductStatePage } from "../../../../../../../ui/shell.tsx";

/** Match the simulation evidence page's header while the route loads. */
export default function SimulationLoading() {
  const { projectId, runId } = useParams<{ projectId: string; runId: string }>();

  return (
    <div data-slot="route-loading">
      <ProductStatePage
        title="Simulation"
        breadcrumbs={[
          { label: "Runs", href: projectPath(projectId, "runs") },
          { label: "Run", href: projectPath(projectId, "runs", runId) },
          { label: "Simulation" },
        ]}
      >
        <Loading what="this simulation" />
      </ProductStatePage>
    </div>
  );
}
