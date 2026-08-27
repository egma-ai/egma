"use client";

import { cancelRun, listAgents, listRuns } from "@egma/platform-api/client";
import Link from "next/link";
import {
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";

import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { cn } from "@/lib/utils";

import type { Refusal } from "../../../../lib/api.ts";
import type { AgentPage } from "../../../../lib/agents.ts";
import { asListInstant, formatViewerInstant } from "../../../../lib/instants.ts";
import { firstProjectOf, roleOf } from "../../../../lib/me.ts";
import {
  platformAnswer,
  platformClient,
} from "../../../../lib/platform-client.ts";
import { projectLanding, projectPath } from "../../../../lib/project-context.ts";
import { canAuthor } from "../../../../lib/roles.ts";
import type { RunHistoryPage, RunRow } from "../../../../lib/runs.ts";
import { DataTable, type Column } from "../../../../ui/data-table.tsx";
import { Refused } from "../../../../ui/form.tsx";
import { Empty, Failure, Loading, NotFound } from "../../../../ui/page-state.tsx";
import { DestructiveItem, RowMenu } from "../../../../ui/row-menu.tsx";
import { useProjectRead } from "../../../../ui/resource.ts";
import { useDraftNavigation } from "../../../../ui/draft-navigation.tsx";
import { currentDraftState } from "../../../../ui/settings-read.ts";
import { Actions, TOOLBAR_FILTER } from "../../../../ui/section.tsx";
import { RunStatus } from "../../../../ui/run-status.tsx";
import {
  AppShell,
  PageBody,
  PageHeader,
  ProductPage,
  useShellSession,
} from "../../../../ui/shell.tsx";
import { CreateRunSheet } from "./create-run-sheet.tsx";

function suiteLabel(run: RunRow): string {
  return `${run.suiteName}${run.suiteDeleted ? " (deleted)" : ""}`;
}

function StartedAt({ instant }: { readonly instant: string }) {
  return (
    <time
      className="tabular-nums text-foreground"
      dateTime={instant}
      title={formatViewerInstant(instant, "minute")}
      suppressHydrationWarning
    >
      {asListInstant(instant)}
    </time>
  );
}

function columnsFor(
  projectId: string,
  agentNames: ReadonlyMap<string, string>,
  mayControl: boolean | null,
  onCancel: (runId: string) => void,
): readonly Column<RunRow>[] {
  return [
    {
      key: "run",
      header: "Run",
      primary: true,
      width: "24%",
      cell: (run) => (
        <Link
          className="font-medium text-foreground no-underline underline-offset-4 pointer-hover:underline pointer-hover:decoration-brand focus-visible:underline"
          href={projectPath(projectId, "runs", run.id)}
        >
          {run.name ?? suiteLabel(run)}
        </Link>
      ),
    },
    {
      key: "suite",
      header: "Test suite",
      width: "20%",
      cell: (run) => <span className="text-foreground">{suiteLabel(run)}</span>,
    },
    {
      key: "agent",
      header: "Agent",
      width: "22%",
      cell: (run) => (
        <span className="text-foreground">
          {agentNames.get(run.agentId) ?? "Unavailable agent"}
        </span>
      ),
    },
    {
      key: "started",
      header: "Started",
      width: "17%",
      cell: (run) =>
        run.startedAt === null ? (
          <span className="text-faint">Not started</span>
        ) : (
          <StartedAt instant={run.startedAt} />
        ),
    },
    {
      key: "status",
      header: "Status",
      width: "17%",
      cell: (run) => <RunStatus status={run.status} />,
    },
    {
      key: "stop",
      header: "",
      action: true,
      cell: (run) =>
        mayControl !== true || (run.status !== "pending" && run.status !== "running") ? (
          ""
        ) : (
          <RowMenu label={`Actions for ${run.name ?? suiteLabel(run)}`}>
            {(close) => (
              <DestructiveItem
                onClick={() => {
                  close();
                  onCancel(run.id);
                }}
              >
                Cancel run
              </DestructiveItem>
            )}
          </RowMenu>
        ),
    },
  ];
}

function Runs({
  projectId,
  overlay,
}: {
  readonly projectId: string;
  readonly overlay?: ReactNode;
}) {
  const { me } = useShellSession();
  const role = me === null ? null : roleOf(me);
  const mayStart = role !== null && canAuthor(role);
  const draftNavigation = useDraftNavigation();
  const listPath = projectPath(projectId, "runs");
  const createPath = projectPath(projectId, "runs", "new");

  const [agent, setAgent] = useState("");
  const asked = agent;

  const { answer, reload } = useProjectRead<RunHistoryPage>(
    (projectId) =>
      platformAnswer(
        listRuns(
          {
            projectId,
            ...(agent === "" ? {} : { agentId: agent }),
          },
          { client: platformClient },
        ),
      ),
    projectId,
    asked,
  );
  const { answer: agents } = useProjectRead<AgentPage>(
    (projectId) => platformAnswer(listAgents({ projectId }, { client: platformClient })),
    projectId,
  );

  const [after, setAfter] = useState<{
    readonly asked: string;
    readonly project: string;
    readonly page: RunHistoryPage;
  } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreRefused, setMoreRefused] = useState<Refusal | null>(null);
  const [openRun, setOpenRun] = useState<string | null>(null);
  const [rowRefused, setRowRefused] = useState<string | null>(null);
  const [retryCancel, setRetryCancel] = useState<{ readonly runId: string } | null>(null);
  const [stopping, setStopping] = useState(false);
  const [creating, setCreating] = useState(false);
  const showing = useRef(projectId);
  const creatingNow = useRef(false);
  const allowCreatePop = useRef(false);
  const createOpener = useRef<HTMLAnchorElement | null>(null);

  const carried =
    after !== null && after.project === projectId && after.asked === asked
      ? after.page
      : null;

  useEffect(() => {
    showing.current = projectId;
    setAfter(null);
    setMoreRefused(null);
    setLoadingMore(false);
    setOpenRun(null);
    setRowRefused(null);
    setRetryCancel(null);
    creatingNow.current = false;
    setCreating(false);
  }, [projectId]);

  useEffect(() => {
    function finishCreate(): void {
      creatingNow.current = false;
      setCreating(false);
      globalThis.setTimeout(() => {
        createOpener.current?.focus({ preventScroll: true });
      }, 0);
    }

    function readCreateAddress(): void {
      const pathname = new URL(globalThis.location.href).pathname;
      if (pathname === createPath) {
        if (!creatingNow.current && overlay === undefined) {
          creatingNow.current = true;
          setCreating(true);
        }
        return;
      }
      if (pathname !== listPath || !creatingNow.current) return;

      if (allowCreatePop.current) {
        allowCreatePop.current = false;
        finishCreate();
        return;
      }
      if (currentDraftState() === "unchanged") {
        finishCreate();
        return;
      }

      globalThis.history.pushState(null, "", createPath);
      draftNavigation.request(
        () => {
          allowCreatePop.current = true;
          globalThis.history.back();
        },
        createOpener.current,
      );
    }

    globalThis.addEventListener("popstate", readCreateAddress);
    return () => globalThis.removeEventListener("popstate", readCreateAddress);
  }, [createPath, draftNavigation, listPath, overlay]);

  useEffect(() => {
    setAfter(null);
    setMoreRefused(null);
  }, [answer]);

  useEffect(() => {
    if (answer?.status === "signed-out") window.location.replace("/sign-in");
  }, [answer]);

  async function stop(runId: string): Promise<void> {
    if (stopping) return;
    setRowRefused(null);
    setStopping(true);
    const answered = await platformAnswer(
      cancelRun({ runId, projectId }, { client: platformClient }),
    );
    setStopping(false);

    if (answered.status === "signed-out") {
      window.location.replace("/sign-in");
      return;
    }
    if (answered.status !== "ready") {
      setRowRefused(answered.refusal.message);
      setRetryCancel({ runId });
      return;
    }
    setOpenRun(null);
    setRetryCancel(null);
    reload();
  }

  function openCancel(runId: string): void {
    setRowRefused(null);
    setRetryCancel(null);
    setOpenRun((held) => (held === runId ? null : runId));
  }

  const agentRows = agents?.status === "ready" ? agents.value.agents : [];
  const agentNames = new Map(agentRows.map((one) => [one.id, one.name]));
  const narrowed = agent !== "";

  function openCreate(event: ReactMouseEvent<HTMLAnchorElement>): void {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey ||
      event.currentTarget.target === "_blank" ||
      event.currentTarget.hasAttribute("download")
    ) {
      return;
    }

    event.preventDefault();
    createOpener.current = event.currentTarget;
    globalThis.history.pushState(null, "", createPath);
    creatingNow.current = true;
    setCreating(true);
  }

  function closeCreate(): void {
    allowCreatePop.current = true;
    globalThis.history.back();
  }

  function createAction(): ReactNode {
    if (!mayStart) return undefined;
    return (
      <Button asChild>
        <Link
          href={createPath}
          onClick={overlay === undefined ? openCreate : undefined}
        >
          Create a run
        </Link>
      </Button>
    );
  }

  function body(): ReactNode {
    if (answer === null || answer.status === "signed-out") {
      return <Loading what="this project's runs" />;
    }
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
    if (answer.status === "failed") {
      return <Failure message={answer.refusal.message} onRetry={reload} />;
    }

    const items = [...answer.value.runs, ...(carried?.runs ?? [])];
    const cursor = carried === null ? answer.value.nextPageToken : carried.nextPageToken;
    const opened = items.find((run) => run.id === openRun);

    async function showMore(): Promise<void> {
      if (cursor === null) return;

      const projectAsked = projectId;
      const question = asked;
      setMoreRefused(null);
      setLoadingMore(true);
      const next = await platformAnswer(
        listRuns(
          {
            projectId: projectAsked,
            pageToken: cursor,
            ...(agent === "" ? {} : { agentId: agent }),
          },
          { client: platformClient },
        ),
      );
      setLoadingMore(false);
      if (showing.current !== projectAsked) return;

      if (next.status === "signed-out") {
        window.location.replace("/sign-in");
        return;
      }
      if (next.status !== "ready") {
        setMoreRefused(next.refusal);
        return;
      }
      setAfter({
        project: projectAsked,
        asked: question,
        page: {
          runs: [...(carried?.runs ?? []), ...next.value.runs],
          nextPageToken: next.value.nextPageToken,
        },
      });
    }

    if (items.length === 0) {
      return (
        <>
          <div className="[&>[data-slot=page-state][data-tone=empty]]:min-h-[204px]">
            <Empty
              title={narrowed ? "No run here matches that" : "Create your first simulation run"}
              lead={
                narrowed
                  ? "Clear the filters to see every run in this project."
                  : "A run simulates a full test suite against a selected agent."
              }
              action={
                narrowed ? (
                  cursor === null ? undefined : (
                    <Button
                      type="button"
                      variant="secondary"
                      disabled={loadingMore}
                      onClick={() => void showMore()}
                    >
                      {loadingMore ? "Looking…" : "Keep looking"}
                    </Button>
                  )
                ) : (
                  createAction()
                )
              }
            />
          </div>
          {moreRefused === null ? null : (
            <Failure
              title="Egma could not look further back."
              message={moreRefused.message}
              onRetry={() => void showMore()}
            />
          )}
        </>
      );
    }

    return (
      <>
        <div className="[--row-min-height:56px]">
          <DataTable
            stackWhenConstrained
            stretchPrimaryLink
            label="Runs in this project"
            columns={columnsFor(
              projectId,
              agentNames,
              role === null ? null : mayStart,
              openCancel,
            )}
            rows={items}
            keyOf={(run) => run.id}
            {...(cursor === null
              ? {}
              : {
                  more: {
                    onMore: () => void showMore(),
                    loading: loadingMore,
                    note: `${String(items.length)} runs so far`,
                  },
                })}
          />
        </div>
        {opened === undefined ? null : (
          <section
            className={cn(
              "flex flex-col gap-3 rounded-card border border-border bg-surface p-5",
              "border-s-[3px] border-s-brand",
            )}
            aria-label="Cancel this run"
          >
            <h3 className="m-0 text-sm font-medium text-foreground">
              Cancel {opened.name ?? "this run"}?
            </h3>
            <p className="m-0 max-w-[72ch] text-sm text-muted-foreground">
              Simulations still waiting stop here and now. Simulations already with a
              simulator are told to stop and land as canceled when they do, and whatever
              they produced stays on the record. A canceled run never becomes completed.
            </p>
            {rowRefused === null ? null : <Refused message={rowRefused} />}
            {retryCancel === null ? null : (
              <Actions>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={stopping}
                  onClick={() => void stop(retryCancel.runId)}
                >
                  Try again
                </Button>
              </Actions>
            )}
            <Actions>
              <Button type="button" variant="secondary" onClick={() => setOpenRun(null)}>
                Keep running
              </Button>
              <Button
                type="button"
                variant="destructive"
                disabled={stopping}
                onClick={() => void stop(opened.id)}
              >
                {stopping ? "Canceling…" : "Cancel run"}
              </Button>
            </Actions>
          </section>
        )}
        {moreRefused === null ? null : (
          <Failure
            title="Egma could not load more runs."
            message={moreRefused.message}
            onRetry={() => void showMore()}
          />
        )}
      </>
    );
  }

  const untouchedEmptyPage =
    answer?.status === "ready" &&
    !narrowed &&
    answer.value.runs.length === 0 &&
    answer.value.nextPageToken === null;
  const agentFilterWidth = untouchedEmptyPage
    ? "w-[160px] min-w-[160px] max-w-[160px]"
    : "w-[148px] min-w-[148px] max-w-[148px]";

  const filters = (
    <Select
      id="runs-agent"
      className={cn(TOOLBAR_FILTER, agentFilterWidth)}
      value={agent}
      aria-label="Show only runs against one agent"
      onChange={(event) => setAgent(event.target.value)}
    >
      <option value="">Any agent</option>
      {agentRows.map((one) => (
        <option key={one.id} value={one.id}>
          {one.name}
        </option>
      ))}
    </Select>
  );

  return (
    <ProductPage>
      <PageHeader
        title="Runs"
        toolbar={filters}
        action={untouchedEmptyPage ? undefined : createAction()}
      />
      <PageBody>{body()}</PageBody>
      {overlay ??
        (creating ? (
          <CreateRunSheet
            projectId={projectId}
            initialAgentPage={agents?.status === "ready" ? agents.value : undefined}
            onClose={closeCreate}
          />
        ) : null)}
    </ProductPage>
  );
}

export function RunsScreen({
  projectId,
  overlay,
}: {
  readonly projectId: string;
  readonly overlay?: ReactNode;
}) {
  return (
    <AppShell>
      <Runs projectId={projectId} overlay={overlay} />
    </AppShell>
  );
}
