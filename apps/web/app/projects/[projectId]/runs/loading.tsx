import { Loading } from "../../../../ui/page-state.tsx";
import { ProductStatePage } from "../../../../ui/shell.tsx";

/**
 * What the router draws between the press and
 * `/projects/:projectId/runs` arriving.
 *
 * No eyebrow and no crumbs, because the page has neither: **Simulation
 * runs** is the whole label, and either would be a line the header gains and
 * then loses.
 *
 * Its header is the page's own down to its shape — the same eyebrow or the
 * same crumbs, never one standing in for the other — so nothing is redrawn a
 * second way when the page arrives. `agents/loading.tsx` carries the
 * reasoning every one of these shares.
 */
export default function RunsLoading() {
  return (
    <div data-slot="route-loading">
      <ProductStatePage title="Runs">
        <Loading what="this project's runs" />
      </ProductStatePage>
    </div>
  );
}
