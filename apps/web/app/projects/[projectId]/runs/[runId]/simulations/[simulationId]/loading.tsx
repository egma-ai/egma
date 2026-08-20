import { Loading } from "../../../../../../../ui/page-state.tsx";
import { ProductStatePage } from "../../../../../../../ui/shell.tsx";

/**
 * What the router draws between the press and `/projects/:projectId/runs/:runId/simulations/:simulationId` arriving.
 *
 * One simulation carries its transcript, its judgements and its evidence,
 * which is the heaviest read in the product and the longest a person waits
 * anywhere in it.
 *
 * The words are the page's own and the shell above never moves.
 * `agents/loading.tsx` carries the reasoning every one of these shares.
 */
export default function SimulationLoading() {
  return (
    <ProductStatePage eyebrow="Simulation runs" title="Simulation">
      <Loading what="this simulation" />
    </ProductStatePage>
  );
}
