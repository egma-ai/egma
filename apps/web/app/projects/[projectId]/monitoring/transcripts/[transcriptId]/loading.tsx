"use client";

import { useParams } from "next/navigation";

import { DETAIL, LIST } from "../../../../../../lib/transcript-copy.ts";
import { transcriptsPath } from "../../../../../../lib/transcripts.ts";
import { Loading } from "../../../../../../ui/page-state.tsx";
import { ProductStatePage } from "../../../../../../ui/shell.tsx";

/**
 * What the router draws between the press and
 * `/projects/:projectId/monitoring/transcripts/:transcriptId` arriving.
 *
 * The page's own wait once said a bare “Loading…”; that sentence is retired
 * everywhere now — its client branch draws this same frame — so the subject
 * is named here instead. The title and the crumbs are still the copy
 * module's.
 *
 * Its header is the page's own down to its shape — the same eyebrow or the
 * same crumbs, never one standing in for the other — so nothing is redrawn a
 * second way when the page arrives. `agents/loading.tsx` carries the
 * reasoning every one of these shares.
 */
export default function TranscriptLoading() {
  const { projectId } = useParams<{ projectId: string }>();

  return (
    <div data-slot="route-loading">
      <ProductStatePage
        title={DETAIL.title}
        breadcrumbs={[
          { label: LIST.title, href: transcriptsPath(projectId) },
          { label: DETAIL.title },
        ]}
      >
        <Loading what="this transcript" />
      </ProductStatePage>
    </div>
  );
}
