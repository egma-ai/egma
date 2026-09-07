"use client";

import { useParams } from "next/navigation";

import { projectPath } from "../../../../../lib/project-context.ts";
import { Loading } from "../../../../../ui/page-state.tsx";
import { ProductStatePage } from "../../../../../ui/shell.tsx";

/** Match the suite frame that contains the new-test entry row. */
export default function NewTestLoading() {
  const { projectId } = useParams<{ projectId: string }>();

  return (
    <div data-slot="route-loading">
      <ProductStatePage
        title="Test suite"
        breadcrumbs={[
          { label: "Tests", href: projectPath(projectId, "tests") },
          { label: "Test suite" },
        ]}
      >
        <Loading what="the test form" />
      </ProductStatePage>
    </div>
  );
}
