import { Loading } from "../../../../../ui/page-state.tsx";
import { ProductStatePage } from "../../../../../ui/shell.tsx";

/**
 * What the router draws between the press and `/projects/:projectId/tests/:testId` arriving.
 *
 * Reached by pressing a row, where the press has to be answered at once or
 * it reads as a row that does not open.
 *
 * The words are the page's own and the shell above never moves.
 * `agents/loading.tsx` carries the reasoning every one of these shares.
 */
export default function TestLoading() {
  return (
    <ProductStatePage eyebrow="Tests" title="Test">
      <Loading what="this test" />
    </ProductStatePage>
  );
}
