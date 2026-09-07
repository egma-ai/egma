import { Loading } from "../../../../../ui/page-state.tsx";
import { ProductStatePage } from "../../../../../ui/shell.tsx";

/**
 * What the router draws between the press and
 * `/projects/:projectId/settings/organization` arriving.
 *
 * Its own boundary, so moving between settings views stays instant.
 *
 * Its header is the page's own down to its shape — the title bar carries the
 * page's name and nothing else, and the settings rail beside the page is the
 * trail into it — so nothing is redrawn a second way when the page arrives.
 * `agents/loading.tsx` carries the reasoning every one of these shares.
 */
export default function OrganizationSettingsLoading() {
  return (
    <div data-slot="route-loading">
      <ProductStatePage title="Organization">
        <Loading what="this organization" />
      </ProductStatePage>
    </div>
  );
}
