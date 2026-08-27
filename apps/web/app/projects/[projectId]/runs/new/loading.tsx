import { Loading } from "../../../../../ui/page-state.tsx";
import { ProductStatePage } from "../../../../../ui/shell.tsx";

/**
 * What the router draws between the press and
 * `/projects/:projectId/runs/new` arriving.
 *
 * The address draws the Runs list with a Create run sheet over it. A route
 * fallback cannot open the interactive sheet yet, so it keeps the list's
 * title while that screen arrives.
 */
export default function NewRunLoading() {
  return (
    <div data-slot="route-loading">
      <ProductStatePage title="Runs">
        <Loading what="simulation runs" />
      </ProductStatePage>
    </div>
  );
}
