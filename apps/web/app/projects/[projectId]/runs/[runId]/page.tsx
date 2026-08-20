"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { readJson, writeJson, type Refusal } from "../../../../../lib/api.ts";
import { roleOf } from "../../../../../lib/me.ts";
import { projectPath } from "../../../../../lib/project-context.ts";
import { canAuthor } from "../../../../../lib/roles.ts";
import {
  runCancelPath,
  runEventsPath,
  runPath,
  type RunDetail,
  type RunEventFeed,
  type RunSimulation,
  type SimulationStatusWord,
  type VerdictWord,
} from "../../../../../lib/runs.ts";
import { simulationRerunPath } from "../../../../../lib/simulations.ts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { Actions, Section } from "../../../../../ui/section.tsx";
import { Field, Refused } from "../../../../../ui/form.tsx";
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
  RelativeInstant,
  useMinuteClock,
} from "../../../../../ui/relative-time.tsx";
import {
  GradingState,
  RunStatus,
  SimulationStatus,
  VerdictBadge,
} from "../../../../../ui/run-status.tsx";
import {
  AppShell,
  PageBody,
  PageHeader,
  ProductPage,
  useShellSession,
} from "../../../../../ui/shell.tsx";

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
 * read once for its fixed context, and everything that moves afterwards arrives
 * as numbered events, each applied at most once. That is what makes a tab left
 * open overnight correct rather than merely refreshed: a follower that misses a
 * poll asks again from the last number it applied and misses nothing.
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

/**
 * One fact in the run's overview: a quiet uppercase label over its value.
 *
 * The value takes the 14px table step whole — its line height and its letter
 * spacing included — rather than the 14px-with-body-leading the stylesheet
 * this replaces mixed by hand. That step is the one `DESIGN.md` names for
 * table and caption text, and taking it whole is what stops this page drifting
 * from every other 14px value in the product.
 */
const FACT = cn(
  "min-w-0 [&_dd]:min-w-0",
  "[&_dt]:mb-1 [&_dt]:text-xs [&_dt]:tracking-(--tracking-label)",
  "[&_dt]:text-faint [&_dt]:uppercase",
  "[&_dd]:m-0 [&_dd]:text-sm [&_dd]:text-foreground [&_dd]:[overflow-wrap:anywhere]",
  /* "Metrics, dates, durations, and scores use tabular numerals." */
  "[&_time]:tabular-nums",
);

/** A name and, where it applies, the note saying it has been archived. */
const IDENTITY = "inline-flex flex-wrap items-center gap-2";

/**
 * A cell that wraps instead of being cut off at one line.
 *
 * **This is what replaced a reach-in.** The route used to style the shared
 * table's own cell spans from its stylesheet — `.simulationsTable td > span`
 * — to turn off the ellipsis every list row gets. That rule reached past the
 * component's surface into its internals, and an unlayered route stylesheet
 * beats the component's own utilities, so the component could never take that
 * decision back. What a route legitimately owns is what it puts *in* a cell,
 * so the wrapping lives on this page's own element inside the cell instead.
 */
const WRAPS = "block min-w-0 whitespace-normal";

/**
 * Why a conversation never happened, or could not be conducted.
 *
 * It wraps rather than truncating. The whole value of this column is the
 * sentence, and half a sentence about a skip is how somebody comes to believe
 * their agent failed.
 */
const WHY = "block whitespace-normal text-sm text-muted-foreground";

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
  // viewer Cancel, which the server refuses, on every load.
  const role = me === null ? null : roleOf(me);
  const mayControl = role !== null && canAuthor(role);
  const now = useMinuteClock();

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

  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [refused, setRefused] = useState<Refusal | null>(null);
  const [working, setWorking] = useState(false);
  const [rerunSimulation, setRerunSimulation] =
    useState<RunSimulation | null>(null);
  const [rerunName, setRerunName] = useState("");
  const [rerunKey, setRerunKey] = useState<string | null>(null);
  const [rerunRefused, setRerunRefused] = useState<Refusal | null>(null);
  const [rerunWorking, setRerunWorking] = useState(false);

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
   * A refusal left behind sits under a different run's name. An open cancel
   * confirmation would be answered about the run now in the address, which is
   * not the run somebody opened it for.
   */
  useEffect(() => {
    setRefused(null);
    setConfirmingCancel(false);
    setRerunSimulation(null);
    setRerunName("");
    setRerunKey(null);
    setRerunRefused(null);
    setRerunWorking(false);
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
   * final state and folded verdict live in the compact header summary. The last
   * read turns "everything has landed" into the settled page.
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
    // The project named the one way every write in the product names it. Both
    // of this run's write doors used to read a body key only, so naming it in
    // the address was not read at all and the write narrowed to the session's
    // own project — the organization's first — and a run in any other project
    // answered "no such run" to a page that is looking straight at it.
    const answered = await writeJson<RunDetail>(runCancelPath(runId), {
      method: "POST",
      project: projectId,
    });
    setWorking(false);
    setConfirmingCancel(false);
    if (answered.status === "signed-out") {
      window.location.replace("/sign-in");
      return;
    }
    if (answered.status !== "ready") {
      setRefused(answered.refusal);
      return;
    }
    reload();
  }

  function openRerun(simulation: RunSimulation): void {
    setRerunSimulation(simulation);
    setRerunName("");
    setRerunKey(`run:${globalThis.crypto.randomUUID()}`);
    setRerunRefused(null);
  }

  function closeRerun(): void {
    if (rerunWorking) return;
    setRerunSimulation(null);
    setRerunName("");
    setRerunKey(null);
    setRerunRefused(null);
  }

  async function rerun(): Promise<void> {
    const label = rerunName.trim();
    if (
      !mayControl ||
      rerunSimulation === null ||
      rerunKey === null ||
      label === "" ||
      rerunWorking
    ) {
      return;
    }

    setRerunRefused(null);
    setRerunWorking(true);
    const answered = await writeJson<{ readonly id: string }>(
      simulationRerunPath(rerunSimulation.id),
      {
        method: "POST",
        project: projectId,
        body: { label, idempotency_key: rerunKey },
      },
    );
    setRerunWorking(false);
    if (answered.status === "signed-out") {
      window.location.replace("/sign-in");
      return;
    }
    if (answered.status !== "ready") {
      setRerunRefused(answered.refusal);
      return;
    }
    router.push(projectPath(projectId, "runs", answered.value.id));
  }

  if (answer === null || answer.status === "signed-out") {
    return (
      <ProductPage>
        <PageHeader
          eyebrow="Simulation runs"
          title="Run"
          breadcrumbs={[
            { label: "Runs", href: projectPath(projectId, "runs") },
            { label: "Run" },
          ]}
        />
        <PageBody>
          <Loading what="this run" />
        </PageBody>
      </ProductPage>
    );
  }

  if (answer.status === "missing") {
    return (
      <ProductPage>
        <PageHeader
          eyebrow="Simulation runs"
          title="Run"
          breadcrumbs={[
            { label: "Runs", href: projectPath(projectId, "runs") },
            { label: "Run" },
          ]}
        />
        <PageBody>
          <NotFound message={answer.refusal.message} />
        </PageBody>
      </ProductPage>
    );
  }

  if (answer.status === "failed") {
    return (
      <ProductPage>
        <PageHeader
          eyebrow="Simulation runs"
          title="Run"
          breadcrumbs={[
            { label: "Runs", href: projectPath(projectId, "runs") },
            { label: "Run" },
          ]}
        />
        <PageBody>
          <Failure message={answer.refusal.message} onRetry={reload} />
        </PageBody>
      </ProductPage>
    );
  }

  const read = answer.value;
  const displayTitle = read.label ?? read.agent?.name ?? "Run";
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

  const active = status === "pending" || status === "running";

  return (
    <ProductPage wide>
      <PageHeader
        eyebrow="Simulation runs"
        title={displayTitle}
        breadcrumbs={[
          { label: "Runs", href: projectPath(projectId, "runs") },
          { label: displayTitle },
        ]}
        action={
          !mayControl || !active ? undefined : (
            <Actions>
              <Button
                type="button"
                variant="secondary"
                disabled={working}
                onClick={() => setConfirmingCancel(true)}
              >
                Cancel run
              </Button>
            </Actions>
          )
        }
      />
      <PageBody>
        {refused === null ? null : <Refused message={refused.message} />}

        {/*
          The run's compact overview: the facts that do not move, in one
          block above the conversations that do.
        */}
        <section
          className="rounded-card border border-border bg-surface px-5 py-4 max-[900px]:p-4"
          role="group"
          aria-label="Run summary"
        >
          <dl className="m-0 grid grid-cols-[repeat(auto-fit,minmax(140px,1fr))] gap-x-6 gap-y-4">
            <div className={FACT}>
              <dt>Started</dt>
              <dd>
                <RelativeInstant instant={read.created_at} now={now} />
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
              </dd>
            </div>
            <div className={FACT}>
              <dt>Status</dt>
              <dd>
                <RunStatus status={status} compact />
              </dd>
            </div>
            <div className={FACT}>
              <dt>Grading</dt>
              <dd>
                {read.graded_count} of {read.gradable_count} judged
              </dd>
            </div>
            <div className={FACT}>
              <dt>Verdict</dt>
              <dd>
                <VerdictBadge verdict={read.verdict} compact />
              </dd>
            </div>
            <div className={FACT}>
              <dt>Agent</dt>
              <dd>
                {read.agent === null ? (
                  "Unavailable"
                ) : (
                  <span className={IDENTITY}>
                    <Link href={projectPath(projectId, "agents", read.agent.id)}>
                      {read.agent.name}
                    </Link>
                    {read.agent.archived ? (
                      <span className="text-sm text-warning">Archived</span>
                    ) : null}
                  </span>
                )}
              </dd>
            </div>
            <div className={FACT}>
              <dt>Connection</dt>
              <dd>
                <span className={IDENTITY}>
                  {read.connection === null ? (
                    "Unavailable"
                  ) : (
                    <Link
                      href={projectPath(
                        projectId,
                        "agents",
                        read.agent_id,
                        "connections",
                        read.connection.id,
                      )}
                    >
                      {read.connection.name}
                    </Link>
                  )}
                  {read.connection?.archived === true ? (
                    <span className="text-sm text-warning">Archived</span>
                  ) : null}
                </span>
              </dd>
            </div>
          </dl>
        </section>

        <Section title="Simulations">
          {simulations.length === 0 ? (
            <Empty
              title="No simulation has been written yet"
              lead="This run's simulations appear here as Egma writes them."
            />
          ) : (
            <DataTable
              label="Simulations in this run"
              columns={simulationColumns(
                projectId,
                runId,
                mayControl ? openRerun : undefined,
              )}
              rows={simulations}
              keyOf={(one) => one.id}
              stretchPrimaryLink
            />
          )}
        </Section>
      </PageBody>

      {confirmingCancel ? (
        <Dialog
          title={
            read.label === null
              ? "Cancel this run?"
              : `Cancel run “${read.label}”?`
          }
          onClose={() => setConfirmingCancel(false)}
        >
          {(dismiss) => (
            <>
              <p>
                Simulations still waiting stop here and now. Simulations already
                with a simulator are told to stop and land as canceled when they do,
                and whatever they produced stays on the record. A canceled run never
                becomes completed.
              </p>
              <Actions>
                {/*
                  `dismiss` is called rather than handed the click event, which
                  is what the control set this replaces did: it dropped the
                  event, so a pointer dismissal took the immediate path. Passing
                  the event would switch this dialog to the animated exit — a
                  change to how it behaves rather than to how it looks, and not
                  this ticket's to make.
                */}
                <Button type="button" variant="secondary" onClick={() => dismiss()}>
                  Keep running
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  disabled={working}
                  onClick={() => void cancel()}
                >
                  {working ? "Canceling…" : "Cancel run"}
                </Button>
              </Actions>
            </>
          )}
        </Dialog>
      ) : null}

      {rerunSimulation === null ? null : (
        <Dialog title="Run this simulation again?" onClose={closeRerun}>
          {(dismiss) => (
            <form
              className="flex flex-col gap-5 [&_p]:m-0 [&_p]:text-sm [&_p]:text-muted-foreground"
              onSubmit={(event) => {
                event.preventDefault();
                void rerun();
              }}
            >
              <p>
                This starts one new run under current conditions for this
                simulation. Egma uses the same agent, connection, test version,
                and persona. It then resolves the current persona version,
                graders, connection settings, and mock tools. The original
                evidence stays unchanged.
              </p>
              <Field label="Run name" htmlFor="rerun-name">
                <Input
                  id="rerun-name"
                  name="label"
                  type="text"
                  value={rerunName}
                  required
                  autoComplete="off"
                  spellCheck={false}
                  disabled={rerunWorking}
                  onChange={(event) => setRerunName(event.target.value)}
                />
              </Field>
              {rerunRefused === null ? null : (
                <Refused message={rerunRefused.message} />
              )}
              <Actions>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={rerunWorking}
                  onClick={() => dismiss()}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  busy={rerunWorking}
                  disabled={rerunName.trim() === ""}
                >
                  {rerunWorking ? "Starting…" : "Run again"}
                </Button>
              </Actions>
            </form>
          )}
        </Dialog>
      )}
    </ProductPage>
  );
}

/**
 * The columns one conversation's row is drawn with, in this project.
 *
 * A function of the project rather than a constant, because the first cell is
 * the way in to that conversation's evidence — and an address inside a project
 * has to name the project. The other cells stay compact so the table never needs
 * a horizontal scrollbar.
 */
function simulationColumns(
  projectId: string,
  runId: string,
  onRerun?: (simulation: RunSimulation) => void,
): readonly Column<RunSimulation>[] {
  const result: Column<RunSimulation>[] = [
    {
      key: "test",
      header: "Simulation",
      primary: true,
      cell: (one) => (
        <span className={cn(WRAPS, "flex items-start gap-3")}>
          <span className="flex-none tabular-nums text-sm text-muted-foreground">
            {String(one.position).padStart(2, "0")}
          </span>
          <span className="min-w-0 [&_a]:[overflow-wrap:anywhere] [&_strong]:block [&_strong]:font-medium [&_strong]:text-foreground [&_strong]:[overflow-wrap:anywhere]">
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
          </span>
        </span>
      ),
    },
    {
      key: "persona",
      header: "Persona",
      width: "22%",
      /* A name is a name: it wraps rather than ending in an ellipsis. */
      cell: (one) => <span className={WRAPS}>{one.persona_name}</span>,
    },
    {
      key: "status",
      header: "Execution",
      width: "18%",
      cell: (one) => (
        <span className={cn(WRAPS, "flex flex-col items-start gap-1")}>
          <SimulationStatus status={one.status} compact />
          <SimulationReason simulation={one} />
        </span>
      ),
    },
    {
      key: "grading",
      header: "Grading",
      width: "14%",
      cell: (one) => <GradingState grading={one.grading} compact />,
    },
    {
      key: "verdict",
      header: "Verdict",
      width: "14%",
      cell: (one) => <VerdictBadge verdict={one.verdict} compact />,
    },
  ];

  if (onRerun !== undefined) {
    result.push({
      key: "rerun",
      header: "",
      action: true,
      width: "128px",
      cell: (one) =>
        !isTerminalSimulation(one.status) ? null : (
          <Button
            type="button"
            variant="secondary"
            onClick={() => onRerun(one)}
          >
            Run again
          </Button>
        ),
    });
  }

  return result;
}

function isTerminalSimulation(status: SimulationStatusWord): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "canceled" ||
    status === "skipped"
  );
}

function SimulationReason({
  simulation,
}: {
  readonly simulation: RunSimulation;
}) {
  if (simulation.skip_reason !== null) {
    const capabilities = (simulation.skipped_capabilities ?? []).join(", ");
    const decision =
      simulation.skip_reason === "required_capability_unsupported"
        ? `This connection does not support ${capabilities}.`
        : `Support for ${capabilities} was not measured.`;
    return (
      <span className={WHY}>
        {decision} Egma did not conduct this simulation. This says nothing about
        the agent.
      </span>
    );
  }
  if (simulation.status !== "failed") return null;
  return (
    <span className={WHY}>
      {simulation.reason ?? "Egma could not conduct this simulation."} This is an
      execution problem, not a failed grader verdict, and says nothing about the
      agent.
    </span>
  );
}
