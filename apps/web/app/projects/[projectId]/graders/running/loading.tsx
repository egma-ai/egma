"use client";

import { useParams } from "next/navigation";

import { RUNNING } from "../../../../../lib/grader-running-copy.ts";
import { GRADERS_SECTION } from "../../../../../lib/graders.ts";
import { projectPath } from "../../../../../lib/project-context.ts";
import { Loading } from "../../../../../ui/page-state.tsx";
import { ProductStatePage } from "../../../../../ui/shell.tsx";

/**
 * What the router draws between the press and
 * `/projects/:projectId/graders/running` arriving.
 *
 * The graders tab strip is a page rather than a tab panel, so moving between
 * **Library** and **Running** is a route change and needs its own boundary to
 * stay instant. Every word here is read from the same modules the page reads.
 *
 * Its header is the page's own down to its shape — the same eyebrow or the
 * same crumbs, never one standing in for the other — so nothing is redrawn a
 * second way when the page arrives. `agents/loading.tsx` carries the
 * reasoning every one of these shares.
 */
export default function RunningGradersLoading() {
  const { projectId } = useParams<{ projectId: string }>();

  return (
    <div data-slot="route-loading">
      <ProductStatePage
        title={RUNNING.title}
        breadcrumbs={[
          { label: "Graders", href: projectPath(projectId, GRADERS_SECTION) },
          { label: RUNNING.title },
        ]}
      >
        <Loading what={RUNNING.loading} />
      </ProductStatePage>
    </div>
  );
}
