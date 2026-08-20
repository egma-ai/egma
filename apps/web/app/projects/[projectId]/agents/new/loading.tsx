import { Loading } from "../../../../../ui/page-state.tsx";
import { ProductStatePage } from "../../../../../ui/shell.tsx";

/**
 * What the router draws between the press and `/projects/:projectId/agents/new` arriving.
 *
 * This page reads nothing of its own — it is an empty form — and it still
 * needs a boundary. Without one it would inherit the list's, and somebody
 * pressing **Register an agent** would be told egma was loading agents.
 *
 * The words are the page's own and the shell above never moves.
 * `agents/loading.tsx` carries the reasoning every one of these shares.
 */
export default function NewAgentLoading() {
  return (
    <ProductStatePage eyebrow="Agents" title="Register an agent">
      <Loading what="the agent form" />
    </ProductStatePage>
  );
}
