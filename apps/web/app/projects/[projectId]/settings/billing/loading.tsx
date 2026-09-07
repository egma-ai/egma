import { Loading } from "@/ui/page-state";
import { ProductStatePage } from "@/ui/shell";

export default function UsageAndBillingLoading() {
  return (
    <div data-slot="route-loading">
      <ProductStatePage title="Usage and billing">
        <Loading what="usage and billing" />
      </ProductStatePage>
    </div>
  );
}
