import { LIBRARY } from "../../../../lib/grader-library-copy.ts";
import { Loading } from "../../../../ui/page-state.tsx";
import { ProductStatePage } from "../../../../ui/shell.tsx";

/**
 * What the router draws between the press and
 * `/projects/:projectId/graders` arriving.
 *
 * The words come from the copy module the page reads, not from a second copy
 * of them here. Two places to rename **Graders** is one too many.
 *
 * Its header is the page's own down to its shape — the same eyebrow or the
 * same crumbs, never one standing in for the other — so nothing is redrawn a
 * second way when the page arrives. `agents/loading.tsx` carries the
 * reasoning every one of these shares.
 */
export default function GradersLoading() {
  return (
    <div data-slot="route-loading">
      <ProductStatePage eyebrow="Project" title={LIBRARY.title}>
        <Loading what={LIBRARY.loading} />
      </ProductStatePage>
    </div>
  );
}
