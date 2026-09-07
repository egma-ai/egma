import { Loading } from "../../../../ui/page-state.tsx";
import { ProductStatePage } from "../../../../ui/shell.tsx";

/**
 * What the router draws between the press and
 * `/projects/:projectId/settings` arriving.
 *
 * Settings also draws a second navigation column of its own, which arrives
 * with the page rather than with this, so the card moves once on arrival.
 * Drawing that column here would mean giving a fallback the settings
 * navigation's own state for the sake of one shift.
 *
 * Its header is the page's own down to its shape — the title bar carries the
 * page's name and nothing else, the way every settings page's does — so
 * nothing is redrawn a second way when the page arrives. `agents/loading.tsx`
 * carries the reasoning every one of these shares.
 */
export default function SettingsLoading() {
  return (
    <div data-slot="route-loading">
      <ProductStatePage title="Project">
        <Loading what="this project" />
      </ProductStatePage>
    </div>
  );
}
