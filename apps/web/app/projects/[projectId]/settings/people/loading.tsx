import { Loading } from "../../../../../ui/page-state.tsx";
import { ProductStatePage } from "../../../../../ui/shell.tsx";

/**
 * What the router draws between the press and `/projects/:projectId/settings/people` arriving.
 *
 * People and invitations are two reads on one page; this names the first,
 * which is the one that decides whether the page can be drawn at all.
 *
 * The words are the page's own and the shell above never moves.
 * `agents/loading.tsx` carries the reasoning every one of these shares.
 */
export default function PeopleSettingsLoading() {
  return (
    <ProductStatePage eyebrow="Settings" title="People">
      <Loading what="this organization's people" />
    </ProductStatePage>
  );
}
