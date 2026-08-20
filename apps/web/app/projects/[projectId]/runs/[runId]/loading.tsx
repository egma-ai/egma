import { Loading } from "../../../../../ui/page-state.tsx";
import { ProductStatePage } from "../../../../../ui/shell.tsx";

/**
 * What the router draws between the press and `/projects/:projectId/runs/:runId` arriving.
 *
 * A run is opened while it is still moving, often repeatedly. The wait is
 * short and the flash it would otherwise make is exactly what the
 * indicator's entrance delay is for.
 *
 * The words are the page's own and the shell above never moves.
 * `agents/loading.tsx` carries the reasoning every one of these shares.
 */
export default function RunLoading() {
  return (
    <ProductStatePage eyebrow="Simulation runs" title="Run">
      <Loading what="this run" />
    </ProductStatePage>
  );
}
