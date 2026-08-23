"use client";

import { useParams } from "next/navigation";

import { projectPath } from "../../../../../lib/project-context.ts";
import { trailInto } from "../../../../../lib/test-suites.ts";
import { Loading } from "../../../../../ui/page-state.tsx";
import { ProductStatePage } from "../../../../../ui/shell.tsx";

/**
 * What the router draws between the press and
 * `/projects/:projectId/tests/:testId` arriving.
 *
 * Reached by pressing a row, where the press has to be answered at once or
 * it reads as a row that does not open.
 *
 * Its header is the page's own down to its shape — the same eyebrow or the
 * same crumbs, never one standing in for the other — so nothing is redrawn a
 * second way when the page arrives. `agents/loading.tsx` carries the
 * reasoning every one of these shares.
 */
export default function TestLoading() {
  const { projectId } = useParams<{ projectId: string }>();

  return (
    <div data-slot="route-loading">
      <ProductStatePage
        title="Test"
        breadcrumbs={trailInto({
          label: "Tests",
          href: projectPath(projectId, "tests"),
        })}
      >
        <Loading what="this test" />
      </ProductStatePage>
    </div>
  );
}
