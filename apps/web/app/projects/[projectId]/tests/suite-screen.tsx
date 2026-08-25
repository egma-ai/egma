"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { getTestSuite, listTests } from "@egma/platform-api/client";

import { Button } from "@/components/ui/button";
import type { Refusal } from "../../../../lib/api.ts";
import { roleOf } from "../../../../lib/me.ts";
import {
  platformAnswer,
  platformClient,
} from "../../../../lib/platform-client.ts";
import { canAuthor } from "../../../../lib/roles.ts";
import {
  matchesSearch,
  suitePagePath,
  testsPagePath,
  type TestSuite,
} from "../../../../lib/test-suites.ts";
import type { ListedTest, TestPage } from "../../../../lib/tests.ts";
import { Failure, Loading, NotFound } from "../../../../ui/page-state.tsx";
import { useProjectRead } from "../../../../ui/resource.ts";
import { SearchField } from "../../../../ui/section.tsx";
import {
  PageBody,
  PageHeader,
  ProductPage,
  useShellSession,
} from "../../../../ui/shell.tsx";
import { TestsGrid } from "./tests-grid.tsx";

/**
 * One suite, and the tests inside it, as a spreadsheet grid.
 *
 * **Two addresses draw this screen.** `/tests/suites/:suiteId` is the suite
 * itself, and `/tests/new?suite=:suiteId` is the same suite with the entry row
 * already open — the old write-a-test address, kept as a deep link now that the
 * side sheet it used to open is retired.
 *
 * **Suite management is not here.** Rename, Run suite and Delete suite live on
 * the suites list's row menu, where one screen owns every verb a suite has
 * (founder's ruling, 2026-08-24). What this screen carries is one action —
 * Write a test — and it puts the caret in the grid's entry row rather than
 * opening anything.
 */
export function SuiteScreen({
  projectId,
  suiteId,
  writing = false,
}: {
  readonly projectId: string;
  readonly suiteId: string;
  /** The entry row is open, because the address says so. */
  readonly writing?: boolean;
}) {
  const router = useRouter();
  const { me } = useShellSession();
  const role = me === null ? null : roleOf(me);
  const mayAuthor = role !== null && canAuthor(role);
  const { answer: suite, reload: reloadSuite } = useProjectRead<TestSuite>(
    (projectId) =>
      platformAnswer(
        getTestSuite({ suiteId, projectId }, { client: platformClient }),
      ),
    projectId,
    suiteId,
  );
  const { answer: tests, reload: reloadTests } = useProjectRead<TestPage>(
    (projectId) =>
      platformAnswer(
        listTests({ suiteId, projectId }, { client: platformClient }),
      ),
    projectId,
    suiteId,
  );
  const [after, setAfter] = useState<TestPage | null>(null);
  const [written, setWritten] = useState<readonly ListedTest[]>([]);
  const [edited, setEdited] = useState<ReadonlyMap<string, ListedTest>>(new Map());
  const [shownSuite, setShownSuite] = useState<TestSuite | null>(null);
  const [search, setSearch] = useState("");
  const [entryOpen, setEntryOpen] = useState(writing);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreRefused, setMoreRefused] = useState<Refusal | null>(null);
  const showing = useRef(`${projectId}:${suiteId}`);

  useEffect(() => {
    showing.current = `${projectId}:${suiteId}`;
    setAfter(null);
    setWritten([]);
    setEdited(new Map());
    setMoreRefused(null);
    setShownSuite(null);
    setSearch("");
  }, [projectId, suiteId]);

  useEffect(() => {
    if (writing) setEntryOpen(true);
  }, [writing]);

  useEffect(() => {
    if (suite?.status === "ready") setShownSuite(suite.value);
  }, [suite]);

  useEffect(() => {
    if (suite?.status === "signed-out" || tests?.status === "signed-out") {
      window.location.replace("/sign-in");
    }
  }, [suite, tests]);

  const currentSuite =
    shownSuite !== null && shownSuite.id === suiteId
      ? shownSuite
      : suite?.status === "ready"
        ? suite.value
        : null;
  const title = currentSuite?.name ?? "Test suite";

  const whyNotWrite =
    mayAuthor || role === null
      ? undefined
      : `Your ${String(role)} role cannot write tests. Ask an organization admin to change your role.`;

  /**
   * "Write a test" focuses the grid's entry row; it opens nothing.
   *
   * The address stays where it is when the row opens from this button. The
   * `/tests/new?suite=` address still lands with the row open, which is what
   * keeps a copied link honest — but pressing the button is not a navigation.
   */
  const writeAction =
    role === null ? undefined : (
      <Button
        type="button"
        disabled={!mayAuthor}
        {...(whyNotWrite === undefined ? {} : { why: whyNotWrite })}
        onClick={() => setEntryOpen(true)}
      >
        Write a test
      </Button>
    );

  function body() {
    if (
      suite === null ||
      tests === null ||
      suite.status === "signed-out" ||
      tests.status === "signed-out"
    ) {
      return <Loading what="test suite" />;
    }
    if (suite.status === "missing") return <NotFound message={suite.refusal.message} />;
    if (suite.status === "failed") {
      return <Failure message={suite.refusal.message} onRetry={reloadSuite} />;
    }
    if (tests.status === "missing") return <NotFound message={tests.refusal.message} />;
    if (tests.status === "failed") {
      return <Failure message={tests.refusal.message} onRetry={reloadTests} />;
    }

    const loaded = [
      ...tests.value.tests,
      ...(after?.tests ?? []),
      ...written,
    ].map((test) => edited.get(test.id) ?? test);
    const cursor = after?.nextPageToken ?? tests.value.nextPageToken;
    const items = loaded.filter((test) => matchesSearch(test.name, search));

    async function showMore(): Promise<void> {
      if (cursor === null) return;
      setLoadingMore(true);
      setMoreRefused(null);
      const next = await platformAnswer(
        listTests(
          { suiteId, projectId, pageToken: cursor },
          { client: platformClient },
        ),
      );
      setLoadingMore(false);
      if (showing.current !== `${projectId}:${suiteId}`) return;
      if (next.status === "signed-out") {
        window.location.replace("/sign-in");
        return;
      }
      if (next.status !== "ready") {
        setMoreRefused(next.refusal);
        return;
      }
      setAfter({
        tests: [...(after?.tests ?? []), ...next.value.tests],
        nextPageToken: next.value.nextPageToken,
      });
    }

    return (
      <>
        <TestsGrid
          projectId={projectId}
          suiteId={suiteId}
          tests={items}
          mayAuthor={mayAuthor}
          {...(whyNotWrite === undefined ? {} : { why: whyNotWrite })}
          writing={entryOpen}
          onWriting={(open) => {
            setEntryOpen(open);
            /*
             * Closing the entry row that the `/tests/new?suite=` address opened
             * puts the address back on the suite, so Back and a copied link
             * keep saying the same thing the screen does.
             */
            if (!open && writing) router.push(suitePagePath(projectId, suiteId));
          }}
          onCreated={(test) => setWritten((held) => [...held, test])}
          onSaved={(test) =>
            setEdited((held) => new Map(held).set(test.id, test))
          }
          more={
            cursor === null ? undefined : (
              <div className="mt-3 flex items-center gap-3">
                <Button
                  type="button"
                  variant="secondary"
                  busy={loadingMore}
                  onClick={() => void showMore()}
                >
                  {loadingMore ? "Loading…" : "Show more"}
                </Button>
                <span className="text-sm text-muted-foreground">
                  {String(items.length)} tests so far
                </span>
              </div>
            )
          }
        />
        {moreRefused === null ? null : (
          <Failure
            title="Egma could not load more tests."
            message={moreRefused.message}
            onRetry={() => void showMore()}
          />
        )}
      </>
    );
  }

  return (
    <ProductPage>
      <PageHeader
        title={title}
        breadcrumbs={[
          { label: "Tests", href: testsPagePath(projectId) },
          { label: title },
        ]}
        toolbar={
          <SearchField
            aria-label="Search tests"
            placeholder="Search tests"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        }
        action={currentSuite === null ? undefined : writeAction}
      />
      <PageBody>{body()}</PageBody>
    </ProductPage>
  );
}
