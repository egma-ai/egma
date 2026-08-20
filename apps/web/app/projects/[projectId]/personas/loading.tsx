import { Loading } from "../../../../ui/page-state.tsx";
import { ProductStatePage } from "../../../../ui/shell.tsx";

/**
 * What the router draws between the press and
 * `/projects/:projectId/personas` arriving.
 *
 * A sidebar destination.
 *
 * Its header is the page's own down to its shape — the same eyebrow or the
 * same crumbs, never one standing in for the other — so nothing is redrawn a
 * second way when the page arrives. `agents/loading.tsx` carries the
 * reasoning every one of these shares.
 */
export default function PersonasLoading() {
  return (
    <div data-slot="route-loading">
      <ProductStatePage eyebrow="Project" title="Personas">
        <Loading what="personas" />
      </ProductStatePage>
    </div>
  );
}
