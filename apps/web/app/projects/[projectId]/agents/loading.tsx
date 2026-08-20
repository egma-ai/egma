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
 * layout, above every route — and this adds the page's own title on top of it,
 * so a press is answered by arriving somewhere named rather than by a bare
 * indicator floating in an empty column. The words are the page's own: the
 * eyebrow, the title and what is being waited for are copied from
 * `agents/page.tsx`, so the fallback and the page it stands in for cannot
 * disagree about where somebody is.
 *
 * What it deliberately does not carry is the page's toolbar and controls,
 * which it cannot know before the page mounts. So the header lands first and
 * the rest fills in under it. That is progressive arrival rather than a jump,
 * and it is the honest limit of a fallback that has not seen the data.
 */
export default function AgentsLoading() {
  return (
    <ProductStatePage eyebrow="Project" title="Agents">
      <Loading what="agents" />
    </ProductStatePage>
  );
}
