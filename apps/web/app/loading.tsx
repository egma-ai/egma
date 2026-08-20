import { ProductStatePage } from "../ui/shell.tsx";

/**
 * What the router draws between the press and
 * `/` arriving.
 *
 * **No indicator, deliberately.** The entrance's own waiting state is this
 * header and nothing under it, so a fallback that added a card would put one
 * on screen for the length of the route change and take it away again the
 * moment the page mounted — the shape-change every other file here exists to
 * remove. What the boundary buys is that the entrance paints at once instead
 * of the previous page being held.
 *
 * Its header is the page's own down to its shape — the same eyebrow or the
 * same crumbs, never one standing in for the other — so nothing is redrawn a
 * second way when the page arrives. `agents/loading.tsx` carries the
 * reasoning every one of these shares.
 */
export default function EntranceLoading() {
  return (
    <div data-slot="route-loading">
      <ProductStatePage title="Opening Egma" lead="Checking your session." />
    </div>
  );
}
