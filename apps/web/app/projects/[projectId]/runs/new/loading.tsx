import { Loading } from "../../../../../ui/page-state.tsx";
import { ProductStatePage } from "../../../../../ui/shell.tsx";

/**
 * What the router draws between the press and `/projects/:projectId/runs/new` arriving.
 *
 * Planning a run starts by choosing an agent, so the agents are what this
 * page is genuinely waiting for, and it says so.
 *
 * The words are the page's own and the shell above never moves.
 * `agents/loading.tsx` carries the reasoning every one of these shares.
 */
export default function NewRunLoading() {
  return (
    <ProductStatePage eyebrow="Simulation runs" title="Create a run">
      <Loading what="the agents in this project" />
    </ProductStatePage>
  );
}
