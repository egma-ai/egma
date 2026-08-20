import { Loading } from "../../../../../ui/page-state.tsx";
import { ProductStatePage } from "../../../../../ui/shell.tsx";

/**
 * What the router draws between the press and `/projects/:projectId/personas/new` arriving.
 *
 * The form cannot be drawn until egma says which models a persona may
 * speak with, so that read is what it names.
 *
 * The words are the page's own and the shell above never moves.
 * `agents/loading.tsx` carries the reasoning every one of these shares.
 */
export default function NewPersonaLoading() {
  return (
    <ProductStatePage eyebrow="Personas" title="New persona">
      <Loading what="the supported persona models" />
    </ProductStatePage>
  );
}
