"use client";

import { useParams } from "next/navigation";

import { DETAIL, LIST } from "../../../../../../lib/transcript-copy.ts";
import { transcriptsPath } from "../../../../../../lib/transcripts.ts";
import { Loading } from "../../../../../../ui/page-state.tsx";
import { ProductStatePage } from "../../../../../../ui/shell.tsx";

/** Match the transcript page's waiting header and breadcrumbs using shared copy. */
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
