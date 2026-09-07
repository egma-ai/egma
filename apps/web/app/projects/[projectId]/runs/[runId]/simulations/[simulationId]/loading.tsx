"use client";

import { useParams } from "next/navigation";

import { projectPath } from "../../../../../../../lib/project-context.ts";
import { Loading } from "../../../../../../../ui/page-state.tsx";
import { ProductStatePage } from "../../../../../../../ui/shell.tsx";

/**
 * What the router draws between the press and
 * `/projects/:projectId/runs/:runId/simulations/:simulationId` arriving.
 *
 * One simulation carries its transcript, its judgements and its evidence,
 * which is the heaviest read in the product and the longest a person waits
 * anywhere in it.
 *
 * Its header is the page's own down to its shape — the same eyebrow or the
 * same crumbs, never one standing in for the other — so nothing is redrawn a
 * second way when the page arrives. `agents/loading.tsx` carries the
 * reasoning every one of these shares.
 */
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
