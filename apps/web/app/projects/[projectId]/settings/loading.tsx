import { Loading } from "../../../../ui/page-state.tsx";
import { ProductStatePage } from "../../../../ui/shell.tsx";

/**
 * What the router draws between the press and `/projects/:projectId/settings` arriving.
 *
 * Settings draws a second navigation column of its own, which arrives with
 * the page rather than with this. The card therefore moves once, on arrival.
 * Drawing that column here would mean reading the project out of the
 * address in a fallback, which is a client component and a slower boundary
 * for the sake of one shift.
 *
 * The words are the page's own and the shell above never moves.
 * `agents/loading.tsx` carries the reasoning every one of these shares.
 */
export default function SettingsLoading() {
  return (
    <ProductStatePage eyebrow="Settings" title="Project">
      <Loading what="this project" />
    </ProductStatePage>
  );
}
