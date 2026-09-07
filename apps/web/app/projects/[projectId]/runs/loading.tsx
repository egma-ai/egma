import { Loading } from "../../../../ui/page-state.tsx";
import { ProductStatePage } from "../../../../ui/shell.tsx";

/** Match the Simulation runs title without adding an eyebrow or breadcrumbs. */
export default function RunsLoading() {
  return (
    <div data-slot="route-loading">
      <ProductStatePage title="Runs">
        <Loading what="this project's runs" />
      </ProductStatePage>
    </div>
  );
}
