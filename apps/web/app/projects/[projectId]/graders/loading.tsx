import { Loading } from "../../../../ui/page-state.tsx";
import { ProductStatePage } from "../../../../ui/shell.tsx";

export default function GradersLoading() {
  return (
    <div data-slot="route-loading">
      <ProductStatePage eyebrow="Project" title="Graders">
        <Loading what="graders" />
      </ProductStatePage>
    </div>
  );
}
