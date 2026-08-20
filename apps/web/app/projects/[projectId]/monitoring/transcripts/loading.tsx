import { LIST } from "../../../../../lib/transcript-copy.ts";
import { Loading } from "../../../../../ui/page-state.tsx";
import { ProductStatePage } from "../../../../../ui/shell.tsx";

/**
 * What the router draws between the press and `/projects/:projectId/monitoring/transcripts` arriving.
 *
 * Monitoring reads production traffic over a time window, so it is slow
 * by nature and the sidebar points straight here rather than at the
 * forwarding address above it.
 *
 * The words are the page's own and the shell above never moves.
 * `agents/loading.tsx` carries the reasoning every one of these shares.
 */
export default function TranscriptsLoading() {
  return (
    <ProductStatePage eyebrow={LIST.eyebrow} title={LIST.title}>
      <Loading what={LIST.loadingWhat} />
    </ProductStatePage>
  );
}
