import { Loading } from "../../../ui/page-state.tsx";
import { ProductStatePage } from "../../../ui/shell.tsx";

/**
 * What the router draws between the press and
 * `/runs/:runId` arriving.
 *
 * The address a terminal prints, which forwards into the run inside its
 * project. It is usually opened cold, and a link followed from inside the
 * product still crosses this boundary.
 *
 * Its header is the page's own down to its shape — the same eyebrow or the
 * same crumbs, never one standing in for the other — so nothing is redrawn a
 * second way when the page arrives. `agents/loading.tsx` carries the
 * reasoning every one of these shares.
 */
export default function TerminalRunLoading() {
  return (
    <div data-slot="route-loading">
      <ProductStatePage eyebrow="Simulation runs" title="Run">
        <Loading what="this run" />
      </ProductStatePage>
    </div>
  );
}
