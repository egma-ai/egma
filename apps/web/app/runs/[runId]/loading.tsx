import { Loading } from "../../../ui/page-state.tsx";
import { ProductStatePage } from "../../../ui/shell.tsx";

/**
 * What the router draws between the press and `/runs/:runId` arriving.
 *
 * The address a terminal prints, which forwards into the run inside its
 * project. It is usually opened cold, and a link followed from inside the
 * product still crosses this boundary.
 *
 * The words are the page's own and the shell above never moves.
 * `agents/loading.tsx` carries the reasoning every one of these shares.
 */
export default function TerminalRunLoading() {
  return (
    <ProductStatePage eyebrow="Simulation runs" title="Run">
      <Loading what="this run" />
    </ProductStatePage>
  );
}
