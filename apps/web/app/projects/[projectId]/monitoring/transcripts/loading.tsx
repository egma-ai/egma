import { LIST } from "../../../../../lib/transcript-copy.ts";
import { Loading } from "../../../../../ui/page-state.tsx";
import { ProductStatePage } from "../../../../../ui/shell.tsx";

/** Match the Traces list title while the route loads. */
export default function TranscriptsLoading() {
  return (
    <div data-slot="route-loading">
      <ProductStatePage title={LIST.title}>
        <Loading what={LIST.loadingWhat} />
      </ProductStatePage>
    </div>
  );
}
