import { Loading } from "../../../../../ui/page-state.tsx";
import { ProductStatePage } from "../../../../../ui/shell.tsx";

/**
 * What the router draws between the press and
 * `/projects/:projectId/personas/:personaId` arriving.
 *
 * **It names the list rather than the persona**, because the list is what this
 * address draws first and the panel over it is what carries the persona's
 * name. A fallback that titled itself "Persona" would state a page title this
 * address no longer has.
 *
 * `agents/loading.tsx` carries the reasoning every one of these shares.
 */
export default function PersonaLoading() {
  return (
    <div data-slot="route-loading">
      <ProductStatePage title="Personas">
        <Loading what="personas" />
      </ProductStatePage>
    </div>
  );
}
