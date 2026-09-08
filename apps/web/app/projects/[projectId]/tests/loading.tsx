import { Loading } from "../../../../ui/page-state.tsx";
import { ProductStatePage } from "../../../../ui/shell.tsx";

/** Match the Tests list title while the route loads. */
export default function TestsLoading() {
  return (
    <div data-slot="route-loading">
      <ProductStatePage title="Tests">
        <Loading what="tests" />
      </ProductStatePage>
    </div>
  );
}
