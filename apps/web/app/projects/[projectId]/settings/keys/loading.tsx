import { Loading } from "../../../../../ui/page-state.tsx";
import { ProductStatePage } from "../../../../../ui/shell.tsx";

/** Match the API keys page title while the route loads. */
export default function KeysSettingsLoading() {
  return (
    <div data-slot="route-loading">
      <ProductStatePage title="API keys">
        <Loading what="your keys" />
      </ProductStatePage>
    </div>
  );
}
