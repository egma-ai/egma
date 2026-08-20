import { Loading } from "../../../../ui/page-state.tsx";
import { ProductStatePage } from "../../../../ui/shell.tsx";

/**
 * What the router draws between the press and `/projects/:projectId/personas` arriving.
 *
 * A sidebar destination.
 *
 * The words are the page's own and the shell above never moves.
 * `agents/loading.tsx` carries the reasoning every one of these shares.
 */
export default function PersonasLoading() {
  return (
    <ProductStatePage eyebrow="Project" title="Personas">
      <Loading what="personas" />
    </ProductStatePage>
  );
}
