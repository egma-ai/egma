"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { readJson, writeJson, type Refusal } from "../../../../lib/api.ts";
import {
  agentsQuery,
  type AgentPage,
  type ListedAgent,
} from "../../../../lib/agents.ts";
import { asMoment } from "../../../../lib/instants.ts";
import { firstProjectOf, roleOf } from "../../../../lib/me.ts";
import { projectLanding, projectPath } from "../../../../lib/project-context.ts";
import { canAuthor } from "../../../../lib/roles.ts";
import {
  runCancelPath,
  runsQuery,
  RUN_STATUS_WORDS,
  VERDICT_WORDS,
  type RunHistoryPage,
  type RunRow,
  type RunStatusWord,
  type VerdictWord,
} from "../../../../lib/runs.ts";
import {
  Actions,
  Button,
  ButtonLink,
  Refused,
  Select,
  TextInput,
  Toolbar,
} from "../../../../ui/controls.tsx";
import { DataTable, type Column } from "../../../../ui/data-table.tsx";
import { Empty, Failure, Loading, NotFound } from "../../../../ui/page-state.tsx";
import { useProjectRead } from "../../../../ui/resource.ts";
import {
  RunStatus,
  SimulationTally,
  VerdictBadge,
} from "../../../../ui/run-status.tsx";
import {
  AppShell,
  PageBody,
  PageHeader,
  ProductPage,
  useShellSession,
} from "../../../../ui/shell.tsx";
import styles from "./history.module.css";

/**
 * Every run this project has executed, newest first.
 *
 * **Four facts on every row, and none of them folded into another.** The run's
 * machinery, how its conversations are distributed across theirs, how far
 * grading has got, and the verdict — which is blank until every conversation has
 * one, because "nobody has finished looking" is not a result. A list that showed
 * one column called *status* would have to choose which of those four it meant,
 * and whichever it chose would be wrong for somebody: a completed run may hold
 * nothing but failures, and a run full of skipped conversations has failed
 * nothing at all.
 *
 * Every filter is the server's, in the address of the request. A filter applied
 * to what came back would answer differently depending on what had already been
 * fetched, and would quietly break paging.
 */
export default function RunsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  return (
    <AppShell>
      <Runs projectId={projectId} />
    </AppShell>
  );
}

/** What a row says a run was against. Ids where a name has been archived away. */
function ranAgainst(run: RunRow, agents: readonly ListedAgent[]): string {
  const named = agents.find((one) => one.id === run.agent_id);
  return named?.name ?? run.agent_id;
}

function columnsFor(
  projectId: string,
  agents: readonly ListedAgent[],
  /** Null while the session read has not answered, so no control is drawn. */
  mayControl: boolean | null,
  onCancel: (runId: string) => void,
): readonly Column<RunRow>[] {
  return [
    {
      key: "run",
      header: "Run",
      primary: true,
      cell: (run) => (
        <Link href={projectPath(projectId, "runs", run.id)}>
          {run.label ?? ranAgainst(run, agents)}
        </Link>
      ),
    },
    {
      key: "started",
      header: "Started",
      mono: true,
      width: "170px",
      cell: (run) => asMoment(run.created_at),
    },
    {
      key: "status",
      header: "Status",
      width: "110px",
      cell: (run) => <RunStatus status={run.status} />,
    },
    {
      key: "simulations",
      header: "Simulations",
      hideOnMobile: true,
      width: "220px",
      cell: (run) => <SimulationTally counts={run.simulation_counts} />,
    },
    {
      key: "grading",
      header: "Grading",
      hideOnMobile: true,
      width: "120px",
      cell: (run) =>
        `${String(run.graded_count)} of ${String(run.gradable_count)} judged`,
    },
    {
      key: "verdict",
      header: "Verdict",
      width: "130px",
      cell: (run) => <VerdictBadge verdict={run.verdict} />,
    },
    {
      key: "stop",
      header: "",
      width: "100px",
      /*
       * Stopping a run without opening it.
       *
       * **The button opens a row and does nothing else.** What it opens is one
       * panel drawn under the table, where the run name, consequences and retry
       * stay together at every viewport size instead of being squeezed into an
       * action cell.
       *
       * A finished run has nothing to cancel, so it gets no control at all
       * rather than a disabled one: a disabled control here would read as a
       * broken feature on every row of a healthy history.
       */
      cell: (run) =>
        mayControl !== true || (run.status !== "pending" && run.status !== "running")
          ? ""
          : (
              <Button onClick={() => onCancel(run.id)}>Cancel</Button>
            ),
    },
  ];
}

function Runs({ projectId }: { readonly projectId: string }) {
  const { me } = useShellSession();
  // Null until the session read answers. A page that guessed would offer a
  // viewer a control the server refuses, on every load.
  const role = me === null ? null : roleOf(me);
  const mayStart = role !== null && canAuthor(role);

  const [agent, setAgent] = useState("");
  const [connection, setConnection] = useState("");
  const [status, setStatus] = useState<"" | RunStatusWord>("");
  const [verdict, setVerdict] = useState<"" | VerdictWord>("");
  /** The earliest day to show, as somebody typed it and as it was asked for. */
  const [typedSince, setTypedSince] = useState("");
  const [since, setSince] = useState("");

  const path = runsQuery({
    ...(agent === "" ? {} : { agent }),
    ...(connection === "" ? {} : { connection }),
    ...(status === "" ? {} : { status }),
    ...(verdict === "" ? {} : { verdict }),
    ...(since === "" ? {} : { since: `${since}T00:00:00.000Z` }),
  });

  const { answer, reload } = useProjectRead<RunHistoryPage>(path, projectId);
  const { answer: agents } = useProjectRead<AgentPage>(agentsQuery({}), projectId);

  /**
   * Pages fetched after the first, kept beside it — **and each one remembers
   * what it was fetched for.**
   *
   * Changing project or filter does not remount this page, so this state
   * outlives the change and a read still in flight comes back into a view that
   * has moved on. Carrying the question in the value means a page fetched for
   * another one can never be rendered here.
   */
  const [after, setAfter] = useState<{
    readonly asked: string;
    readonly project: string;
    readonly page: RunHistoryPage;
  } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreRefused, setMoreRefused] = useState<Refusal | null>(null);

  /**
   * Which row's Cancel panel is open, and the two things bound to that row.
   *
   * **The panel is drawn once, under the table.** That makes everything here
   * shared by every row, and each of these is a different way of showing
   * somebody the wrong run's answer:
   *
   * - `rowRefused` is a sentence about the run that failed. Left behind, it sits
   *   under a different run's name, and the name is the only thing on screen
   *   saying which run the panel is about.
   * - `retryCancel` is worse, because it survives the sentence being cleared.
   *   It names the run that failed, and pressing *Try again* cancels **that**
   *   run while the panel reports success under the run somebody is looking at
   *   — a stop nobody asked for, on a run nobody was watching.
   *
   * Clearing the first does not clear the second, which is exactly why they are
   * two pieces of state rather than one.
   */
  const [openRun, setOpenRun] = useState<string | null>(null);
  const [rowRefused, setRowRefused] = useState<string | null>(null);
  const [retryCancel, setRetryCancel] = useState<{ readonly runId: string } | null>(
    null,
  );
  const [stopping, setStopping] = useState(false);

  const carried =
    after !== null && after.project === projectId && after.asked === path
      ? after.page
      : null;

  /** Which project this view is showing, readable from inside an await. */
  const showing = useRef(projectId);

  useEffect(() => {
    showing.current = projectId;
    setAfter(null);
    setMoreRefused(null);
    setLoadingMore(false);
    setOpenRun(null);
    setRowRefused(null);
    setRetryCancel(null);
  }, [projectId]);

  /**
   * Stopping a run, and everything that can happen instead.
   *
   * The run being stopped is the argument rather than the open row, so a request
   * already in flight settles about the run it was made about however the panel
   * moves underneath it.
   */
  async function stop(runId: string): Promise<void> {
    if (stopping) return;
    setRowRefused(null);
    setStopping(true);

    // Named the one way every write in the product names it. See the same call
    // on the run's own page.
    const answered = await writeJson<RunRow>(runCancelPath(runId), {
      method: "POST",
      project: projectId,
    });

    setStopping(false);
    if (answered.status === "signed-out") {
      window.location.replace("/sign-in");
      return;
    }
    if (answered.status !== "ready") {
      setRowRefused(answered.refusal.message);
      // Bound to the run that failed, and cleared by whoever opens a different
      // row — never by whoever eventually answers.
      setRetryCancel({ runId });
      return;
    }
    setOpenRun(null);
    setRetryCancel(null);
    reload();
  }

  /**
   * Which row is open, and the two clears that go with the change.
   *
   * Two lines rather than one, and each is a defect of its own: a sentence left
   * behind is read as being about the run now named, and a *Try again* left
   * behind stops a run nobody is looking at.
   */
  function openCancel(runId: string): void {
    setRowRefused(null);
    setRetryCancel(null);
    setOpenRun((held) => (held === runId ? null : runId));
  }

  useEffect(() => {
    setAfter(null);
    setMoreRefused(null);
  }, [answer]);

  useEffect(() => {
    if (answer?.status === "signed-out") window.location.replace("/sign-in");
  }, [answer]);

  const agentRows = agents?.status === "ready" ? agents.value.items : [];
  const narrowed =
    agent !== "" || connection !== "" || status !== "" || verdict !== "" || since !== "";

  function plan() {
    return mayStart ? (
      <ButtonLink weight="strong" href={projectPath(projectId, "runs", "new")}>
        Create a run
      </ButtonLink>
    ) : undefined;
  }

  function body() {
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
              <ButtonLink href={projectLanding(elsewhere.id)}>
                Open {elsewhere.name}
              </ButtonLink>
            )
          }
        />
      );
    }

    if (answer.status === "failed") {
      return <Failure message={answer.refusal.message} onRetry={reload} />;
    }

    const items = [...answer.value.items, ...(carried?.items ?? [])];
    const cursor = carried === null ? answer.value.next_cursor : carried.next_cursor;
    const opened = items.find((run) => run.id === openRun);

    async function showMore(): Promise<void> {
      if (cursor === null) return;

      const asked = projectId;
      const question = path;
      setMoreRefused(null);
      setLoadingMore(true);

      const next = await readJson<RunHistoryPage>(
        `${question}${question.includes("?") ? "&" : "?"}cursor=${encodeURIComponent(cursor)}`,
        { project: asked },
      );

      setLoadingMore(false);
      if (showing.current !== asked) return;

      if (next.status === "signed-out") {
        window.location.replace("/sign-in");
        return;
      }
      if (next.status !== "ready") {
        setMoreRefused(next.refusal);
        return;
      }

      setAfter({
        project: asked,
        asked: question,
        page: {
          items: [...(carried?.items ?? []), ...next.value.items],
          next_cursor: next.value.next_cursor,
        },
      });
    }

    if (items.length === 0) {
      return (
        <>
          <Empty
            title={
              narrowed
                ? "No run here matches that"
                : "This project has not run anything yet"
            }
            lead={
              narrowed
                ? // A short filtered page is a real answer here rather than an
                  // oversight, and the control below says so: a verdict is
                  // folded at read time, so the server sweeps rather than
                  // filtering in the query.
                  "Clear the filters to see everything this project has run. A run that is still being judged has no verdict yet and matches no verdict filter."
                : "A run executes a selection of tests against one agent over one connection, and freezes exactly what it used."
            }
            action={
              narrowed ? (
                cursor === null ? undefined : (
                  // A verdict filter is applied to the fold rather than to the
                  // query, so the server sweeps a bounded number of runs and
                  // answers what matched. An empty page with a cursor on it
                  // means it swept and found none *here* — not that there are
                  // none — and the control says which.
                  <Button disabled={loadingMore} onClick={() => void showMore()}>
                    {loadingMore ? "Looking…" : "Keep looking"}
                  </Button>
                )
              ) : (
                plan()
              )
            }
          />
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
        <DataTable
          label="Runs in this project"
          columns={columnsFor(
            projectId,
            agentRows,
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
        {opened === undefined ? null : (
          <section className={styles.stopPanel} aria-label="Cancel this run">
            <h3 className={styles.stopTitle}>
              Cancel {opened.label ?? asMoment(opened.created_at)}?
            </h3>
            <p className={styles.stopLead}>
              Simulations still waiting stop here and now. Simulations
              already with a simulator are told to stop and land as canceled
              when they do, and whatever they produced stays on the record. A
              canceled run never becomes completed.
            </p>
            {/*
              The sentence and the retry are drawn separately, because they are
              separately owned. Hanging the retry off the sentence would make one
              clear hide the other — and the defect that matters is the one that
              survives: a *Try again* still bound to the run that failed, pressed
              under a different run's name, stops a run nobody is looking at.
            */}
            {rowRefused === null ? null : <Refused message={rowRefused} />}
            {retryCancel === null ? null : (
              <Actions>
                <Button
                  disabled={stopping}
                  onClick={() => void stop(retryCancel.runId)}
                >
                  Try again
                </Button>
              </Actions>
            )}
            <Actions>
              <Button onClick={() => setOpenRun(null)}>Keep running</Button>
              <Button
                weight="strong"
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

  const connections = new Map<string, string>();
  if (answer?.status === "ready") {
    for (const run of answer.value.items) {
      connections.set(
        run.connection_id,
        `${run.connection_type} · ${run.modality}${
          run.environment === null ? "" : ` · ${run.environment}`
        }`,
      );
    }
  }

  return (
    <ProductPage>
      <PageHeader
        eyebrow="Project"
        title="Runs"
        lead="Every execution of a selection of tests against one agent over one connection. Machinery and judgment are shown apart, because a run that finished is not the same as a run that went well."
        action={plan()}
      />
      <PageBody>
        <Toolbar>
          <Select
            id="runs-agent"
            value={agent}
            label="Show only runs against one agent"
            options={[
              { value: "", label: "Any agent" },
              ...agentRows.map((one) => ({ value: one.id, label: one.name })),
            ]}
            onChange={setAgent}
          />
          <Select
            id="runs-connection"
            value={connection}
            label="Show only runs over one connection"
            options={[
              { value: "", label: "Any connection" },
              ...[...connections].map(([id, label]) => ({ value: id, label })),
            ]}
            onChange={setConnection}
          />
          <Select
            id="runs-status"
            value={status}
            label="Show only runs whose machinery is in one state"
            options={[
              { value: "", label: "Any run state" },
              ...RUN_STATUS_WORDS.map((one) => ({ value: one, label: one })),
            ]}
            onChange={(one) => setStatus(one as "" | RunStatusWord)}
          />
          <Select
            id="runs-verdict"
            value={verdict}
            label="Show only runs with one verdict"
            options={[
              { value: "", label: "Any verdict" },
              ...VERDICT_WORDS.map((one) => ({ value: one, label: one })),
            ]}
            onChange={(one) => setVerdict(one as "" | VerdictWord)}
          />
          <TextInput
            id="runs-since"
            value={typedSince}
            label="Show only runs started on or after a day"
            placeholder="YYYY-MM-DD"
            onChange={setTypedSince}
            onKeyDown={(event) => {
              if (event.key === "Enter") setSince(typedSince);
              if (event.key === "Escape") {
                setTypedSince("");
                setSince("");
              }
            }}
          />
        </Toolbar>
        {body()}
      </PageBody>
    </ProductPage>
  );
}
