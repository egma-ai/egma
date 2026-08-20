import { Loading } from "../../../../../ui/page-state.tsx";
import { ProductStatePage } from "../../../../../ui/shell.tsx";
import { RUNNING } from "../../../../../lib/grader-running-copy.ts";

/**
 * What the router draws between the press and `/projects/:projectId/graders/running` arriving.
 *
 * The graders tab strip is a page rather than a tab panel, so moving
 * between **Library** and **Running** is a route change and needs its own
 * boundary to stay instant.
 *
 * The words are the page's own and the shell above never moves.
 * `agents/loading.tsx` carries the reasoning every one of these shares.
 */
export default function RunningGradersLoading() {
  return (
    <ProductStatePage eyebrow="Project" title={RUNNING.title}>
      <Loading what={RUNNING.loading} />
    </ProductStatePage>
  );
}
