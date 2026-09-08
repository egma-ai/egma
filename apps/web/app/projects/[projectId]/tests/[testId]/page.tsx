"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect } from "react";
import { getTest } from "@egma/platform-api/client";

import {
  platformAnswer,
  platformClient,
} from "../../../../../lib/platform-client.ts";
import { suitePagePath, testsPagePath } from "../../../../../lib/test-suites.ts";
import type { ListedTest } from "../../../../../lib/tests.ts";
import { Failure, Loading, NotFound } from "../../../../../ui/page-state.tsx";
import { useProjectRead } from "../../../../../ui/resource.ts";
import {
  AppShell,
  PageBody,
  PageHeader,
  ProductPage,
} from "../../../../../ui/shell.tsx";

/**
 * Resolve a direct test link to its owning suite, where tests are read and
 * edited in the grid.
 */
export default function TestPage() {
  const { projectId, testId } = useParams<{ projectId: string; testId: string }>();
  return (
    <AppShell>
      <ToItsSuite projectId={projectId} testId={testId} />
    </AppShell>
  );
}

function ToItsSuite({
  projectId,
  testId,
}: {
  readonly projectId: string;
  readonly testId: string;
}) {
  const router = useRouter();
  const { answer, reload } = useProjectRead<ListedTest>(
    (projectId) =>
      platformAnswer(getTest({ testId, projectId }, { client: platformClient })),
    projectId,
    testId,
  );

  useEffect(() => {
    if (answer?.status === "signed-out") window.location.replace("/sign-in");
  }, [answer]);

  const suiteId = answer?.status === "ready" ? answer.value.suiteId : null;
  useEffect(() => {
    if (suiteId === null) return;
    router.replace(suitePagePath(projectId, suiteId));
  }, [router, projectId, suiteId]);

  function body() {
    if (answer === null || answer.status === "signed-out" || answer.status === "ready") {
      return <Loading what="this test's suite" />;
    }
    if (answer.status === "missing") return <NotFound message={answer.refusal.message} />;
    return <Failure message={answer.refusal.message} onRetry={reload} />;
  }

  return (
    <ProductPage>
      <PageHeader
        title="Test"
        breadcrumbs={[
          { label: "Tests", href: testsPagePath(projectId) },
          { label: "Test" },
        ]}
      />
      <PageBody>{body()}</PageBody>
    </ProductPage>
  );
}
