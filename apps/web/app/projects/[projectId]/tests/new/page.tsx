"use client";

import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";

import { Button } from "@/components/ui/button";
import { testsPagePath } from "../../../../../lib/test-suites.ts";
import { Empty } from "../../../../../ui/page-state.tsx";
import {
  AppShell,
  PageBody,
  PageHeader,
  ProductPage,
} from "../../../../../ui/shell.tsx";
import { SuiteScreen } from "../suite-screen.tsx";

/**
 * Writing a test.
 *
 * **This route draws the suite with the write-a-test panel open over it**,
 * which is what `ATG-0` shows: the list a test is being added to stays on
 * screen behind the panel. It is still a route rather than a piece of state on
 * the suite page, so the address a person is sent, the Back button, and every
 * walk that opens `?suite=` directly all keep working.
 *
 * With no suite in the address there is nothing to write into, and the answer
 * is the same as it has always been: choose one first.
 */
export default function NewTestPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const suiteId = useSearchParams().get("suite");

  if (suiteId === null) {
    return (
      <AppShell>
        <ProductPage>
          <PageHeader title="Write a test" />
          <PageBody>
            <Empty
              title="Choose a test suite first"
              lead="Every test belongs to one suite for its full lifetime. Open a suite, then write the test there."
              action={
                <Button asChild variant="secondary">
                  <Link href={testsPagePath(projectId)}>Open test suites</Link>
                </Button>
              }
            />
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
