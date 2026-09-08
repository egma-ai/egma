import { Loading } from "../../../../../../../ui/page-state.tsx";
import { ProductStatePage } from "../../../../../../../ui/shell.tsx";

/** Match the Agents list behind the connection sheet while route data loads. */
export default function ConnectionLoading() {
  return (
    <div data-slot="route-loading">
      <ProductStatePage title="Agents">
        <Loading what="agents" />
      </ProductStatePage>
    </div>
  );
}
