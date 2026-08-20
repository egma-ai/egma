import { Loading } from "../../../../../ui/page-state.tsx";
import { ProductStatePage } from "../../../../../ui/shell.tsx";

/**
 * What the router draws between the press and `/projects/:projectId/settings/organization` arriving.
 *
 * Its own boundary, so moving between settings views stays instant.
 *
 * The words are the page's own and the shell above never moves.
 * `agents/loading.tsx` carries the reasoning every one of these shares.
 */
export default function OrganizationSettingsLoading() {
  return (
    <ProductStatePage eyebrow="Settings" title="Organization">
      <Loading what="this organization" />
    </ProductStatePage>
  );
}
