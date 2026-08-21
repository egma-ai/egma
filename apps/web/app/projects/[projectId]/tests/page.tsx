"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  createTestSuite,
  listTestSuites,
} from "@egma/platform-api/client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { Refusal } from "../../../../lib/api.ts";
import { firstProjectOf, roleOf } from "../../../../lib/me.ts";
import {
  platformAnswer,
  platformClient,
} from "../../../../lib/platform-client.ts";
import { projectLanding } from "../../../../lib/project-context.ts";
import { canAuthor } from "../../../../lib/roles.ts";
import {
  suitePagePath,
  shortSuiteId,
  type TestSuite,
  type TestSuitePage,
} from "../../../../lib/test-suites.ts";
import { DataTable, type Column } from "../../../../ui/data-table.tsx";
import { Dialog } from "../../../../ui/dialog.tsx";
import { Field, Refused } from "../../../../ui/form.tsx";
import { Empty, Failure, Loading, NotFound } from "../../../../ui/page-state.tsx";
import { RelativeInstant, useMinuteClock } from "../../../../ui/relative-time.tsx";
import { useProjectRead } from "../../../../ui/resource.ts";
import { Actions } from "../../../../ui/section.tsx";
import {
  AppShell,
  PageBody,
  PageHeader,
  ProductPage,
  useShellSession,
} from "../../../../ui/shell.tsx";

export default function TestsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  return (
    <AppShell>
      <Suites projectId={projectId} />
    </AppShell>
  );
}

function columnsFor(
  projectId: string,
  now: number,
  duplicateNames: ReadonlySet<string>,
): readonly Column<TestSuite>[] {
  return [
    {
      key: "name",
      header: "Test suite",
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
      key: "changed",
      header: "Changed",
      mono: true,
      width: "120px",
      cell: (suite) => <RelativeInstant instant={suite.updatedAt} now={now} />,
    },
  ];
}

function CreateSuiteDialog({
  projectId,
  onClose,
}: {
  readonly projectId: string;
  readonly onClose: () => void;
}) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [refused, setRefused] = useState<Refusal | null>(null);

  async function create(): Promise<void> {
    if (name.trim() === "") return;
    setSaving(true);
    setRefused(null);
    const answer = await platformAnswer(
      createTestSuite(
        { projectId, name: name.trim() },
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
    onClose();
    router.push(suitePagePath(projectId, answer.value.id));
  }

  return (
    <Dialog title="Create a test suite" onClose={onClose}>
      {(dismiss) => (
        <form
          className="flex flex-col gap-5"
          onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}
        >
          <p className="m-0 text-sm text-muted-foreground">
            A test suite is a folder of tests that you normally review and run together.
          </p>
          {refused === null ? null : <Refused message={refused.message} />}
          <Field label="Suite name" htmlFor="suite-name">
            <Input
              id="suite-name"
              value={name}
              autoComplete="off"
              spellCheck={false}
              placeholder="Northside Ford"
              disabled={saving}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          <Actions>
            <Button type="button" variant="secondary" disabled={saving} onClick={dismiss}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving || name.trim() === ""}>
              {saving ? "Creating…" : "Create suite"}
            </Button>
          </Actions>
        </form>
      )}
    </Dialog>
  );
}

function Suites({ projectId }: { readonly projectId: string }) {
  const { me } = useShellSession();
  const role = me === null ? null : roleOf(me);
  const mayAuthor = role !== null && canAuthor(role);
  const now = useMinuteClock();
  const { answer, reload } = useProjectRead<TestSuitePage>(
    (projectId) =>
      platformAnswer(
        listTestSuites({ projectId }, { client: platformClient }),
      ),
    projectId,
  );
  const [creating, setCreating] = useState(false);
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
  }, [projectId]);

  useEffect(() => {
    if (answer?.status === "signed-out") window.location.replace("/sign-in");
  }, [answer]);

  const createAction =
    role === null ? undefined : (
      <Button
        type="button"
        disabled={!mayAuthor}
        why={
          mayAuthor
            ? undefined
            : `Your ${String(role)} role cannot create test suites. Ask an organization admin to change your role.`
        }
        onClick={() => setCreating(true)}
      >
        Create suite
      </Button>
    );

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

    const items = [
      ...answer.value.testSuites,
      ...(after?.testSuites ?? []),
    ];
    const cursor = after?.nextPageToken ?? answer.value.nextPageToken;
    const nameCounts = new Map<string, number>();
    for (const suite of items) {
      nameCounts.set(suite.name, (nameCounts.get(suite.name) ?? 0) + 1);
    }
    const duplicateNames = new Set(
      [...nameCounts].filter(([, count]) => count > 1).map(([name]) => name),
    );

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
          columns={columnsFor(projectId, now, duplicateNames)}
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
        eyebrow="Project"
        title="Tests"
        lead="Test suites are the folders of behavior you review and run together."
        action={isEmpty ? undefined : createAction}
      />
      <PageBody>{body()}</PageBody>
      {creating ? <CreateSuiteDialog projectId={projectId} onClose={() => setCreating(false)} /> : null}
    </ProductPage>
  );
}
