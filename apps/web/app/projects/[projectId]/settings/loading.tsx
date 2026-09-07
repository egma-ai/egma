import { Loading } from "../../../../ui/page-state.tsx";
import { ProductStatePage } from "../../../../ui/shell.tsx";

/** Match the Project settings title while the route loads. */
export default function SettingsLoading() {
  return (
    <div data-slot="route-loading">
      <ProductStatePage title="Project">
        <Loading what="this project" />
      </ProductStatePage>
    </div>
  );
}
