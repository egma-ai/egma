import { Loading } from "../../../../ui/page-state.tsx";
import { ProductStatePage } from "../../../../ui/shell.tsx";

/**
 * What the router draws between the press and `/projects/:projectId/tests` arriving.
 *
 * A sidebar destination, so this is one of the seven boundaries a person
 * crosses all day. It is also the one a prefetch fills first.
 *
 * The words are the page's own and the shell above never moves.
 * `agents/loading.tsx` carries the reasoning every one of these shares.
 */
export default function TestsLoading() {
  return (
    <ProductStatePage eyebrow="Project" title="Tests">
      <Loading what="tests" />
    </ProductStatePage>
  );
}
