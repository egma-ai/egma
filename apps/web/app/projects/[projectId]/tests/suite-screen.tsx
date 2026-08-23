"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  deleteTest,
  deleteTestSuite,
  getTestSuite,
  listTests,
} from "@egma/platform-api/client";

import { Badge } from "@/components/ui/badge";
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
  newTestInSuitePath,
  runSuitePath,
  suitePagePath,
  testsPagePath,
  trailInto,
  type TestSuite,
} from "../../../../lib/test-suites.ts";
import {
  personaCell,
  personaPagePath,
  testPagePath,
  type ListedTest,
  type TestPage,
} from "../../../../lib/tests.ts";
import { DataTable, type Column } from "../../../../ui/data-table.tsx";
import { MenuDivider, MenuItem } from "../../../../ui/menu.tsx";
import { Empty, Failure, Loading, NotFound } from "../../../../ui/page-state.tsx";
import { ListInstant } from "../../../../ui/relative-time.tsx";
import { useProjectRead } from "../../../../ui/resource.ts";
import { SearchField } from "../../../../ui/section.tsx";
import {
  PageBody,
  PageHeader,
  ProductPage,
  useShellSession,
} from "../../../../ui/shell.tsx";
import {
  ConfirmDialog,
  DestructiveItem,
  MenuReason,
  RowMenu,
  ToolbarMenu,
} from "./parts.tsx";
import { RenameSuiteSheet } from "./suite-sheets.tsx";
import { WriteTestSheet } from "./write-test-sheet.tsx";

/**
 * One suite, and the tests inside it.
 *
 * **Two addresses draw this screen.** `/tests/suites/:suiteId` is the suite
 * itself, and `/tests/new?suite=:suiteId` is the same suite with the
 * write-a-test panel open over it — which is what `ATG-0` draws. Writing a test
 * is a panel rather than a page now, and the address stays a real address so
 * the link, the Back button and the browser walk all keep working.
 */
export function SuiteScreen({
  projectId,
  suiteId,
  writing = false,
}: {
  readonly projectId: string;
  readonly suiteId: string;
  /** The write-a-test panel is open, because the address says so. */
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
  const [shownSuite, setShownSuite] = useState<TestSuite | null>(null);
  const [search, setSearch] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [deletingSuite, setDeletingSuite] = useState(false);
  const [deletingTest, setDeletingTest] = useState<ListedTest | null>(null);
  const [removing, setRemoving] = useState(false);
  const [removeRefused, setRemoveRefused] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreRefused, setMoreRefused] = useState<Refusal | null>(null);
  const showing = useRef(`${projectId}:${suiteId}`);

  useEffect(() => {
    showing.current = `${projectId}:${suiteId}`;
    setAfter(null);
    setMoreRefused(null);
    setShownSuite(null);
    setSearch("");
    setRenaming(false);
    setDeletingSuite(false);
    setDeletingTest(null);
    setCopied(false);
  }, [projectId, suiteId]);

  useEffect(() => {
    if (suite?.status === "ready") setShownSuite(suite.value);
  }, [suite]);

  useEffect(() => {
    if (suite?.status === "signed-out" || tests?.status === "signed-out") {
      window.location.replace("/sign-in");
    }
  }, [suite, tests]);

  useEffect(() => {
    if (!copied) return undefined;
    const timer = window.setTimeout(() => setCopied(false), 2_000);
    return () => window.clearTimeout(timer);
  }, [copied]);

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
  const whyNotChange =
    mayAuthor || role === null
      ? undefined
      : `Your ${String(role)} role cannot change test suites. Ask an organization admin to change your role.`;

  const writeAction =
    role === null ? undefined : (
      <Button
        asChild={mayAuthor}
        disabled={!mayAuthor}
        {...(whyNotWrite === undefined ? {} : { why: whyNotWrite })}
      >
        {mayAuthor ? (
          <Link href={newTestInSuitePath(projectId, suiteId)}>Write a test</Link>
        ) : (
          <span>Write a test</span>
        )}
      </Button>
    );

  async function removeSuite(): Promise<void> {
    setRemoving(true);
    setRemoveRefused(null);
    const answer = await platformAnswer(
      deleteTestSuite({ suiteId, projectId }, { client: platformClient }),
    );
    setRemoving(false);
    if (answer.status === "signed-out") {
      window.location.replace("/sign-in");
      return;
    }
    if (answer.status !== "ready") {
      setRemoveRefused(answer.refusal.message);
      return;
    }
    setDeletingSuite(false);
    router.push(testsPagePath(projectId));
  }

  async function removeTest(test: ListedTest): Promise<void> {
    setRemoving(true);
    setRemoveRefused(null);
    const answer = await platformAnswer(
      deleteTest({ testId: test.id, projectId }, { client: platformClient }),
    );
    setRemoving(false);
    if (answer.status === "signed-out") {
      window.location.replace("/sign-in");
      return;
    }
    if (answer.status !== "ready") {
      setRemoveRefused(answer.refusal.message);
      return;
    }
    setDeletingTest(null);
    setAfter(null);
    reloadTests();
  }

  function testMenu(test: ListedTest): ReactNode {
    return (
      <RowMenu label={`Open the menu for ${test.name}`}>
        {(close) => (
          <>
            <MenuItem href={testPagePath(projectId, test.id)} onClick={close}>
              Open
            </MenuItem>
            <MenuDivider />
            <DestructiveItem
              disabled={!mayAuthor}
              onClick={() => {
                close();
                setRemoveRefused(null);
                setDeletingTest(test);
              }}
            >
              Delete test
            </DestructiveItem>
            {whyNotWrite === undefined ? null : <MenuReason>{whyNotWrite}</MenuReason>}
          </>
        )}
      </RowMenu>
    );
  }

  const columns: readonly Column<ListedTest>[] = [
    {
      key: "name",
      header: "Name",
      primary: true,
      width: "480px",
      cell: (test) => (
        <Link href={testPagePath(projectId, test.id)}>{test.name}</Link>
      ),
    },
    {
      key: "personas",
      header: "Personas",
      width: "340px",
      hideOnMobile: true,
      cell: (test) => {
        if (test.personas.length === 0) {
          return <span className="text-faint">The project default</span>;
        }
        const { shown, more } = personaCell(test.personas);
        return (
          <span className="flex min-w-0 items-baseline gap-3">
            {shown.map((persona) => (
              <Link
                className={
                  persona.archivedAt === null
                    ? "min-w-0 overflow-hidden text-ellipsis whitespace-nowrap"
                    : "min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-faint line-through"
                }
                href={personaPagePath(projectId, persona.id)}
                key={persona.id}
              >
                {persona.name}
              </Link>
            ))}
            {more === 0 ? null : (
              <Badge shape="count" title={`${String(more)} more`}>
                +{more}
              </Badge>
            )}
          </span>
        );
      },
    },
    {
      key: "changed",
      header: "Changed",
      cell: (test) => <ListInstant instant={test.updatedAt} />,
    },
    {
      key: "menu",
      header: "Test actions",
      action: true,
      cell: testMenu,
    },
  ];

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

    const loaded = [...tests.value.tests, ...(after?.tests ?? [])];
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

    if (items.length === 0) {
      if (search.trim() !== "") {
        return (
          <Empty
            title={`No tests match “${search.trim()}”`}
            lead="Try part of another name, or clear the search."
          />
        );
      }
      return (
        <Empty
          title="No tests in this suite"
          lead="A test is one situation to put the agent in, what should happen, and which personas call about it. Write the first one and this suite can run."
          action={writeAction}
        />
      );
    }

    return (
      <>
        <DataTable
          label={`Tests in ${title}`}
          columns={columns}
          rows={items}
          keyOf={(test) => test.id}
          stretchPrimaryLink
          {...(cursor === null
            ? {}
            : {
                more: {
                  onMore: () => void showMore(),
                  loading: loadingMore,
                  note: `${String(items.length)} tests so far`,
                },
              })}
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

  const suiteMenu =
    role === null || currentSuite === null ? null : (
      <ToolbarMenu label="Open the suite menu">
        {(close) => (
          <>
            <MenuItem
              disabled={!mayAuthor}
              onClick={() => {
                close();
                setRenaming(true);
              }}
            >
              Rename suite
            </MenuItem>
            <MenuItem
              onClick={() => {
                close();
                void navigator.clipboard?.writeText(suiteId).then(
                  () => setCopied(true),
                  () => setCopied(false),
                );
              }}
            >
              Copy suite id
            </MenuItem>
            <MenuDivider />
            <DestructiveItem
              disabled={!mayAuthor}
              onClick={() => {
                close();
                setRemoveRefused(null);
                setDeletingSuite(true);
              }}
            >
              Delete suite
            </DestructiveItem>
            {whyNotChange === undefined ? null : (
              <MenuReason>{whyNotChange}</MenuReason>
            )}
          </>
        )}
      </ToolbarMenu>
    );

  return (
    <ProductPage>
      <PageHeader
        title={title}
        breadcrumbs={trailInto({ label: "Tests", href: testsPagePath(projectId) })}
        toolbar={
          <SearchField
            aria-label="Search tests"
            placeholder="Search tests"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        }
        action={
          currentSuite === null ? undefined : (
            <>
              {copied ? (
                <span className="text-sm text-success" role="status">
                  Copied
                </span>
              ) : null}
              {writeAction}
              <Button asChild variant="secondary">
                <Link href={runSuitePath(projectId, suiteId)}>Run suite</Link>
              </Button>
              {suiteMenu}
            </>
          )
        }
      />
      <PageBody>{body()}</PageBody>

      {currentSuite === null ? null : (
        <RenameSuiteSheet
          projectId={projectId}
          suite={currentSuite}
          open={renaming}
          mayAuthor={mayAuthor}
          {...(whyNotChange === undefined ? {} : { why: whyNotChange })}
          onRenamed={setShownSuite}
          onDelete={() => {
            setRenaming(false);
            setRemoveRefused(null);
            setDeletingSuite(true);
          }}
          onClose={() => setRenaming(false)}
        />
      )}

      {currentSuite === null ? null : (
        <WriteTestSheet
          projectId={projectId}
          suite={currentSuite}
          open={writing}
          mayAuthor={mayAuthor}
          {...(whyNotWrite === undefined ? {} : { why: whyNotWrite })}
          onWritten={(test) => router.push(testPagePath(projectId, test.id))}
          onClose={() => router.push(suitePagePath(projectId, suiteId))}
        />
      )}

      {deletingSuite && currentSuite !== null ? (
        <ConfirmDialog
          title={`Delete ${currentSuite.name}?`}
          lines={[
            "This deletes the suite and its tests. Nobody can author or run them after this.",
            "Runs that already happened keep their results and transcripts.",
          ]}
          confirmLabel="Delete suite"
          busy={removing}
          refusal={removeRefused}
          onConfirm={() => void removeSuite()}
          onClose={() => setDeletingSuite(false)}
        />
      ) : null}

      {deletingTest === null ? null : (
        <ConfirmDialog
          title="Delete this test?"
          lines={[
            `“${deletingTest.name}” leaves the ${title} suite. Nobody can author or run it after this.`,
            "Runs that already ran it keep their results and transcripts.",
          ]}
          confirmLabel="Delete test"
          busy={removing}
          refusal={removeRefused}
          onConfirm={() => void removeTest(deletingTest)}
          onClose={() => setDeletingTest(null)}
        />
      )}
    </ProductPage>
  );
}
