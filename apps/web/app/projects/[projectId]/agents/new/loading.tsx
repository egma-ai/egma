import { Loading } from "../../../../../ui/page-state.tsx";
import { ProductStatePage } from "../../../../../ui/shell.tsx";

/**
 * What the router draws between the press and
 * `/projects/:projectId/agents/new` arriving.
 *
 * **It says Agents, because that is what arrives.** This address draws the
 * agents list with the connect panel over it, so a fallback headed "Register an
 * agent" would name a page that no longer exists and would be replaced by a
 * different title a moment later. A fallback cannot draw the panel — it has no
 * data and no session — so it draws the screen the panel opens over.
 *
 * `agents/loading.tsx` carries the reasoning every one of these shares.
 */
export default function NewAgentLoading() {
  return (
    <div data-slot="route-loading">
      <ProductStatePage title="Agents">
        <Loading what="agents" />
      </ProductStatePage>
    </div>
  );
}
