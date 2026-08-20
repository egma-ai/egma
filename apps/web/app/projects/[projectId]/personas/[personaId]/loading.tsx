import { Loading } from "../../../../../ui/page-state.tsx";
import { ProductStatePage } from "../../../../../ui/shell.tsx";

/**
 * What the router draws between the press and `/projects/:projectId/personas/:personaId` arriving.
 *
 * No eyebrow: this page titles itself with the persona's name and carries
 * breadcrumbs instead, and a fallback knows neither.
 *
 * The words are the page's own and the shell above never moves.
 * `agents/loading.tsx` carries the reasoning every one of these shares.
 */
export default function PersonaLoading() {
  return (
    <ProductStatePage title="Persona">
      <Loading what="this persona" />
    </ProductStatePage>
  );
}
