import { Loading } from "../../../../ui/page-state.tsx";
import { ProductStatePage } from "../../../../ui/shell.tsx";

/**
 * What the router draws between pressing **Agents** and this page arriving.
 *
 * **This file, and the two dozen beside it, exist because the transition had
 * no state at all.** Without a `loading.tsx` the App Router has nowhere to put
 * a pending route, so it holds the *previous* page on screen until the next
 * one is ready: press a navigation item on a slow connection and nothing
 * happens, for as long as it takes. That is the one state `DESIGN.md` will not
 * allow — "make every state truthful" — and it is also the state a person
 * reads as a broken application.
 *
 * The boundary earns its place twice over. `<Link>` prefetches a dynamic route
 * only as far as its nearest loading boundary, so adding one is also what lets
 * the router answer the press from cache.
 *
 * **The frame is here and the data is not, which is the whole point.** The
 * sidebar never moves — it belongs to `ProductShellBoundary` in the root
 * layout, above every route — and this adds the page's own header on top of
 * it, so a press is answered by arriving somewhere named rather than by a bare
 * indicator floating in an empty column. Every word is the page's own: the
 * eyebrow or breadcrumbs, the title and what is being waited for are copied
 * from the page this stands in for, **including the header's shape**, because
 * an eyebrow that becomes a breadcrumb row on arrival is a header that moves.
 *
 * What a fallback cannot carry is the page's toolbar, its controls, or a
 * second navigation column, none of which it can know before the page mounts.
 * So the header lands first and the rest fills in under it. That is
 * progressive arrival rather than a jump, and it is the honest limit of a
 * fallback that has not seen the data.
 *
 * The whole composition arrives as one thing, after a wait, and neither is
 * written here: `tailwind-theme.css` keys both to the `route-loading` slot
 * below.
 */
export default function AgentsLoading() {
  return (
    <div data-slot="route-loading">
      <ProductStatePage eyebrow="Project" title="Agents">
        <Loading what="agents" />
      </ProductStatePage>
    </div>
  );
}
