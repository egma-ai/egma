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
 * The old test address, which is a deep link now and nothing else.
 *
 * **The test full page is retired.** A test is read and edited in its suite's
 * grid, beside every other test of that suite, so this address has one job
 * left: work out which suite the test belongs to and land there. That is a
 * navigation to a page rather than a panel opening, so a redirect is the honest
 * shape — the blanket "a panel never navigates" rule is about panels.
 *
 * The address survives because links to it were copied, pasted and bookmarked
 * while the page existed, and a link that used to answer must keep answering.
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
