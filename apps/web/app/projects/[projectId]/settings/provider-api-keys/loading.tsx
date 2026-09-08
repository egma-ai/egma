import { Loading } from "../../../../../ui/page-state.tsx";
import { ProductStatePage } from "../../../../../ui/shell.tsx";

export default function ProviderKeysSettingsLoading() {
  return (
    <div data-slot="route-loading">
      <ProductStatePage title="Provider API Keys">
        <Loading what="provider keys" />
      </ProductStatePage>
    </div>
  );
}
