import { Loading } from "../../../../../ui/page-state.tsx";
import { ProductStatePage } from "../../../../../ui/shell.tsx";

/**
 * What the router draws between the press and `/projects/:projectId/tests/new` arriving.
 *
 * Its own boundary rather than the list's, for the same reason the new
 * agent form has one: **Write a test** must not be answered with
 * “Loading tests…”.
 *
 * The words are the page's own and the shell above never moves.
 * `agents/loading.tsx` carries the reasoning every one of these shares.
 */
export default function NewTestLoading() {
  return (
    <ProductStatePage eyebrow="Tests" title="Write a test">
      <Loading what="the test form" />
    </ProductStatePage>
  );
}
