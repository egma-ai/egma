import { Loading } from "../../../../../ui/page-state.tsx";
import { ProductStatePage } from "../../../../../ui/shell.tsx";

/** Match the Organization settings title while the route loads. */
export default function OrganizationSettingsLoading() {
  return (
    <div data-slot="route-loading">
      <ProductStatePage title="Organization">
        <Loading what="this organization" />
      </ProductStatePage>
    </div>
  );
}
