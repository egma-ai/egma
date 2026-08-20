import { Loading } from "../../../../ui/page-state.tsx";
import { ProductStatePage } from "../../../../ui/shell.tsx";

/**
 * What the router draws between the press and
 * `/projects/:projectId/tests` arriving.
 *
 * A sidebar destination, so this is one of the seven boundaries a person
 * crosses all day. It is also the one a prefetch fills first.
 *
 * Its header is the page's own down to its shape — the same eyebrow or the
 * same crumbs, never one standing in for the other — so nothing is redrawn a
 * second way when the page arrives. `agents/loading.tsx` carries the
 * reasoning every one of these shares.
 */
export default function TestsLoading() {
  return (
    <div data-slot="route-loading">
      <ProductStatePage eyebrow="Project" title="Tests">
        <Loading what="tests" />
      </ProductStatePage>
    </div>
  );
}
