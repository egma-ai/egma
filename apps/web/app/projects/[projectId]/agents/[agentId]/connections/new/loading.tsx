import { Loading } from "../../../../../../../ui/page-state.tsx";
import { ProductStatePage } from "../../../../../../../ui/shell.tsx";

/**
 * What the router draws between the press and `/projects/:projectId/agents/:agentId/connections/new` arriving.
 *
 * The page titles itself **Connect the agent** when it is reached from
 * setup and **Add a connection** otherwise. A fallback cannot read a query
 * string, so it says the plain one: the wrong half of a choice is worse
 * than the general word.
 *
 * The words are the page's own and the shell above never moves.
 * `agents/loading.tsx` carries the reasoning every one of these shares.
 */
export default function NewConnectionLoading() {
  return (
    <ProductStatePage eyebrow="Connection" title="Add a connection">
      <Loading what="this agent" />
    </ProductStatePage>
  );
}
