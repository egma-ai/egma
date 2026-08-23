"use client";

import { useParams } from "next/navigation";

import { projectPath } from "../../../../../lib/project-context.ts";
import { trailInto } from "../../../../../lib/test-suites.ts";
import { Loading } from "../../../../../ui/page-state.tsx";
import { ProductStatePage } from "../../../../../ui/shell.tsx";

/**
 * What the router draws between the press and
 * `/projects/:projectId/tests/new` arriving.
 *
 * Its own boundary rather than the list's, for the same reason the new agent
 * form has one: **Write a test** must not be answered with “Loading tests…”.
 *
 * **What arrives is the suite with the write-a-test panel over it**, so the
 * fallback wears the suite's shape rather than a page title of its own: the
 * same trail, the same bar, nothing redrawn a second way on arrival.
 * `agents/loading.tsx` carries the reasoning every one of these shares.
 */
export default function NewTestLoading() {
  const { projectId } = useParams<{ projectId: string }>();

  return (
    <div data-slot="route-loading">
      <ProductStatePage
        title="Test suite"
        breadcrumbs={trailInto({
          label: "Tests",
          href: projectPath(projectId, "tests"),
        })}
      >
        <Loading what="the test form" />
      </ProductStatePage>
    </div>
  );
}
