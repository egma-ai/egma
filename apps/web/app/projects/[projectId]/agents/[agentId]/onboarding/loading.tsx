import { Loading } from "../../../../../../ui/page-state.tsx";
import { ProductStatePage } from "../../../../../../ui/shell.tsx";

/**
 * What the router draws between the press and `/projects/:projectId/agents/:agentId/onboarding` arriving.
 *
 * Setup is a sequence somebody is walked through, so the step's own title
 * lands immediately and only the agent it is about is waited for.
 *
 * The words are the page's own and the shell above never moves.
 * `agents/loading.tsx` carries the reasoning every one of these shares.
 */
export default function AgentOnboardingLoading() {
  return (
    <ProductStatePage eyebrow="Agent setup" title="Attach tests">
      <Loading what="this agent" />
    </ProductStatePage>
  );
}
