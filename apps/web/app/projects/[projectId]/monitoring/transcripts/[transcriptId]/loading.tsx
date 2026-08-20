import { DETAIL } from "../../../../../../lib/transcript-copy.ts";
import { Loading } from "../../../../../../ui/page-state.tsx";
import { ProductStatePage } from "../../../../../../ui/shell.tsx";

/**
 * What the router draws between the press and `/projects/:projectId/monitoring/transcripts/:transcriptId` arriving.
 *
 * `DETAIL.loading` is the string “Loading…”, which is the sentence this
 * component exists to replace, so the subject is named here instead. The
 * title is still the copy module's.
 *
 * The words are the page's own and the shell above never moves.
 * `agents/loading.tsx` carries the reasoning every one of these shares.
 */
export default function TranscriptLoading() {
  return (
    <ProductStatePage title={DETAIL.title}>
      <Loading what="this transcript" />
    </ProductStatePage>
  );
}
