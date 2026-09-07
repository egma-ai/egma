import { StatePage } from "../ui.tsx";

/**
 * What the router draws between the press and
 * `/invite` arriving.
 *
 * **This one is not a product page and must not borrow the product's frame.**
 * An invitation is opened by somebody who is not signed in yet, so the page
 * behind this boundary composes the access surface — `AuthShell` through
 * `StatePage` — and never `ProductStatePage`, which would draw an organization
 * switcher and product navigation for a person who has neither. The fallback
 * follows the page it stands in for.
 *
 * **No indicator, deliberately.** The page's own waiting state is this exact
 * header and nothing under it, so adding a card here would put one on screen
 * for the length of the route change and take it away the moment the page
 * mounted. Same words, same shape, nothing added that the page then removes.
 *
 * **Its reach is honestly small.** An invitation link is followed from an
 * email, which is a cold document load rather than a route change, and this
 * page reads nothing on the server — so nothing streams and this boundary
 * usually never renders. It is here because the route can also be reached from
 * inside the application, and because a data-fetching segment without a
 * boundary is a hole whether or not it is a common one.
 */
export default function InviteLoading() {
  return (
    <div data-slot="route-loading">
      <StatePage
        title="Loading invitation"
        lead="Checking the invitation link."
      />
    </div>
  );
}
