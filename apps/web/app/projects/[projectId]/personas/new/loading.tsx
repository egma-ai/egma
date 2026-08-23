import { Loading } from "../../../../../ui/page-state.tsx";
import { ProductStatePage } from "../../../../../ui/shell.tsx";

/**
 * What the router draws between the press and
 * `/projects/:projectId/personas/new` arriving.
 *
 * **It names the list rather than the form**, because the list is what this
 * address draws first: the New sheet opens over it. A fallback titled "New
 * persona" would put a second page title on screen for a moment and then take
 * it away again.
 *
 * `agents/loading.tsx` carries the reasoning every one of these shares.
 */
export default function NewPersonaLoading() {
  return (
    <div data-slot="route-loading">
      <ProductStatePage title="Personas">
        <Loading what="personas" />
      </ProductStatePage>
    </div>
  );
}
