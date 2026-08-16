"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { readJson, writeJson, type Refusal } from "../../../../../lib/api.ts";
import { asMoment } from "../../../../../lib/instants.ts";
import { roleOf } from "../../../../../lib/me.ts";
import { projectPath } from "../../../../../lib/project-context.ts";
import { canAuthor } from "../../../../../lib/roles.ts";
import {
  planExplanation,
  retryKeyFor,
  runCancelPath,
  runEventsPath,
  runPath,
  runRetryPath,
  RETRY_IS_NOT_A_REPLAY,
  type FrozenPlanGroup,
  type FrozenPlanItem,
  type RunDetail,
  type RunEventFeed,
  type RunSimulation,
  type SimulationStatusWord,
  type VerdictWord,
} from "../../../../../lib/runs.ts";
import {
  Actions,
  Badge,
  Button,
  ButtonLink,
  Facts,
  Help,
  Problem,
  Refused,
  Section,
} from "../../../../../ui/controls.tsx";
import { DataTable, type Column } from "../../../../../ui/data-table.tsx";
import { Dialog } from "../../../../../ui/dialog.tsx";
import {
  Empty,
  Failure,
  Loading,
  NotFound,
} from "../../../../../ui/page-state.tsx";
import { useProjectRead } from "../../../../../ui/resource.ts";
import {
  GradingState,
  RunFacts,
  RunProgress,
  shownScore,
  SimulationStatus,
  VerdictBadge,
  VerdictTally,
} from "../../../../../ui/run-status.tsx";
import {
  AppShell,
  PageBody,
  PageHeader,
  ProductPage,
  useShellSession,
} from "../../../../../ui/shell.tsx";
import styles from "./run.module.css";

/**
 * One run: what it froze, what happened, and what the graders made of it.
 *
 * **Four facts, kept apart, everywhere on this page.** The run's machinery, each
 * conversation's machinery, where the grading work stands, and the verdict. A
 * conversation egma declined to conduct is `skipped` and says nothing about the
 * agent. A conversation egma could not conduct is `failed` and is egma's own
 * problem, not the agent's. And a verdict nobody has reached yet is blank rather
 * than red — pending grading drawn as failure is the single worst thing a page
 * like this can do.
 *
 * **It follows the numbered feed rather than re-reading the run.** The run is
 * read once for its pins, its plan and its snapshots — the parts that never
 * change — and everything that moves afterwards arrives as numbered events, each
 * applied at most once. That is what makes a tab left open overnight correct
 * rather than merely refreshed: a follower that misses a poll asks again from the
 * last number it applied and misses nothing.
 */
export default function RunDetailPage() {
  const { projectId, runId } = useParams<{
    projectId: string;
    runId: string;
  }>();
  return (
    <AppShell>
      <RunDetailView projectId={projectId} runId={runId} />
    </AppShell>
  );
}

/** How often the feed is asked for more while anything is still moving. */
const AGAIN_MS = 2000;

/** What one conversation's row shows after the feed has moved it. */
type Moved = {
  readonly status: SimulationStatusWord;
  readonly verdict: VerdictWord | null;
  readonly reason: string | null;
};

function RunDetailView({
  projectId,
  runId,
}: {
  readonly projectId: string;
  readonly runId: string;
}) {
  const router = useRouter();
  const { me } = useShellSession();
  // Null until the session read answers. A page that guessed would offer a
  // viewer Cancel and Retry, which the server refuses, on every load.
  const role = me === null ? null : roleOf(me);
  const mayControl = role !== null && canAuthor(role);

  const { answer, reload } = useProjectRead<RunDetail>(runPath(runId), projectId);

  /**
   * What the feed has changed since the run was read, by conversation, plus the
   * run's own status.
   *
   * **Applied at most once each, by sequence number.** The feed is stateless and
   * answering the same `after` twice answers the same page twice, so the client's
   * half of the bargain is to remember what it has applied. That is what lets
   * this tab be closed, reopened, or left through a dropped connection and still
   * be right.
   */
  const [moved, setMoved] = useState<ReadonlyMap<string, Moved>>(new Map());
  const [runStatus, setRunStatus] = useState<string | null>(null);
  /** The last sequence number applied. The whole of the cursor. */
  const applied = useRef(0);
  const [finishedByFeed, setFinishedByFeed] = useState(false);

  const [canceling, setCanceling] = useState(false);
  const [confirming, setConfirming] = useState<"cancel" | "retry" | null>(null);
  const [refused, setRefused] = useState<Refusal | null>(null);
  const [working, setWorking] = useState(false);

  const run = answer?.status === "ready" ? answer.value : null;

  /**
   * A different run in the same page: what the feed accumulated belongs to the
   * run it was read for, so all of it goes.
   *
   * Left behind, one run's landings would be applied to another run's
   * conversation rows — and the sequence numbers would be wrong too, so the new
   * run's own early events would be silently skipped as already applied.
   */
  useEffect(() => {
    applied.current = 0;
    setMoved(new Map());
    setRunStatus(null);
    setFinishedByFeed(false);
  }, [runId, projectId]);

  /**
   * And the pending failure and the open control, which are a **separate**
   * clear.
   *
   * Clearing the feed does not clear these, and each survives the other's fix.
   * A refusal left behind sits under a different run's name — and worse, a
   * `Cancel run` or `Retry` confirmation left open would be answered about the
   * run now in the address, which is not the run somebody opened it for.
   */
  useEffect(() => {
    setRefused(null);
    setConfirming(null);
    setCanceling(false);
  }, [runId, projectId]);

  useEffect(() => {
    if (answer?.status === "signed-out") window.location.replace("/sign-in");
  }, [answer]);

  const stillMoving =
    run !== null &&
    !finishedByFeed &&
    (run.finished_at === null ||
      run.graded_count < run.gradable_count ||
      run.simulations.some((one) => one.grading === "pending"));

  /**
   * One page of the feed, applied.
   *
   * A page that carries nothing still advances nothing and costs one request;
   * `done` is the server's word that the run has finished and there will be no
   * more, and it is read *after* the events on that side so it can only ever be
   * one poll stale rather than one poll early.
   */
  const follow = useCallback(async () => {
    const asked = await readJson<RunEventFeed>(
      `${runEventsPath(runId)}?after=${String(applied.current)}`,
      { project: projectId },
    );
    if (asked.status === "signed-out") {
      window.location.replace("/sign-in");
      return true;
    }
    // A feed that cannot be read is not a run that failed. The page keeps what
    // it has and asks again; the numbers it already applied are still right.
    if (asked.status !== "ready") return false;

    const { events, next, done } = asked.value;

    /*
     * **Which events are new is decided here, once, and never inside a state
     * updater.** A `setState` callback runs at render rather than at the moment
     * it is handed over, so an updater reading `applied.current` would read it
     * *after* the line below moved it on — and would then skip every event it
     * had just been given as one it had already applied. The cursor is read into
     * a local, the events are filtered against that local, and only then does
     * the ref move.
     */
    const from = applied.current;
    const fresh = events.filter((event) => event.seq > from);
    applied.current = Math.max(from, next);

    if (fresh.length > 0) {
      setMoved((held) => {
        const now = new Map(held);
        for (const event of fresh) {
          if (event.kind !== "simulation" || event.simulation_id === undefined) {
            continue;
          }
          now.set(event.simulation_id, {
            status: event.status as SimulationStatusWord,
            verdict: event.verdict ?? null,
            reason: event.reason ?? null,
          });
        }
        return now;
      });
      for (const event of fresh) {
        if (event.kind === "run") setRunStatus(event.status);
      }
    }

    if (done) setFinishedByFeed(true);
    return done;
  }, [projectId, runId]);

  /**
   * The follower itself: one page, then another, while anything is moving.
   *
   * When the feed says the run has finished, the run is read once more. The
   * events carry each conversation's landing and its verdict, and the run's own
   * final counts and folded verdict live on the header — so the last read is what
   * turns "everything has landed" into the settled page.
   */
  useEffect(() => {
    if (run === null || !stillMoving) return undefined;

    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const again = async (): Promise<void> => {
      const done = await follow();
      if (stopped) return;
      if (done) {
        reload();
        return;
      }
      timer = setTimeout(() => void again(), AGAIN_MS);
    };

    void again();
    return () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    };
    // `run` is in the list so that a reload restarts the follower against the
    // freshly-read run rather than leaving it following the old one.
  }, [run, stillMoving, follow, reload]);

  async function cancel(): Promise<void> {
    if (!mayControl || working) return;
    setRefused(null);
    setWorking(true);
    const answered = await writeJson<RunDetail>(runCancelPath(runId), {
      method: "POST",
      project: projectId,
      body: {},
    });
    setWorking(false);
    setConfirming(null);
    if (answered.status === "signed-out") {
      window.location.replace("/sign-in");
      return;
    }
    if (answered.status !== "ready") {
      setRefused(answered.refusal);
      return;
    }
    setCanceling(true);
    reload();
  }

  async function retry(): Promise<void> {
    if (!mayControl || working) return;
    setRefused(null);
    setWorking(true);
    const answered = await writeJson<RunDetail>(runRetryPath(runId), {
      method: "POST",
      project: projectId,
      // **One key per run retried**, so a lost answer becomes the run that
      // already exists rather than a second conversation with a real agent.
      body: { idempotency_key: retryKeyFor(runId) },
    });
    setWorking(false);
    setConfirming(null);
    if (answered.status === "signed-out") {
      window.location.replace("/sign-in");
      return;
    }
    if (answered.status !== "ready") {
      setRefused(answered.refusal);
      return;
    }
    router.push(projectPath(projectId, "runs", answered.value.id));
  }

  if (answer === null || answer.status === "signed-out") {
    return (
      <ProductPage>
        <PageHeader eyebrow="Runs" title="Run" />
        <PageBody>
          <Loading what="this run" />
        </PageBody>
      </ProductPage>
    );
  }

  if (answer.status === "missing") {
    return (
      <ProductPage>
        <PageHeader eyebrow="Runs" title="Run" />
        <PageBody>
          <NotFound
            message={answer.refusal.message}
            action={
              <ButtonLink href={projectPath(projectId, "runs")}>
                All runs
              </ButtonLink>
            }
          />
        </PageBody>
      </ProductPage>
    );
  }

  if (answer.status === "failed") {
    return (
      <ProductPage>
        <PageHeader eyebrow="Runs" title="Run" />
        <PageBody>
          <Failure message={answer.refusal.message} onRetry={reload} />
        </PageBody>
      </ProductPage>
    );
  }

  const read = answer.value;
  // The run's machinery as the feed last said, falling back to what the read
  // answered. A cancel that has landed says `canceled` here before the next read.
  const status = (runStatus ?? read.status) as RunDetail["status"];
  const simulations = read.simulations.map((one) => {
    const change = moved.get(one.id);
    return change === undefined
      ? one
      : {
          ...one,
          status: change.status,
          verdict: change.verdict ?? one.verdict,
          reason: change.reason ?? one.reason,
        };
  });

  const finished = simulations.filter((one) =>
    ["completed", "failed", "canceled", "skipped"].includes(one.status),
  ).length;

  const active = status === "pending" || status === "running";
  const whyNoControl =
    role === null
      ? ""
      : `Your ${String(role)} role cannot start or stop runs. Ask an organization admin to change your role.`;

  return (
    <ProductPage wide>
      <PageHeader
        eyebrow="Runs"
        title={read.label ?? "Run"}
        lead={
          <>
            Started {asMoment(read.created_at)}
            {read.retry_of_run_id === null ? null : (
              <>
                {" · retry of "}
                <Link
                  href={projectPath(projectId, "runs", read.retry_of_run_id)}
                >
                  the earlier run
                </Link>
              </>
            )}
          </>
        }
        action={
          <Actions>
            <ButtonLink href={projectPath(projectId, "runs")}>
              All runs
            </ButtonLink>
            {/*
              **A viewer gets no Cancel and no Retry at all**, rather than
              disabled ones. Everything on this page is theirs to read — the
              progress, the pins, the archived references, and the sentence
              below saying what a Retry would do — and neither of these two
              controls is. A disabled control would be a permanent reminder of
              something they cannot have on a page whose whole subject they can.
            */}
            {!mayControl ? null : (
              <>
                <Button
                  disabled={!active || working}
                  why={
                    active
                      ? undefined
                      : "This run has already finished. Its counts are final."
                  }
                  onClick={() => setConfirming("cancel")}
                >
                  Cancel run
                </Button>
                <Button
                  weight="strong"
                  disabled={working}
                  onClick={() => setConfirming("retry")}
                >
                  Retry
                </Button>
              </>
            )}
          </Actions>
        }
      />
      <PageBody>
        {refused === null ? null : (
          <Refused
            message={refused.message}
            action={
              // A refused Retry names a resource and sends somebody to the
              // builder, which is exactly where the choice is theirs to make.
              refused.error === "retry_unavailable" ? (
                <ButtonLink href={projectPath(projectId, "runs", "new")}>
                  Open the run builder
                </ButtonLink>
              ) : undefined
            }
          />
        )}

        {canceling && status === "canceled" ? (
          <Problem>
            This run was canceled. Simulations that were already with a
            simulator finish honoring the cancellation, so the final counts land
            when the last of them does. A later report cannot make this run
            completed.
          </Problem>
        ) : null}

        {role === null || mayControl ? null : (
          <Problem>{whyNoControl}</Problem>
        )}

        <RunFacts
          status={status}
          finished={finished}
          expected={read.expected_simulation_count}
          graded={read.graded_count}
          gradable={read.gradable_count}
          verdict={read.verdict}
        />
        <RunProgress
          finished={finished}
          expected={read.expected_simulation_count}
        />

        {stillMoving ? (
          <p className={styles.following}>
            Updating as simulations finish and verdicts arrive.
          </p>
        ) : null}

        <Section
          title="Simulations"
          lead="One per test per persona. Each row keeps its machinery, its grading state and its verdict apart."
        >
          {simulations.length === 0 ? (
            <Empty
              title="No simulation has been written yet"
              lead="This run's simulations appear here as egma writes them."
            />
          ) : (
            <DataTable
              label="Simulations in this run"
              columns={simulationColumns(projectId, runId)}
              rows={simulations}
              keyOf={(one) => one.id}
            />
          )}
        </Section>

        <Section
          title="What this run was against"
          lead="The agent and the connection as they now stand, and the connection exactly as this run went over it. Both stay readable after either is archived."
        >
          <Facts
            facts={[
              {
                label: "Agent",
                value:
                  read.agent === null ? (
                    <code>{read.agent_id}</code>
                  ) : (
                    <span className={styles.identity}>
                      <Link
                        href={projectPath(projectId, "agents", read.agent.id)}
                      >
                        {read.agent.name}
                      </Link>
                      {read.agent.archived ? <Badge tone="warn">Archived</Badge> : null}
                    </span>
                  ),
              },
              {
                label: "Connection",
                value:
                  read.connection === null ? (
                    <code>{read.connection_id}</code>
                  ) : (
                    <span className={styles.identity}>
                      {read.connection.name}
                      {read.connection.archived ? (
                        <Badge tone="warn">Archived</Badge>
                      ) : null}
                    </span>
                  ),
              },
              {
                label: "Transport",
                value: (
                  <code>
                    {read.connection_snapshot.type} ·{" "}
                    {read.connection_snapshot.modality} ·{" "}
                    {read.connection_snapshot.topology}
                  </code>
                ),
              },
              {
                label: "Environment",
                value: (
                  <code>{read.connection_snapshot.environment ?? "none"}</code>
                ),
              },
              {
                label: "Mock Tools",
                value: mockToolsLine(read),
              },
              { label: "Run identifier", value: <code>{read.id}</code> },
              {
                label: "Finished",
                value: (
                  <code>
                    {read.finished_at === null
                      ? "not finished"
                      : asMoment(read.finished_at)}
                  </code>
                ),
              },
            ]}
          />
        </Section>

        <GradingPlanSection projectId={projectId} run={read} />

        <Section
          title="Running this again"
          lead="What Retry would do — readable whether or not this role may press it."
        >
          {/*
            The same sentence the confirmation shows, on the page as well. A
            viewer has to be able to read what a Retry means without being
            offered one, and somebody deciding whether to press it should not
            have to press it to find out.
          */}
          <Help>{RETRY_IS_NOT_A_REPLAY}</Help>
        </Section>
      </PageBody>

      {confirming === "cancel" ? (
        <Dialog title="Cancel this run?" onClose={() => setConfirming(null)}>
          <p>
            Simulations still waiting stop here and now. Simulations already
            with a simulator are told to stop and land as canceled when they do,
            and whatever they produced stays on the record. A canceled run never
            becomes completed.
          </p>
          <Actions>
            <Button onClick={() => setConfirming(null)}>Keep running</Button>
            <Button weight="strong" disabled={working} onClick={() => void cancel()}>
              {working ? "Canceling…" : "Cancel run"}
            </Button>
          </Actions>
        </Dialog>
      ) : null}

      {confirming === "retry" ? (
        <Dialog title="Retry this run?" onClose={() => setConfirming(null)}>
          <p>{RETRY_IS_NOT_A_REPLAY}</p>
          <Actions>
            <Button onClick={() => setConfirming(null)}>Not now</Button>
            <Button weight="strong" disabled={working} onClick={() => void retry()}>
              {working ? "Starting…" : "Start the retry"}
            </Button>
          </Actions>
        </Dialog>
      ) : null}
    </ProductPage>
  );
}

/** What the frozen mocked world comes to, said in one line. */
function mockToolsLine(run: RunDetail): string {
  const defaults = run.mock_tools.defaults.length;
  const overridden = Object.values(run.mock_tools.overrides).reduce(
    (total, entries) => total + entries.length,
    0,
  );
  if (defaults === 0 && overridden === 0) return "Nothing was mocked";
  return `${String(defaults)} project default${defaults === 1 ? "" : "s"}, ${String(overridden)} test override${overridden === 1 ? "" : "s"}`;
}

/**
 * The columns one conversation's row is drawn with, in this project.
 *
 * A function of the project rather than a constant, because the first cell is
 * now the way in to that conversation's evidence — and an address inside a
 * project has to name the project. Nothing else about a row moved.
 */
function simulationColumns(
  projectId: string,
  runId: string,
): readonly Column<RunSimulation>[] {
  return [
    {
      key: "test",
      header: "Simulation",
      primary: true,
      cell: (one) => (
        <span className={styles.conversation}>
          <span className={styles.position}>
            {String(one.position).padStart(2, "0")}
          </span>
          <span>
            {/*
              The way in to this conversation's own evidence: what was said, when
              each thing happened, what judged it and any later human correction.
              It is reached from here and from nowhere else — a conversation is a
              thing inside a run rather than a product area, so it is deliberately
              absent from the navigation.
            */}
            <Link
              href={projectPath(projectId, "runs", runId, "simulations", one.id)}
            >
              <strong>{one.test_name ?? "No stored test"}</strong>
            </Link>
            <small>{one.persona_name}</small>
            {/*
              The exact frozen versions this conversation executed, beside the two
              names. The names read as they stand today — a test renamed this
              morning reads under its new name everywhere at once — and these do
              not move, which is what makes the evidence still interpretable.
            */}
            <small className={styles.pins}>
              {one.test_version_id ?? "no test pinned"} ·{" "}
              {one.persona_version_id}
            </small>
          </span>
        </span>
      ),
    },
    {
      key: "status",
      header: "Status",
      width: "120px",
      cell: (one) => <SimulationStatus status={one.status} />,
    },
    {
      key: "grading",
      header: "Grading",
      width: "110px",
      cell: (one) => <GradingState grading={one.grading} />,
    },
    {
      key: "verdict",
      header: "Verdict",
      width: "130px",
      cell: (one) => <VerdictBadge verdict={one.verdict} />,
    },
    {
      key: "checks",
      header: "Checks",
      width: "160px",
      cell: (one) => <VerdictTally counts={one.counts} />,
    },
    {
      key: "score",
      header: "Score",
      mono: true,
      width: "70px",
      cell: (one) => shownScore(one.score),
    },
    {
      key: "why",
      header: "Why",
      width: "220px",
      // The one place a page says why a conversation never happened or could not
      // be conducted. It is deliberately its own column rather than being folded
      // into the status: `skipped` says egma declined, and this says what it
      // declined over.
      cell: (one) =>
        one.skip_reason !== null ? (
          <span className={styles.why}>
            {one.skip_reason === "required_capability_unsupported"
              ? `This connection was measured and does not support ${(one.skipped_capabilities ?? []).join(", ")}. Egma conducted nothing and says nothing about the agent.`
              : `Nobody has measured whether this connection supports ${(one.skipped_capabilities ?? []).join(", ")}. Egma conducted nothing and says nothing about the agent.`}
          </span>
        ) : one.status === "failed" ? (
          <span className={styles.why}>
            {one.reason ?? "Egma could not conduct this simulation."} This is an
            execution problem, not a failed grader verdict.
          </span>
        ) : (
          ""
        ),
    },
  ];
}

/**
 * What this run froze to judge itself by.
 *
 * **The state comes first, because it decides how much of the rest can be
 * believed.** A plan captured during an upgrade was not decided when the run
 * began and this says so; a run that recorded none says that too, and nothing
 * here reconstructs one out of today's graders — a reconstructed plan would be a
 * claim about an old run that nobody can check.
 */
function GradingPlanSection({
  projectId,
  run,
}: {
  readonly projectId: string;
  readonly run: RunDetail;
}) {
  const plan = run.grading_plan;
  return (
    <Section
      title="What judged this run"
      lead={
        plan === null
          ? "This run has no recorded grading plan."
          : planExplanation(plan.state)
      }
    >
      {plan === null || plan.groups.length === 0 ? (
        <Empty
          title="No grading plan was recorded"
          lead="Egma will not reconstruct one from today's graders, because that would be a claim about this run that nobody can check."
        />
      ) : (
        <div className={styles.plan}>
          {plan.groups.map((group) => (
            <PlanGroup
              key={group.tag === "version" ? group.test_version_id : "testless"}
              group={group}
              projectId={projectId}
            />
          ))}
        </div>
      )}
    </Section>
  );
}

function PlanGroup({
  group,
  projectId,
}: {
  readonly group: FrozenPlanGroup;
  readonly projectId: string;
}) {
  return (
    <article className={styles.planGroup}>
      <header className={styles.planHead}>
        {group.tag === "version" ? (
          <>
            <Link href={projectPath(projectId, "tests", group.test_id)}>
              {group.test_name}
            </Link>
            {/* The exact frozen version, which is what actually executed. */}
            <code>{group.test_version_id}</code>
          </>
        ) : (
          <strong>
            Simulations that executed no stored test
          </strong>
        )}
      </header>
      <ul className={styles.planItems}>
        {group.items.map((item) => (
          <PlanItemLine key={itemKey(item)} item={item} />
        ))}
      </ul>
    </article>
  );
}

function itemKey(item: FrozenPlanItem): string {
  return `${item.grader_id}:${item.grader_version_id}`;
}

function PlanItemLine({ item }: { readonly item: FrozenPlanItem }) {
  const judge =
    item.judge.tag === "configured"
      ? `${item.judge.provider}/${item.judge.model} · ${item.judge.source === "platform" ? "platform key" : `credential ${item.judge.source}`}`
      : item.judge.tag === "not_required"
        ? "no judge needed"
        : "no judge recorded at capture";

  return (
    <li className={styles.planItem}>
      <span className={styles.planItemName}>{item.name}</span>
      <span className={styles.planItemNote}>
        {/*
          What it is and how loudly it speaks. `required: false` is a
          diagnostic — judged and shown, and never able to fail this run — and
          saying so here is what keeps a red line on this list from being read
          as the reason the run failed.
        */}
        {`${item.required ? "blocks" : "reports only"} · ${item.grader_version_id} · ${judge}`}
      </span>
    </li>
  );
}
