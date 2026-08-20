import { Loading } from "../../../../../../../ui/page-state.tsx";
import { ProductStatePage } from "../../../../../../../ui/shell.tsx";

/**
 * What the router draws between the press and `/projects/:projectId/agents/:agentId/connections/:connectionId` arriving.
 *
 * How egma reaches an agent is the slowest read in this family — the
 * platform is asked about the target as well — so this is the boundary that
 * shows for longest, and the one that most needed to exist.
 *
 * The words are the page's own and the shell above never moves.
 * `agents/loading.tsx` carries the reasoning every one of these shares.
 */
export default function ConnectionLoading() {
  return (
    <ProductStatePage eyebrow="Connection" title="Connection">
      <Loading what="this connection" />
    </ProductStatePage>
  );
}
