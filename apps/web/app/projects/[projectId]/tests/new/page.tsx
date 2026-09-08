"use client";

import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useEffect } from "react";

import { testsPagePath } from "../../../../../lib/test-suites.ts";
import { Loading } from "../../../../../ui/page-state.tsx";
import {
  AppShell,
  PageBody,
  PageHeader,
  ProductPage,
} from "../../../../../ui/shell.tsx";
import { SuiteScreen } from "../suite-screen.tsx";

/**
 * Open the named suite with its new-test entry row active. Without a suite
 * parameter, show the suites screen so the user can choose where to write.
 */
export default function NewTestPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const router = useRouter();
  const suiteId = useSearchParams().get("suite");

  useEffect(() => {
    if (suiteId === null) router.replace(testsPagePath(projectId));
  }, [router, projectId, suiteId]);

  if (suiteId === null) {
    return (
      <AppShell>
        <ProductPage>
          <PageHeader title="Tests" />
          <PageBody>
            <Loading what="test suites" />
          </PageBody>
        </ProductPage>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <SuiteScreen projectId={projectId} suiteId={suiteId} writing />
    </AppShell>
  );
}
