"use client";

import { CheckIcon } from "lucide-react";
import Link from "next/link";
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
  runSuitePath,
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

/** How long the word `Saved` stands before it goes, in milliseconds. */
const SAVED_FOR = 1500;

/**
 * Show a brief Saved message after successful grid commits, since autosave
 * has no button state to acknowledge completion. Keep routine saves unanimated;
 * refusals remain in the cell or dialog where they occurred.
 */
function SaveIndicator({ save }: { readonly save: number }) {
  const [showing, setShowing] = useState(false);
  /*
   * Keyed on the count, so a save while the word is up restarts the wait
   * rather than stacking a second one behind it: the cleanup clears the timer
   * standing and the new one starts from now.
   */
  useEffect(() => {
    if (save === 0) {
      setShowing(false);
      return undefined;
    }
    setShowing(true);
    const timer = window.setTimeout(() => setShowing(false), SAVED_FOR);
    return () => window.clearTimeout(timer);
  }, [save]);

  if (!showing) return null;
  return (
    <span
      className="flex items-center gap-1 text-sm text-muted-foreground"
      data-slot="save-indicator"
      role="status"
    >
      <CheckIcon className="size-4" aria-hidden="true" strokeWidth={1.75} />
      Saved
    </span>
  );
}

/**
 * Display one suite's editable test grid. /tests/new?suite= opens the entry
 * row on this screen. Run suite opens the run builder; suite rename and delete
 * remain on the suites list.
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
  /** Rows that left, so a delete does not wait on a re-read of the page. */
  const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set());
  const [shownSuite, setShownSuite] = useState<TestSuite | null>(null);
  /**
   * Count successful saves to restart the indicator even when two occur within
   * one millisecond. Cell/dialog saves and entry-row creation share this signal.
   */
  const [saves, setSaves] = useState(0);
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
    setRemoved(new Set());
    setMoreRefused(null);
    setShownSuite(null);
    setSearch("");
    // A save on the suite just left is not a fact about the one arriving.
    setSaves(0);
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
    ]
      .filter((test) => !removed.has(test.id))
      .map((test) => edited.get(test.id) ?? test);
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
          onCreated={(test) => {
            setWritten((held) => [...held, test]);
            setSaves((held) => held + 1);
          }}
          onSaved={(test) => {
            setEdited((held) => new Map(held).set(test.id, test));
            setSaves((held) => held + 1);
          }}
          onDeleted={(test) =>
            setRemoved((held) => new Set(held).add(test.id))
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
        action={
          <>
            {/*
              Beside Run suite rather than over the grid: the toolbar's action
              slot is already a right-aligned row with the strip's own gap, so
              the word arrives where a person's eye goes for this page's
              controls and nothing in the table moves to make room for it.
            */}
            <SaveIndicator save={saves} />
            <Button asChild>
              <Link href={runSuitePath(projectId, suiteId)}>Run suite</Link>
            </Button>
          </>
        }
      />
      <PageBody>{body()}</PageBody>
    </ProductPage>
  );
}
