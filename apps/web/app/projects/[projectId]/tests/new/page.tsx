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
 * Writing a test, which is the suite's grid with its entry row already open.
 *
 * **The write-a-test sheet is retired.** A test is written in the grid's entry
 * row now, so this address draws the suite the address names and opens that
 * row — the same screen the suite's own address draws, one row further on. It
 * stays a real address because links to it were copied while the sheet existed.
 *
 * With no suite in the address there is nothing to write into, and the answer
 * is the suites screen: every test belongs to one suite for its whole life, so
 * choosing the suite is the first thing that has to happen.
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
