import { LIST } from "../../../../../lib/transcript-copy.ts";
import { Loading } from "../../../../../ui/page-state.tsx";
import { ProductStatePage } from "../../../../../ui/shell.tsx";

/**
 * What the router draws between the press and
 * `/projects/:projectId/monitoring/transcripts` arriving.
 *
 * Monitoring reads production traffic over a time window, so it is slow by
 * nature and the sidebar points straight here rather than at the forwarding
 * address above it.
 *
 * Its header is the page's own down to its shape — the same eyebrow or the
 * same crumbs, never one standing in for the other — so nothing is redrawn a
 * second way when the page arrives. `agents/loading.tsx` carries the
 * reasoning every one of these shares. The list screen carries no label above
 * its title now, so neither does this.
 */
export default function TranscriptsLoading() {
  return (
    <div data-slot="route-loading">
      <ProductStatePage title={LIST.title}>
        <Loading what={LIST.loadingWhat} />
      </ProductStatePage>
    </div>
  );
}
