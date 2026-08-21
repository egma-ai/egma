"use client";

import { useParams } from "next/navigation";

import { projectPath } from "../../../../../../lib/project-context.ts";
import { Loading } from "../../../../../../ui/page-state.tsx";
import { ProductStatePage } from "../../../../../../ui/shell.tsx";

/** The suite route keeps its parent trail while its name and tests load. */
export default function TestSuiteLoading() {
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
        <Loading what="this test suite" />
      </ProductStatePage>
    </div>
  );
}
