import { Loading } from "../../../../ui/page-state.tsx";
import { ProductStatePage } from "../../../../ui/shell.tsx";

/** Match the Personas list title while the route loads. */
export default function PersonasLoading() {
  return (
    <div data-slot="route-loading">
      <ProductStatePage title="Personas">
        <Loading what="personas" />
      </ProductStatePage>
    </div>
  );
}
