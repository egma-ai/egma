import { Loading } from "../../../../../ui/page-state.tsx";
import { ProductStatePage } from "../../../../../ui/shell.tsx";

/** Match the People settings title while membership and invitation reads load. */
export default function PeopleSettingsLoading() {
  return (
    <div data-slot="route-loading">
      <ProductStatePage title="People">
        <Loading what="this organization's people" />
      </ProductStatePage>
    </div>
  );
}
