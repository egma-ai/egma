import { Loading } from "../../../../../../../ui/page-state.tsx";
import { ProductStatePage } from "../../../../../../../ui/shell.tsx";

/**
 * What the router draws between the press and
 * `/projects/:projectId/agents/:agentId/connections/:connectionId` arriving.
 *
 * **It says Agents, because that is what arrives.** This address draws the
 * agents list with the connection panel over it. The fallback cannot draw the
 * panel — the connection's name is in an answer that has not come back — so it
 * draws the screen underneath rather than a word that is replaced a moment
 * later.
 *
 * `agents/loading.tsx` carries the reasoning every one of these shares.
 */
export default function ConnectionLoading() {
  return (
    <div data-slot="route-loading">
      <ProductStatePage title="Agents">
        <Loading what="agents" />
      </ProductStatePage>
    </div>
  );
}
