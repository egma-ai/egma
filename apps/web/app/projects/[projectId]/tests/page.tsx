"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { deleteTestSuite, listTestSuites } from "@egma/platform-api/client";

import { Button } from "@/components/ui/button";
import type { Refusal } from "../../../../lib/api.ts";
import { firstProjectOf, roleOf } from "../../../../lib/me.ts";
import {
  platformAnswer,
  platformClient,
} from "../../../../lib/platform-client.ts";
import { projectLanding } from "../../../../lib/project-context.ts";
import { canAuthor } from "../../../../lib/roles.ts";
import {
  matchesSearch,
  runSuitePath,
  suitePagePath,
  shortSuiteId,
  type TestSuite,
  type TestSuitePage,
} from "../../../../lib/test-suites.ts";
import { DataTable, type Column } from "../../../../ui/data-table.tsx";
import { Empty, Failure, Loading, NotFound } from "../../../../ui/page-state.tsx";
import { MenuDivider, MenuItem } from "../../../../ui/menu.tsx";
import { ListInstant } from "../../../../ui/relative-time.tsx";
import { useProjectRead } from "../../../../ui/resource.ts";
import { SearchField } from "../../../../ui/section.tsx";
import {
  AppShell,
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
} from "./parts.tsx";
import { CreateSuiteSheet, RenameSuiteSheet } from "./suite-sheets.tsx";

/**
 * Tests, which is the list of test suites.
 *
 * **There is no all-tests view to reach from here, and that is the contract
 * rather than a decision taken on this screen.** `listTests` requires a suite,
 * so a project-wide list of tests is a thing the platform cannot answer. The
 * suite is how a person reaches a test, which is why the first thing this page
 * asks anybody to do is create one.
 */
export default function TestsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  return (
    <AppShell>
      <Suites projectId={projectId} />
    </AppShell>
  );
}

function columnsFor({
  projectId,
  duplicateNames,
  menuFor,
}: {
  readonly projectId: string;
  readonly duplicateNames: ReadonlySet<string>;
  readonly menuFor: (suite: TestSuite) => ReactNode;
}): readonly Column<TestSuite>[] {
  return [
    {
      key: "name",
      header: "Name",
      primary: true,
      cell: (suite) => (
        <span className="flex min-w-0 items-baseline gap-2">
          <Link href={suitePagePath(projectId, suite.id)}>{suite.name}</Link>
          {duplicateNames.has(suite.name) ? (
            <span className="flex-none font-mono text-xs text-muted-foreground">
              {shortSuiteId(suite.id)}
            </span>
          ) : null}
        </span>
      ),
    },
    {
      /*
       * The date sits beside the ⋮ rather than beside the name.
       *
       * `8P4-0` gives the name 360px and lets Changed take the rest, because
       * on the board two more columns — a test count and a last-run verdict —
       * stand between them. Neither exists in any response, so both are left
       * out, and an elastic date column would leave 700px of nothing in the
       * middle of every row. The name takes the room instead, which is what
       * the board's own proportions do once the two columns are gone.
       */
      key: "changed",
      header: "Changed",
      width: "200px",
      cell: (suite) => <ListInstant instant={suite.updatedAt} />,
    },
    {
      key: "menu",
      header: "Suite actions",
      action: true,
      cell: menuFor,
    },
  ];
}

function Suites({ projectId }: { readonly projectId: string }) {
  const router = useRouter();
  const { me } = useShellSession();
  const role = me === null ? null : roleOf(me);
  const mayAuthor = role !== null && canAuthor(role);
  const { answer, reload } = useProjectRead<TestSuitePage>(
    (projectId) =>
      platformAnswer(
        listTestSuites({ projectId }, { client: platformClient }),
      ),
    projectId,
  );
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);
  /**
   * Which suite the rename panel is about, kept after it closes.
   *
   * The panel stays mounted so its exit runs to completion, which means the
   * suite it was opened for has to outlive the closing. Clearing it on close
   * would empty the panel while it is still on screen leaving.
   */
  const [sheetSuite, setSheetSuite] = useState<TestSuite | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState<TestSuite | null>(null);
  const [deleteInFlight, setDeleteInFlight] = useState(false);
  const [deleteRefused, setDeleteRefused] = useState<string | null>(null);
  const [after, setAfter] = useState<TestSuitePage | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreRefused, setMoreRefused] = useState<Refusal | null>(null);
  const showing = useRef(projectId);

  const isEmpty =
    answer?.status === "ready" &&
    answer.value.testSuites.length === 0 &&
    answer.value.nextPageToken === null &&
    (after?.testSuites.length ?? 0) === 0;

  useEffect(() => {
    showing.current = projectId;
    setAfter(null);
    setMoreRefused(null);
    setCreating(false);
    setRenaming(false);
    setDeleting(null);
    setSearch("");
  }, [projectId]);

  useEffect(() => {
    if (answer?.status === "signed-out") window.location.replace("/sign-in");
  }, [answer]);

  const whyNot =
    mayAuthor || role === null
      ? undefined
      : `Your ${String(role)} role cannot create test suites. Ask an organization admin to change your role.`;
  const whyNotChange =
    mayAuthor || role === null
      ? undefined
      : `Your ${String(role)} role cannot change test suites. Ask an organization admin to change your role.`;

  const createAction =
    role === null ? undefined : (
      <Button
        type="button"
        disabled={!mayAuthor}
        {...(whyNot === undefined ? {} : { why: whyNot })}
        onClick={() => setCreating(true)}
      >
        Create suite
      </Button>
    );

  async function remove(suite: TestSuite): Promise<void> {
    setDeleteInFlight(true);
    setDeleteRefused(null);
    const answer = await platformAnswer(
      deleteTestSuite({ suiteId: suite.id, projectId }, { client: platformClient }),
    );
    setDeleteInFlight(false);
    if (answer.status === "signed-out") {
      window.location.replace("/sign-in");
      return;
    }
    if (answer.status !== "ready") {
      setDeleteRefused(answer.refusal.message);
      return;
    }
    setDeleting(null);
    setAfter(null);
    reload();
  }

  function menuFor(suite: TestSuite): ReactNode {
    return (
      <RowMenu label={`Open the menu for ${suite.name}`}>
        {(close) => (
          <>
            <MenuItem href={suitePagePath(projectId, suite.id)} onClick={close}>
              Open
            </MenuItem>
            <MenuItem
              disabled={!mayAuthor}
              onClick={() => {
                close();
                setSheetSuite(suite);
                setRenaming(true);
              }}
            >
              Rename
            </MenuItem>
            <MenuItem href={runSuitePath(projectId, suite.id)} onClick={close}>
              Run suite
            </MenuItem>
            <MenuDivider />
            <DestructiveItem
              disabled={!mayAuthor}
              onClick={() => {
                close();
                setDeleteRefused(null);
                setDeleting(suite);
              }}
            >
              Delete suite
            </DestructiveItem>
            {whyNotChange === undefined ? null : (
              <MenuReason>{whyNotChange}</MenuReason>
            )}
          </>
        )}
      </RowMenu>
    );
  }

  function body() {
    if (answer === null || answer.status === "signed-out") return <Loading what="test suites" />;
    if (answer.status === "missing") {
      const elsewhere = me === null ? undefined : firstProjectOf(me);
      return (
        <NotFound
          message={answer.refusal.message}
          action={
            elsewhere === undefined ? undefined : (
              <Button asChild variant="secondary">
                <Link href={projectLanding(elsewhere.id)}>Open {elsewhere.name}</Link>
              </Button>
            )
          }
        />
      );
    }
    if (answer.status === "failed") return <Failure message={answer.refusal.message} onRetry={reload} />;

    const loaded = [
      ...answer.value.testSuites,
      ...(after?.testSuites ?? []),
    ];
    const cursor = after?.nextPageToken ?? answer.value.nextPageToken;
    const nameCounts = new Map<string, number>();
    for (const suite of loaded) {
      nameCounts.set(suite.name, (nameCounts.get(suite.name) ?? 0) + 1);
    }
    const duplicateNames = new Set(
      [...nameCounts].filter(([, count]) => count > 1).map(([name]) => name),
    );
    const items = loaded.filter((suite) => matchesSearch(suite.name, search));

    async function showMore(): Promise<void> {
      if (cursor === null) return;
      setLoadingMore(true);
      setMoreRefused(null);
      const next = await platformAnswer(
        listTestSuites(
          { projectId, pageToken: cursor },
          { client: platformClient },
        ),
      );
      setLoadingMore(false);
      if (showing.current !== projectId) return;
      if (next.status === "signed-out") {
        window.location.replace("/sign-in");
        return;
      }
      if (next.status !== "ready") {
        setMoreRefused(next.refusal);
        return;
      }
      setAfter({
        testSuites: [
          ...(after?.testSuites ?? []),
          ...next.value.testSuites,
        ],
        nextPageToken: next.value.nextPageToken,
      });
    }

    if (items.length === 0) {
      /* A search with no match and an empty project lead somewhere different. */
      if (search.trim() !== "") {
        return (
          <Empty
            title={`No test suites match “${search.trim()}”`}
            lead="Try part of another name, or clear the search."
          />
        );
      }
      return (
        <Empty
          title="No test suites yet"
          lead="Create a test suite before you write the first test. A suite is the folder of tests you normally review and run together."
          action={createAction}
        />
      );
    }

    return (
      <>
        <DataTable
          label="Test suites in this project"
          columns={columnsFor({ projectId, duplicateNames, menuFor })}
          rows={items}
          keyOf={(suite) => suite.id}
          stretchPrimaryLink
          {...(cursor === null
            ? {}
            : {
                more: {
                  onMore: () => void showMore(),
                  loading: loadingMore,
                  note: `${String(items.length)} suites so far`,
                },
              })}
        />
        {moreRefused === null ? null : (
          <Failure
            title="Egma could not load more test suites."
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
        title="Tests"
        toolbar={
          isEmpty ? undefined : (
            <SearchField
              aria-label="Search suites"
              placeholder="Search suites"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          )
        }
        action={isEmpty ? undefined : createAction}
      />
      <PageBody>{body()}</PageBody>

      <CreateSuiteSheet
        projectId={projectId}
        open={creating}
        onCreated={(suite) => {
          setCreating(false);
          router.push(suitePagePath(projectId, suite.id));
        }}
        onClose={() => setCreating(false)}
      />
      {sheetSuite === null ? null : (
        <RenameSuiteSheet
          projectId={projectId}
          suite={sheetSuite}
          open={renaming}
          mayAuthor={mayAuthor}
          {...(whyNotChange === undefined ? {} : { why: whyNotChange })}
          onRenamed={(renamed) => {
            setSheetSuite(renamed);
            setAfter(null);
            reload();
          }}
          onDelete={() => {
            setRenaming(false);
            setDeleteRefused(null);
            setDeleting(sheetSuite);
          }}
          onClose={() => setRenaming(false)}
        />
      )}
      {deleting === null ? null : (
        <ConfirmDialog
          title={`Delete ${deleting.name}?`}
          lines={[
            "This deletes the suite and its tests. Nobody can author or run them after this.",
            "Runs that already happened keep their results and transcripts.",
          ]}
          confirmLabel="Delete suite"
          busy={deleteInFlight}
          refusal={deleteRefused}
          onConfirm={() => void remove(deleting)}
          onClose={() => setDeleting(null)}
        />
      )}
    </ProductPage>
  );
}
