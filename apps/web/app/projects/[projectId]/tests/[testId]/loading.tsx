"use client";

import { useParams } from "next/navigation";

import { projectPath } from "../../../../../lib/project-context.ts";
import { Loading } from "../../../../../ui/page-state.tsx";
import { ProductStatePage } from "../../../../../ui/shell.tsx";

/** Match the test detail header and breadcrumbs while the route loads. */
export default function TestLoading() {
  const { projectId } = useParams<{ projectId: string }>();

  return (
    <div data-slot="route-loading">
      <ProductStatePage
        title="Test"
        breadcrumbs={[
          { label: "Tests", href: projectPath(projectId, "tests") },
          { label: "Test" },
        ]}
      >
        <Loading what="this test" />
      </ProductStatePage>
    </div>
  );
}
