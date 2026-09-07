import { Loading } from "../../../../ui/page-state.tsx";
import { ProductStatePage } from "../../../../ui/shell.tsx";

/**
 * Match the Agents header while route content loads; the shared shell remains
 * mounted. Do not invent data-dependent controls. The route-loading theme slot
 * provides the fallback delay and entrance.
 */
export default function AgentsLoading() {
  return (
    <div data-slot="route-loading">
      <ProductStatePage title="Agents">
        <Loading what="agents" />
      </ProductStatePage>
    </div>
  );
}
