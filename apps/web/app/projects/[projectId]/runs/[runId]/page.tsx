"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  cancelRun,
  getRun,
  getTestVersion,
  listRunEvents,
  listRunSimulations,
} from "@egma/platform-api/client";

import type { Refusal } from "../../../../../lib/api.ts";
import { modalityLabel } from "../../../../../lib/agents.ts";
import { roleOf } from "../../../../../lib/me.ts";
import {
  platformAnswer,
  platformClient,
} from "../../../../../lib/platform-client.ts";
import { projectPath } from "../../../../../lib/project-context.ts";
import { canAuthor } from "../../../../../lib/roles.ts";
import {
  type RunDetail,
  type RunSimulation,
  type RunSimulationPage,
  type SimulationStatusWord,
  executionFailureMessage,
} from "../../../../../lib/runs.ts";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Actions } from "../../../../../ui/section.tsx";
import { Refused } from "../../../../../ui/form.tsx";
import { Dialog } from "../../../../../ui/dialog.tsx";
import {
  Empty,
  Failure,
  Loading,
  NotFound,
} from "../../../../../ui/page-state.tsx";
import { useProjectRead } from "../../../../../ui/resource.ts";
import { RunNote, type RunNoteTest } from "../../../../../ui/run-note.tsx";
import {
  RelativeInstant,
  useMinuteClock,
} from "../../../../../ui/relative-time.tsx";
import {
  RunStatus,
} from "../../../../../ui/run-status.tsx";
import {
  AppShell,
  PageBody,
  PageHeader,
  ProductPage,
  useShellSession,
} from "../../../../../ui/shell.tsx";
import { RunScenarioWorkbench } from "./run-scenario-workbench.tsx";

/**
 * One run: what it froze, what happened, and how far grading has got.
 *
 * Execution state and grading state stay separate. Grade scores belong to each
 * simulation trace. Egma does not create a run-level pass or fail result.
 *
 * **Execution follows the numbered feed.** Each event is applied at most once.
 * Duration and grading projections do not exist in that feed, so the bounded
 * simulation pages already opened are refreshed without changing their order or
 * the selected row. A follower that misses a poll still asks from the last event
 * number it applied and misses nothing.
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

/** A name and, where it applies, the note saying it has been archived. */
const IDENTITY = "inline-flex flex-wrap items-center gap-2";

/** A record value that is also a way into that record. */
const SUMMARY_LINK = cn(
  "text-foreground no-underline underline-offset-4",
  "pointer-hover:underline pointer-hover:decoration-brand focus-visible:underline",
);

/** What one conversation's row shows after the feed has moved it. */
type Moved = {
  readonly status: SimulationStatusWord;
  readonly reason: RunSimulation["reason"];
  readonly executionFailure: RunSimulation["executionFailure"];
};

type FailureToastCandidate = {
  readonly seq: number;
  readonly simulationId: string;
  readonly testName: string | null;
  readonly personaName: string | null;
  readonly reason: RunSimulation["reason"];
  readonly executionFailure: RunSimulation["executionFailure"];
};

function failureToastId(runId: string, seq: number): string {
  return `${runId}:${String(seq)}`;
}

function showFailureToast(runId: string, failure: FailureToastCandidate): void {
  const simulationName = [failure.testName, failure.personaName]
    .filter((name): name is string => name !== null)
    .join(" · ") || "Simulation";
  toast.error("Simulation execution failed", {
    id: failureToastId(runId, failure.seq),
    description:
      `${simulationName}: ${executionFailureMessage(
        failure.reason,
        failure.executionFailure,
      )}`,
  });
}

type LoadedSimulationPage = {
  readonly cursor: string;
  readonly value: RunSimulationPage;
};

/** How many pinned versions are read at once. Six is polite, not a limit. */
const TEST_VERSIONS_AT_ONCE = 6;

/**
 * Every test version this run's simulations pin, from every page of them.
 *
 * **The note reads the whole run, and the list on the page does not.** The
 * simulation list shows the first page and grows on the reader's own Load
 * more, which is right for a list. The note says "1 of 3 tests carry mock
 * tools" — a sentence with a denominator in it — so a note counted from the
 * rows that happen to be on screen would put a wrong number in front of
 * somebody quietly. It therefore walks the run's simulations to the end on its
 * own, whatever the list is showing.
 *
 * `null` while the pages are still on their way, and `null` for good if one of
 * them is refused: a run this page cannot count all of is a run it says
 * nothing about.
 */
function usePinnedVersionIds(
  projectId: string,
  runId: string,
  first: RunSimulationPage | null,
): readonly string[] | null {
  const [later, setLater] = useState<readonly string[] | null>(null);
  const firstToken = first?.nextPageToken ?? null;

  useEffect(() => {
    if (firstToken === null) {
      setLater([]);
      return undefined;
    }
    let live = true;
    setLater(null);
    /*
     * The read is its own function so the loop below cannot make the answer's
     * type depend on the cursor the answer sets — a `pageToken` narrowed by
     * the loop and written by the request is a circle TypeScript refuses to
     * walk.
     */
    const readPage = (pageToken: string) =>
      platformAnswer(
        listRunSimulations(
          { runId, projectId, pageToken },
          { client: platformClient },
        ),
      );
    void (async () => {
      const held: string[] = [];
      let pageToken: string | null = firstToken;
      // Every page there is, and no cap on how many.
      while (pageToken !== null) {
        const next = await readPage(pageToken);
        if (!live) return;
        // Left null, which is the note undrawn: a page nobody could read is a
        // denominator nobody can stand behind.
        if (next.status !== "ready") return;
        held.push(...next.value.simulations.map((one) => one.testVersionId));
        pageToken = next.value.nextPageToken;
      }
      if (!live) return;
      setLater(held);
    })();
    return () => {
      live = false;
    };
  }, [firstToken, projectId, runId]);

  if (first === null || later === null) return null;
  return [...first.simulations.map((one) => one.testVersionId), ...later];
}

/**
 * The test versions this run's simulations pinned, read once each.
 *
 * **A run's note reads the versions, never the tests.** A simulation is frozen
 * against the test as it was when the run started, so asking the test now would
 * describe a run by content it never carried. Nothing is stored: the versions
 * are read when the page is open and forgotten when it is closed.
 *
 * `null` until every version asked for has answered, so the note never counts
 * "2 of 3" on its way to counting twelve — and `null` when the ids themselves
 * are still being gathered. A version that is refused leaves the note undrawn
 * as well: dropping it would quietly shrink the very total the note reads out,
 * and a smaller number said with confidence is worse than nothing said.
 */
function usePinnedTestVersions(
  projectId: string,
  versionIds: readonly string[] | null,
): readonly RunNoteTest[] | null {
  const [read, setRead] = useState<ReadonlyMap<string, RunNoteTest | null>>(
    new Map(),
  );
  const asked = useRef<Set<string>>(new Set());
  /* The set as one string, so an effect re-runs on its contents, not its array. */
  const wanted =
    versionIds === null ? null : [...new Set(versionIds)].sort().join(",");

  /**
   * Whether this page is still open.
   *
   * **The reads are given up when the page closes, and never when the list of
   * versions grows.** A version is immutable, so an answer that lands after
   * another page of simulations has named more of them is still the right
   * answer for the id it was asked about. Dropping it would leave that id
   * asked for and never recorded, and the note — which waits for every id it
   * asked about — would wait for it for as long as the page is open.
   */
  const open = useRef(true);
  useEffect(() => {
    open.current = true;
    return () => {
      open.current = false;
    };
  }, []);

  useEffect(() => {
    if (wanted === null) return undefined;
    const ids = wanted === "" ? [] : wanted.split(",");
    const missing = ids.filter((id) => !asked.current.has(id));
    if (missing.length === 0) return undefined;
    for (const id of missing) asked.current.add(id);
    void (async () => {
      for (let at = 0; at < missing.length; at += TEST_VERSIONS_AT_ONCE) {
        const answers = await Promise.all(
          missing.slice(at, at + TEST_VERSIONS_AT_ONCE).map(async (versionId) => ({
            versionId,
            answer: await platformAnswer(
              getTestVersion({ versionId, projectId }, { client: platformClient }),
            ),
          })),
        );
        if (!open.current) return;
        setRead((held) => {
          const next = new Map(held);
          for (const { versionId, answer } of answers) {
            next.set(
              versionId,
              answer.status === "ready"
                ? { mockTools: answer.value.mockTools, env: answer.value.env }
                : null,
            );
          }
          return next;
        });
      }
    })();
    return undefined;
  }, [wanted, projectId]);

  if (wanted === null) return null;
  const ids = wanted === "" ? [] : wanted.split(",");
  if (ids.some((id) => !read.has(id))) return null;
  const versions = ids.map((id) => read.get(id) ?? null);
  if (versions.some((one) => one === null)) return null;
  return versions.filter((one): one is RunNoteTest => one !== null);
}

function RunDetailView({
  projectId,
  runId,
}: {
  readonly projectId: string;
  readonly runId: string;
}) {
  const { me } = useShellSession();
  // Null until the session read answers. A page that guessed would offer a
  // viewer Cancel, which the server refuses, on every load.
  const role = me === null ? null : roleOf(me);
  const mayControl = role !== null && canAuthor(role);
  const now = useMinuteClock();

  const { answer, reload, refresh: refreshRun } = useProjectRead<RunDetail>(
    (projectId) =>
      platformAnswer(
        getRun({ runId, projectId }, { client: platformClient }),
      ),
    projectId,
    runId,
  );
  const {
    answer: simulationPage,
    reload: reloadSimulations,
    refresh: refreshSimulations,
  } =
    useProjectRead<RunSimulationPage>(
      (projectId) =>
        platformAnswer(
          listRunSimulations(
            { runId, projectId },
            { client: platformClient },
          ),
        ),
      projectId,
      runId,
    );
  const [laterSimulationPages, setLaterSimulationPages] = useState<
    readonly LoadedSimulationPage[]
  >([]);
  const laterSimulationPagesRef = useRef(laterSimulationPages);
  laterSimulationPagesRef.current = laterSimulationPages;
  const simulationPageScope = `${projectId}\u0000${runId}`;
  const simulationPageScopeRef = useRef(simulationPageScope);
  simulationPageScopeRef.current = simulationPageScope;
  const refreshingSimulationPages = useRef(false);
  const [loadingMoreSimulations, setLoadingMoreSimulations] = useState(false);
  const [moreSimulationsRefused, setMoreSimulationsRefused] = useState<Refusal | null>(null);

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
  /** Last event already present when this page first observed the run. */
  const failureToastHistoryThrough = useRef<number | null>(null);
  /** Visible failure toasts that a later persistent selected message can replace. */
  const activeFailureToasts = useRef<FailureToastCandidate[]>([]);
  const initialSelectionReady = useRef(false);
  const [selectedSimulationId, setSelectedSimulationId] = useState<string | null>(null);
  const selectedSimulationIdRef = useRef<string | null>(null);
  const [finishedByFeed, setFinishedByFeed] = useState(false);

  const selectSimulation = useCallback((simulationId: string | null) => {
    selectedSimulationIdRef.current = simulationId;
    setSelectedSimulationId(simulationId);
  }, []);

  const showTrackedFailureToast = useCallback((failure: FailureToastCandidate) => {
    activeFailureToasts.current.push(failure);
    showFailureToast(runId, failure);
  }, [runId]);

  const dismissFailureToastsForSimulation = useCallback((simulationId: string) => {
    const kept: FailureToastCandidate[] = [];
    for (const failure of activeFailureToasts.current) {
      if (failure.simulationId === simulationId) {
        toast.dismiss(failureToastId(runId, failure.seq));
      } else {
        kept.push(failure);
      }
    }
    activeFailureToasts.current = kept;
  }, [runId]);

  const [confirmingCancel, setConfirmingCancel] = useState(false);
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
    failureToastHistoryThrough.current = null;
    activeFailureToasts.current = [];
    initialSelectionReady.current = false;
    selectedSimulationIdRef.current = null;
    setSelectedSimulationId(null);
    setMoved(new Map());
    setRunStatus(null);
    setFinishedByFeed(false);
    setLaterSimulationPages([]);
    setMoreSimulationsRefused(null);
    return () => {
      for (const failure of activeFailureToasts.current) {
        toast.dismiss(failureToastId(runId, failure.seq));
      }
      activeFailureToasts.current = [];
    };
  }, [runId, projectId]);

  /*
   * Lock history to the first run detail that makes this page visible. A quiet
   * detail refresh can finish while the first feed request is still waiting;
   * it must not move the boundary forward and hide a failure that happened
   * after the person opened the page.
   *
   * This effect is declared before the follower effect. React therefore locks
   * the boundary before this ready run can start its first feed request.
   */
  useEffect(() => {
    if (run !== null && failureToastHistoryThrough.current === null) {
      failureToastHistoryThrough.current = run.eventThrough;
    }
  }, [run]);

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
  }, [runId, projectId]);

  useEffect(() => {
    if (answer?.status === "signed-out" || simulationPage?.status === "signed-out") {
      window.location.replace("/sign-in");
    }
  }, [answer, simulationPage]);

  useEffect(() => {
    if (simulationPage?.status !== "ready" || initialSelectionReady.current) return;
    if (selectedSimulationIdRef.current === null) {
      selectSimulation(simulationPage.value.simulations[0]?.id ?? null);
    }
    initialSelectionReady.current = true;
  }, [runId, selectSimulation, simulationPage]);

  const stillMoving =
    run !== null &&
    !finishedByFeed &&
    (run.finishedAt === null ||
      run.gradedCount < run.gradableCount);

  const refreshLoadedSimulationPages = useCallback(async () => {
    refreshSimulations();
    const heldPages = laterSimulationPagesRef.current;
    const askedScope = simulationPageScope;
    if (heldPages.length === 0 || refreshingSimulationPages.current) {
      return;
    }
    refreshingSimulationPages.current = true;
    try {
      const refreshed = await Promise.all(
        heldPages.map(async (held) => ({
          cursor: held.cursor,
          answer: await platformAnswer(
            listRunSimulations(
              { runId, projectId, pageToken: held.cursor },
              { client: platformClient },
            ),
          ),
        })),
      );
      if (refreshed.some((held) => held.answer.status === "signed-out")) {
        window.location.replace("/sign-in");
        return;
      }
      if (simulationPageScopeRef.current !== askedScope) return;
      const ready = new Map(
        refreshed.flatMap((held) =>
          held.answer.status === "ready"
            ? [[held.cursor, held.answer.value] as const]
            : [],
        ),
      );
      setLaterSimulationPages((current) =>
        current.map((held) => ({
          cursor: held.cursor,
          value: ready.get(held.cursor) ?? held.value,
        })),
      );
    } finally {
      refreshingSimulationPages.current = false;
    }
  }, [projectId, runId, simulationPageScope, refreshSimulations]);

  /**
   * One page of the feed, applied.
   *
   * A page that carries nothing still advances nothing and costs one request;
   * `done` is the server's word that the run has finished and there will be no
   * more, and it is read *after* the events on that side so it can only ever be
   * one poll stale rather than one poll early.
   */
  const follow = useCallback(async (isCurrent: () => boolean) => {
    const asked = await platformAnswer(
      listRunEvents(
        { runId, projectId, after: applied.current },
        { client: platformClient },
      ),
    );
    if (!isCurrent()) return true;
    if (asked.status === "signed-out") {
      window.location.replace("/sign-in");
      return true;
    }
    // A feed that cannot be read is not a run that failed. The page keeps what
    // it has and asks again; the numbers it already applied are still right.
    if (asked.status !== "ready") return false;

    const { events, next, done } = asked.value;
    const historyThrough = failureToastHistoryThrough.current;
    // The ready run-detail effect above normally makes this impossible. If a
    // future refactor changes effect order, keep the page quiet and re-read the
    // same feed page instead of guessing which failures are historical.
    if (historyThrough === null) return false;

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
          if (event.kind !== "simulation") {
            continue;
          }
          now.set(event.simulationId, {
            status: event.status as SimulationStatusWord,
            reason: event.reason ?? null,
            executionFailure: event.executionFailure ?? null,
          });
        }
        return now;
      });
      for (const event of fresh) {
        if (event.kind === "run") setRunStatus(event.status);
        if (
          event.seq > historyThrough &&
          event.kind === "simulation" &&
          event.status === "failed"
        ) {
          const failure: FailureToastCandidate = {
            seq: event.seq,
            simulationId: event.simulationId,
            testName: event.testName,
            personaName: event.personaName,
            reason: event.reason,
            executionFailure: event.executionFailure,
          };
          if (!initialSelectionReady.current) {
            // Selection can be delayed, refused, or never answer. The failure
            // must still be visible now. Track it so the exact persistent
            // selected message can replace the toast after it is on screen.
            showTrackedFailureToast(failure);
          } else if (event.simulationId !== selectedSimulationIdRef.current) {
            showTrackedFailureToast(failure);
          }
        }
      }
      const terminalSimulationLanded = fresh.some(
        (event) =>
          event.kind === "simulation" &&
          ["completed", "failed", "canceled"].includes(event.status),
      );
      if (terminalSimulationLanded && !done) {
        /*
         * A feed event has execution state only. Re-read the bounded rows for
         * duration, grading state, and score. Every page already opened is read
         * again so a person stays on the same selected simulation.
         */
        await refreshLoadedSimulationPages();
        if (!isCurrent()) return true;
      }
    }

    if (done) setFinishedByFeed(true);
    return done;
  }, [projectId, runId, refreshLoadedSimulationPages, showTrackedFailureToast]);

  /**
   * The follower itself: one page, then another, while anything is moving.
   *
   * When the feed says the run has finished, the run is read once more. The
   * Events carry each conversation's execution state. The last read turns
   * "everything has landed" into the settled page.
   */
  useEffect(() => {
    if (run === null || !stillMoving) return undefined;

    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const again = async (): Promise<void> => {
      const done = await follow(() => !stopped);
      if (stopped) return;
      if (done) {
        refreshRun();
        await refreshLoadedSimulationPages();
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
  }, [run, stillMoving, follow, refreshRun, refreshLoadedSimulationPages]);

  /*
   * The numbered feed ends with execution. Grades can settle afterwards and do
   * not create feed events, so keep the run and its first bounded row page fresh
   * until every gradable simulation has a terminal grading state.
   */
  useEffect(() => {
    if (run === null || run.gradedCount >= run.gradableCount) return undefined;
    const timer = setInterval(() => {
      refreshRun();
      void refreshLoadedSimulationPages();
    }, AGAIN_MS);
    return () => clearInterval(timer);
  }, [run, refreshRun, refreshLoadedSimulationPages]);

  async function cancel(): Promise<void> {
    if (!mayControl || working) return;
    setRefused(null);
    setWorking(true);
    // The project named the one way every write in the product names it. Both
    // of this run's write doors used to read a body key only, so naming it in
    // the address was not read at all and the write narrowed to the session's
    // own project — the organization's first — and a run in any other project
    // answered "no such run" to a page that is looking straight at it.
    const answered = await platformAnswer(
      cancelRun(
        { runId, projectId },
        { client: platformClient },
      ),
    );
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
    await refreshLoadedSimulationPages();
  }

  async function loadMoreSimulations(cursor: string): Promise<void> {
    if (loadingMoreSimulations) return;
    setLoadingMoreSimulations(true);
    setMoreSimulationsRefused(null);
    const next = await platformAnswer(
      listRunSimulations(
        { runId, projectId, pageToken: cursor },
        { client: platformClient },
      ),
    );
    setLoadingMoreSimulations(false);
    if (next.status === "signed-out") {
      window.location.replace("/sign-in");
      return;
    }
    if (next.status !== "ready") {
      setMoreSimulationsRefused(next.refusal);
      return;
    }
    setLaterSimulationPages((held) => {
      const nextPage = { cursor, value: next.value };
      const existing = held.findIndex((page) => page.cursor === cursor);
      if (existing < 0) return [...held, nextPage];
      return held.map((page, at) => (at === existing ? nextPage : page));
    });
  }

  /*
   * The versions this run's rows pin, read before the page decides what to
   * draw — a hook cannot sit past an early return. Every page of simulations
   * is walked for them, not the pages the reader has asked the list for.
   */
  const pinnedVersionIds = usePinnedVersionIds(
    projectId,
    runId,
    simulationPage?.status === "ready" ? simulationPage.value : null,
  );
  const noteTests = usePinnedTestVersions(projectId, pinnedVersionIds);

  if (answer === null || answer.status === "signed-out") {
    return (
      <ProductPage>
        <PageHeader
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
  const suiteDisplay = `${read.suiteName}${read.suiteDeleted ? " (deleted)" : ""}`;
  const displayTitle = read.name ?? suiteDisplay;
  // The run's machinery as the feed last said, falling back to what the read
  // answered. A cancel that has landed says `canceled` here before the next read.
  const status = (runStatus ?? read.status) as RunDetail["status"];
  const loadedSimulations =
    simulationPage?.status === "ready"
      ? [
          ...simulationPage.value.simulations,
          ...laterSimulationPages.flatMap((page) => page.value.simulations),
        ]
      : [];
  const nextSimulationCursor =
    laterSimulationPages.at(-1)?.value.nextPageToken ??
    (simulationPage?.status === "ready" ? simulationPage.value.nextPageToken : null);
  const simulations = loadedSimulations.map((one) => {
    const change = moved.get(one.id);
    return change === undefined
      ? one
      : {
          ...one,
          status: change.status,
          reason: change.reason ?? one.reason,
          executionFailure:
            change.executionFailure ?? one.executionFailure,
        };
  });

  const active = status === "pending" || status === "running";

  return (
    <ProductPage wide desktopViewport>
      <PageHeader
        title={displayTitle}
        /*
         * The real trail: Runs, then this run. The last step is the page's own
         * heading, so it carries the run's name rather than the kind of record
         * this is — "Runs / Run" named nothing a person could tell apart.
         */
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
        <div className="min-w-0 min-[901px]:flex min-[901px]:h-full min-[901px]:min-h-0 min-[901px]:flex-col">
          {refused === null ? null : <Refused message={refused.message} />}

          {noteTests === null ? null : (
            <RunNote
              className="flex-none pb-4"
              connection={{
                connectionType: read.connectionType,
                accessVariant: read.accessVariant,
              }}
              tests={noteTests}
            />
          )}

          <dl
            className="m-0 grid flex-none grid-cols-5 gap-px border border-border bg-border max-[1000px]:grid-cols-2 max-[40rem]:grid-cols-1"
            role="group"
            aria-label="Run summary"
          >
            <div className="min-w-0 bg-surface px-5 py-3 max-[40rem]:px-4">
              <dt className="text-sm text-faint">Status</dt>
              <dd className="m-0 mt-1 min-w-0">
                <RunStatus status={status} />
              </dd>
            </div>
            <div className="min-w-0 bg-surface px-5 py-3 max-[40rem]:px-4">
              <dt className="text-sm text-faint">Started</dt>
              <dd className="m-0 mt-1 min-w-0 text-sm tabular-nums text-foreground">
                {read.startedAt === null ? (
                  <span className="text-faint">Not started</span>
                ) : (
                  <RelativeInstant instant={read.startedAt} now={now} />
                )}
              </dd>
            </div>
            <div className="min-w-0 bg-surface px-5 py-3 max-[40rem]:px-4">
              <dt className="text-sm text-faint">Test suite</dt>
              <dd className="m-0 mt-1 min-w-0 text-sm wrap-anywhere text-foreground">
                {read.suiteDeleted ? (
                  suiteDisplay
                ) : (
                  <Link
                    className={SUMMARY_LINK}
                    href={projectPath(projectId, "tests", "suites", read.suiteId)}
                  >
                    {suiteDisplay}
                  </Link>
                )}
              </dd>
            </div>
            <div className="min-w-0 bg-surface px-5 py-3 max-[40rem]:px-4">
              <dt className="text-sm text-faint">Agent</dt>
              <dd className="m-0 mt-1 min-w-0 text-sm wrap-anywhere text-foreground">
                {read.agent === null ? (
                  "Unavailable"
                ) : (
                  <span className={IDENTITY}>
                    <Link
                      className={SUMMARY_LINK}
                      href={projectPath(projectId, "agents", read.agent.id)}
                    >
                      {read.agent.name}
                    </Link>
                    {read.agent.archived ? (
                      <span className="text-sm text-warning">Archived</span>
                    ) : null}
                  </span>
                )}
              </dd>
            </div>
            <div className="min-w-0 bg-surface px-5 py-3 max-[40rem]:px-4">
              <dt className="text-sm text-faint">Connection</dt>
              <dd className="m-0 mt-1 min-w-0 text-sm wrap-anywhere text-foreground">
                <span className={IDENTITY}>
                  {read.connection === null ? (
                    "Unavailable"
                  ) : (
                    <>
                      <Link
                        className={SUMMARY_LINK}
                        href={projectPath(
                          projectId,
                          "agents",
                          read.agentId,
                          "connections",
                          read.connection.id,
                        )}
                      >
                        {read.connection.name}
                      </Link>
                      <span className="text-faint">
                        {modalityLabel(read.modality)}
                      </span>
                    </>
                  )}
                  {read.connection?.archived === true ? (
                    <span className="text-sm text-warning">Archived</span>
                  ) : null}
                </span>
              </dd>
            </div>
          </dl>

          <section
            className="mt-6 min-w-0 min-[901px]:flex min-[901px]:min-h-0 min-[901px]:flex-1 min-[901px]:flex-col"
            data-slot="section"
          >
          {simulationPage === null || simulationPage.status === "signed-out" ? (
            <Loading what="this run's simulations" />
          ) : simulationPage.status !== "ready" ? (
            <Failure message={simulationPage.refusal.message} onRetry={reloadSimulations} />
          ) : simulations.length === 0 ? (
            <Empty
              title="No simulation has been written yet"
              lead="This run's simulations appear here as Egma writes them."
            />
          ) : (
            <RunScenarioWorkbench
              projectId={projectId}
              runId={runId}
              rows={simulations}
              total={read.expectedSimulationCount}
              selectedId={selectedSimulationId}
              onSelect={selectSimulation}
              onExecutionFailureVisible={dismissFailureToastsForSimulation}
              {...(nextSimulationCursor === null
                ? {}
                : {
                    more: {
                      onMore: () => void loadMoreSimulations(nextSimulationCursor),
                      loading: loadingMoreSimulations,
                      note: "More simulations are available",
                    },
                  })}
            />
          )}
          {moreSimulationsRefused === null ? null : (
            <div className="mt-4">
              <Failure
                title="Egma could not load more simulations."
                message={moreSimulationsRefused.message}
                onRetry={
                  nextSimulationCursor === null
                    ? undefined
                    : () => void loadMoreSimulations(nextSimulationCursor)
                }
              />
            </div>
          )}
          </section>
        </div>
      </PageBody>

      {confirmingCancel ? (
        <Dialog
          title={
            read.name === null
              ? "Cancel this run?"
              : `Cancel run “${read.name}”?`
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

    </ProductPage>
  );
}
