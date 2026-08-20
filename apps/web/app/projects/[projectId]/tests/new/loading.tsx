"use client";

import { useParams } from "next/navigation";

import { projectPath } from "../../../../../lib/project-context.ts";
import { Loading } from "../../../../../ui/page-state.tsx";
import { ProductStatePage } from "../../../../../ui/shell.tsx";

/**
 * What the router draws between the press and
 * `/projects/:projectId/tests/new` arriving.
 *
 * Its own boundary rather than the list's, for the same reason the new agent
 * form has one: **Write a test** must not be answered with “Loading tests…”.
 *
 * Its header is the page's own down to its shape — the same eyebrow or the
 * same crumbs, never one standing in for the other — so nothing is redrawn a
 * second way when the page arrives. `agents/loading.tsx` carries the
 * reasoning every one of these shares.
 */
export default function NewTestLoading() {
  const { projectId } = useParams<{ projectId: string }>();

  return (
    <div data-slot="route-loading">
      <ProductStatePage
        title="Write a test"
        breadcrumbs={[
          { label: "Tests", href: projectPath(projectId, "tests") },
          { label: "New test" },
        ]}
      >
        <Loading what="the test form" />
      </ProductStatePage>
    </div>
  );
}
