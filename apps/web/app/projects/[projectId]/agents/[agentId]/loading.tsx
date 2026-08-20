import { Loading } from "../../../../../ui/page-state.tsx";
import { ProductStatePage } from "../../../../../ui/shell.tsx";

/**
 * What the router draws between the press and `/projects/:projectId/agents/:agentId` arriving.
 *
 * The title is the word rather than the agent's name, because the name is
 * in the answer that has not arrived. The page says the same word in its own
 * loading branch, so nothing is renamed twice on the way in.
 *
 * The words are the page's own and the shell above never moves.
 * `agents/loading.tsx` carries the reasoning every one of these shares.
 */
export default function AgentLoading() {
  return (
    <ProductStatePage eyebrow="Agent" title="Agent">
      <Loading what="this agent" />
    </ProductStatePage>
  );
}
