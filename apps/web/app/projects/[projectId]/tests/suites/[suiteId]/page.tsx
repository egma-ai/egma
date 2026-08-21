"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  deleteTestSuite,
  getTestSuite,
  listTests,
  updateTestSuite,
} from "@egma/platform-api/client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { Refusal } from "../../../../../../lib/api.ts";
import { roleOf } from "../../../../../../lib/me.ts";
import {
  platformAnswer,
  platformClient,
} from "../../../../../../lib/platform-client.ts";
import { canAuthor } from "../../../../../../lib/roles.ts";
import {
  newTestInSuitePath,
  shortSuiteId,
  type TestSuite,
} from "../../../../../../lib/test-suites.ts";
import type {
  ListedTest,
  TestPage,
} from "../../../../../../lib/tests.ts";
import { DataTable, type Column } from "../../../../../../ui/data-table.tsx";
import { Dialog } from "../../../../../../ui/dialog.tsx";
import { Field, Refused } from "../../../../../../ui/form.tsx";
import { Empty, Failure, Loading, NotFound } from "../../../../../../ui/page-state.tsx";
import { RelativeInstant, useMinuteClock } from "../../../../../../ui/relative-time.tsx";
import { useProjectRead } from "../../../../../../ui/resource.ts";
import { Actions } from "../../../../../../ui/section.tsx";
import {
  AppShell,
  PageBody,
  PageHeader,
  ProductPage,
  useShellSession,
} from "../../../../../../ui/shell.tsx";

export default function TestSuitePage() {
  const { projectId, suiteId } = useParams<{
    projectId: string;
    suiteId: string;
  }>();
  return (
    <AppShell>
      <TestSuiteDetail projectId={projectId} suiteId={suiteId} />
    </AppShell>
  );
}

function columnsFor(projectId: string, now: number): readonly Column<ListedTest>[] {
  return [
    {
      key: "name",
      header: "Test",
      primary: true,
      cell: (test) => (
        <Link href={`/projects/${encodeURIComponent(projectId)}/tests/${encodeURIComponent(test.id)}`}>
          {test.name}
        </Link>
      ),
    },
    {
      key: "version",
      header: "Version",
      mono: true,
      cell: (test) => `v${String(test.version)}`,
    },
    {
      key: "personas",
      header: "Personas",
      mono: true,
      hideOnMobile: true,
      cell: (test) => String(test.personas.length),
    },
    {
      key: "changed",
      header: "Changed",
      mono: true,
      cell: (test) => <RelativeInstant instant={test.updatedAt} now={now} />,
    },
  ];
}

function RenameSuiteDialog({
  projectId,
  suite,
  onRenamed,
  onClose,
}: {
  readonly projectId: string;
  readonly suite: TestSuite;
  readonly onRenamed: (suite: TestSuite) => void;
  readonly onClose: () => void;
}) {
  const [name, setName] = useState(suite.name);
  const [saving, setSaving] = useState(false);
  const [refused, setRefused] = useState<Refusal | null>(null);

  async function rename(): Promise<void> {
    if (name.trim() === "" || name.trim() === suite.name) return;
    setSaving(true);
    setRefused(null);
    const answer = await platformAnswer(
      updateTestSuite(
        { suiteId: suite.id, projectId, name: name.trim() },
        { client: platformClient },
      ),
    );
    setSaving(false);
    if (answer.status === "signed-out") {
      window.location.replace("/sign-in");
      return;
    }
    if (answer.status !== "ready") {
      setRefused(answer.refusal);
      return;
    }
    onRenamed(answer.value);
    onClose();
  }

  return (
    <Dialog title="Rename test suite" onClose={onClose}>
      {(dismiss) => (
        <form
          className="flex flex-col gap-5"
          onSubmit={(event) => {
            event.preventDefault();
            void rename();
          }}
        >
          {refused === null ? null : <Refused message={refused.message} />}
          <Field label="Suite name" htmlFor="suite-name">
            <Input
              id="suite-name"
              value={name}
              autoComplete="off"
              spellCheck={false}
              disabled={saving}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          <Actions>
            <Button type="button" variant="secondary" disabled={saving} onClick={dismiss}>
              Cancel
            </Button>
            <Button
              type="submit"
              busy={saving}
              disabled={name.trim() === "" || name.trim() === suite.name}
            >
              {saving ? "Saving…" : "Save name"}
            </Button>
          </Actions>
        </form>
      )}
    </Dialog>
  );
}

function DeleteSuiteDialog({
  projectId,
  suite,
  onDeleted,
  onClose,
}: {
  readonly projectId: string;
  readonly suite: TestSuite;
  readonly onDeleted: () => void;
  readonly onClose: () => void;
}) {
  const [deleting, setDeleting] = useState(false);
  const [refused, setRefused] = useState<Refusal | null>(null);

  async function remove(): Promise<void> {
    setDeleting(true);
    setRefused(null);
    const answer = await platformAnswer(
      deleteTestSuite(
        { suiteId: suite.id, projectId },
        { client: platformClient },
      ),
    );
    setDeleting(false);
    if (answer.status === "signed-out") {
      window.location.replace("/sign-in");
      return;
    }
    if (answer.status !== "ready") {
      setRefused(answer.refusal);
      return;
    }
    onDeleted();
  }

  return (
    <Dialog title={`Delete ${suite.name}`} onClose={onClose}>
      {(dismiss) => (
        <div className="flex flex-col gap-5">
          <p className="m-0 text-sm text-muted-foreground">
            This permanently deletes {suite.name} and every test in it. You cannot restore them.
          </p>
          {refused === null ? null : <Refused message={refused.message} />}
          <Actions>
            <Button type="button" variant="secondary" disabled={deleting} onClick={dismiss}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              busy={deleting}
              onClick={() => void remove()}
            >
              {deleting ? "Deleting…" : "Delete suite"}
            </Button>
          </Actions>
        </div>
      )}
    </Dialog>
  );
}

function TestSuiteDetail({
  projectId,
  suiteId,
}: {
  readonly projectId: string;
  readonly suiteId: string;
}) {
  const router = useRouter();
  const { me } = useShellSession();
  const role = me === null ? null : roleOf(me);
  const mayAuthor = role !== null && canAuthor(role);
  const now = useMinuteClock();
  const { answer: suite, reload: reloadSuite } = useProjectRead<TestSuite>(
    (projectId) =>
      platformAnswer(
        getTestSuite(
          { suiteId, projectId },
          { client: platformClient },
        ),
      ),
    projectId,
    suiteId,
  );
  const { answer: tests, reload: reloadTests } = useProjectRead<TestPage>(
    (projectId) =>
      platformAnswer(
        listTests(
          { suiteId, projectId },
          { client: platformClient },
        ),
      ),
    projectId,
    suiteId,
  );
  const [after, setAfter] = useState<TestPage | null>(null);
  const [shownSuite, setShownSuite] = useState<TestSuite | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreRefused, setMoreRefused] = useState<Refusal | null>(null);
  const showing = useRef(`${projectId}:${suiteId}`);

  useEffect(() => {
    showing.current = `${projectId}:${suiteId}`;
    setAfter(null);
    setMoreRefused(null);
    setShownSuite(null);
    setRenaming(false);
    setDeleting(false);
  }, [projectId, suiteId]);

  useEffect(() => {
    if (suite?.status === "ready") setShownSuite(suite.value);
  }, [suite]);

  useEffect(() => {
    if (suite?.status === "signed-out" || tests?.status === "signed-out") {
      window.location.replace("/sign-in");
    }
  }, [suite, tests]);

  const writeAction =
    role === null ? undefined : (
      <Button
        asChild={mayAuthor}
        disabled={!mayAuthor}
        why={
          mayAuthor
            ? undefined
            : `Your ${String(role)} role cannot write tests. Ask an organization admin to change your role.`
        }
      >
        {mayAuthor ? (
          <Link href={newTestInSuitePath(projectId, suiteId)}>Write a test</Link>
        ) : (
          <span>Write a test</span>
        )}
      </Button>
    );

  function body() {
    if (suite === null || tests === null || suite.status === "signed-out" || tests.status === "signed-out") {
      return <Loading what="test suite" />;
    }
    if (suite.status === "missing") {
      return <NotFound message={suite.refusal.message} />;
    }
    if (suite.status === "failed") {
      return <Failure message={suite.refusal.message} onRetry={reloadSuite} />;
    }
    if (tests.status === "missing") {
      return <NotFound message={tests.refusal.message} />;
    }
    if (tests.status === "failed") {
      return <Failure message={tests.refusal.message} onRetry={reloadTests} />;
    }

    const items = [...tests.value.tests, ...(after?.tests ?? [])];
    const cursor = after?.nextPageToken ?? tests.value.nextPageToken;

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
      return (
        <Empty
          title="No tests in this suite"
          lead="This empty suite is valid. Write its first test when you are ready."
          action={writeAction}
        />
      );
    }

    return (
      <>
        <DataTable
          label={`Tests in ${shownSuite?.name ?? suite.value.name}`}
          columns={columnsFor(projectId, now)}
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

  const currentSuite =
    shownSuite !== null && shownSuite.id === suiteId
      ? shownSuite
      : suite?.status === "ready"
        ? suite.value
        : null;
  const title = currentSuite?.name ?? "Test suite";
  const headerActions =
    role === null || currentSuite === null ? undefined : (
      <>
        {tests?.status === "ready" &&
        (tests.value.tests.length > 0 || tests.value.nextPageToken !== null)
          ? writeAction
          : null}
        <Button
          type="button"
          variant="secondary"
          disabled={!mayAuthor}
          why={
            mayAuthor
              ? undefined
              : `Your ${String(role)} role cannot rename test suites. Ask an organization admin to change your role.`
          }
          onClick={() => setRenaming(true)}
        >
          Rename suite
        </Button>
        <Button
          type="button"
          variant="destructive"
          disabled={!mayAuthor}
          why={
            mayAuthor
              ? undefined
              : `Your ${String(role)} role cannot delete test suites. Ask an organization admin to change your role.`
          }
          onClick={() => setDeleting(true)}
        >
          Delete suite
        </Button>
      </>
    );

  return (
    <ProductPage>
      <PageHeader
        title={title}
        lead={<>Suite <span className="font-mono">{shortSuiteId(suiteId)}</span> · Tests in one suite stay together for their full lifetime.</>}
        breadcrumbs={[
          { label: "Tests", href: `/projects/${encodeURIComponent(projectId)}/tests` },
          { label: title },
        ]}
        action={headerActions}
      />
      <PageBody>{body()}</PageBody>
      {renaming && currentSuite !== null ? (
        <RenameSuiteDialog
          projectId={projectId}
          suite={currentSuite}
          onRenamed={setShownSuite}
          onClose={() => setRenaming(false)}
        />
      ) : null}
      {deleting && currentSuite !== null ? (
        <DeleteSuiteDialog
          projectId={projectId}
          suite={currentSuite}
          onDeleted={() => {
            router.push(`/projects/${encodeURIComponent(projectId)}/tests`);
          }}
          onClose={() => setDeleting(false)}
        />
      ) : null}
    </ProductPage>
  );
}
