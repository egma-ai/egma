import { Loading } from "../../../../ui/page-state.tsx";
import { ProductStatePage } from "../../../../ui/shell.tsx";

/**
 * What the router draws between the press and `/projects/:projectId/runs` arriving.
 *
 * No eyebrow, because the page has none: **Simulation runs** is the whole
 * label, and the header would otherwise gain a line on arrival.
 *
 * The words are the page's own and the shell above never moves.
 * `agents/loading.tsx` carries the reasoning every one of these shares.
 */
export default function RunsLoading() {
  return (
    <ProductStatePage title="Simulation runs">
      <Loading what="this project's runs" />
    </ProductStatePage>
  );
}
