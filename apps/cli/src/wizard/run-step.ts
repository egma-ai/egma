/**
 * The wizard's last step: start the run, follow every simulation and grader to
 * a terminal state, offer the skills, and leave.
 *
 * A LiveKit testing walk starts the repository's worker on this machine. That
 * worker must remain registered while Egma dispatches every simulation, so the
 * wizard cannot leave after the first result. Waiting for the complete run also
 * makes the last screen literal: every row the developer sees has reached its
 * final execution and grading state before the local worker is stopped.
 *
 * The skill offer is here rather than anywhere else for the same reason it is
 * a question rather than a default: it is the only thing in the walk that
 * writes outside the repository, and it is asked when the developer has just
 * seen what egma is for and can decide whether they want more of it. What it
 * offers is every public Egma skill, and what writes them is the standard
 * skills installer that shipped inside this package.
 *
 * **A stop from here is still this ending.** Once the run exists, Ctrl-C closes
 * the local view; it does not cancel hosted work. The developer still leaves
 * with the run address and the counts reached before the stop.
 */

import {
  hydrateRun,
  startRun,
  type PlatformRun,
} from "../platform/runs.ts";
import type { SignedIn } from "../platform/signed-in.ts";
import { followRun, RunFollower } from "../run/follow.ts";
import type { RunView } from "../run/view.ts";
import type { LocalLiveKitWorker } from "../livekit/local-worker.ts";
import {
  installEgmaSkills,
  skillPlacesFor,
  type SkillPlaces,
  type SkillScope,
} from "../skills/install.ts";
import type { WizardUI } from "../ui/wizard-ui.ts";
import type { ExitReport, SkillOutcome } from "./exit-line.ts";
import { ACTION_MARK, DETAIL_MARK, FAILURE_MARK } from "./status.ts";
import { untilAborted } from "./stop.ts";

export type RunStepOptions = {
  readonly ui: WizardUI;
  readonly signedIn: SignedIn;
  /** What the run is against, as connect registered it. */
  readonly agentId: string;
  readonly connectionId: string;
  readonly suiteId: string;
  /** Exact transient precondition from the complete repository push. */
  readonly expectedTestVersions: readonly {
    readonly testId: string;
    readonly versionId: string;
  }[];
  /** Which coding agent the skill would be installed into. */
  readonly drivenAgentId: string;
  /** The repository, for the project scope. */
  readonly cwd: string;
  /** The developer's home, for the global scope. Passed in, never assumed. */
  readonly home: string;
  readonly signal: AbortSignal;
  /** A local worker whose unexpected exit makes this run unable to dispatch. */
  readonly localWorker?: LocalLiveKitWorker | undefined;
  /**
   * Which Egma this sitting also set production monitoring up on, or omitted
   * when it set none up.
   *
   * A sitting that did both ends with two promises kept, and a last screen that
   * named only the graded run would leave the developer to remember the other.
   */
  readonly monitoringUrl?: string | undefined;
  /** How long between asks while following. egma's own default when omitted. */
  readonly everyMs?: number;
};

function viewOf(follower: RunFollower): RunView {
  return {
    runId: follower.runId,
    rows: follower.rows,
    progress: follower.progress,
    firstResult: follower.firstResult,
    resultsUrl: follower.resultsUrl,
  };
}

/** The scope the developer named, or `null` for skip and for no answer. */
function scopeFrom(said: string | null | undefined): SkillScope | null {
  if (said === "project" || said === "global") return said;
  return null;
}

/**
 * The offer, and what came of it.
 *
 * Never silent in either direction: an install says which file it wrote, a
 * skip says that nothing was written, and both of those survive into the exit
 * notice — because the screen they were said on is thrown away.
 */
async function offerTheSkill(
  options: RunStepOptions,
  places: SkillPlaces,
): Promise<SkillOutcome> {
  const { ui, signal } = options;

  ui.setSkillPlaces(places);
  const said = await untilAborted(ui.waitForAnswer("skills-offer"), signal);
  ui.setSkillPlaces(null);

  const scope = scopeFrom(said ?? null);
  if (scope === null) {
    // Skip, or a wizard closed without answering. Both leave the machine
    // exactly as it was: no directory, no file, no marker.
    ui.pushStatus(`${ACTION_MARK} Nothing was installed.`);
    return { kind: "skipped", drivenAgentName: places.name };
  }

  const installed = await installEgmaSkills({ places, scope });
  if (installed.kind === "failed") {
    // An offer accepted and not kept says so. A developer who was told nothing
    // walks away believing their coding agent learned something it did not.
    ui.pushStatus(`${FAILURE_MARK} ${installed.reason}`);
    return { kind: "install-failed", reason: installed.reason };
  }
  for (const where of installed.landed) ui.pushStatus(`${ACTION_MARK} ${where}`);
  return {
    kind: "installed",
    scope: installed.scope,
    places,
    landed: installed.landed,
  };
}

/** Everything the run screen says while it is being started. */
function announce(ui: WizardUI, run: PlatformRun, tests: number): void {
  ui.pushStatus(
    `${ACTION_MARK} ${tests} ${tests === 1 ? "test" : "tests"} → ${run.expectedSimulationCount} ${run.expectedSimulationCount === 1 ? "simulation" : "simulations"}`,
  );
  ui.pushStatus(`${DETAIL_MARK} ${run.id}`);
}

export async function runStep(options: RunStepOptions): Promise<ExitReport> {
  const { ui, signal } = options;

  const answer = await startRun(options.signedIn, {
    suiteId: options.suiteId,
    agentId: options.agentId,
    connectionId: options.connectionId,
    expectedTestVersions: options.expectedTestVersions,
  });

  if (answer.kind === "refused") {
    // egma's own sentence, and only egma's. A connection type whose adapter
    // has not shipped is the case this exists for: the run can never happen,
    // egma said so at creation, and a wizard that softened that into "egma
    // could not start your run" would be hiding the one fact that tells the
    // developer what to do next.
    ui.pushStatus(`${FAILURE_MARK} ${answer.reason}`);
    return { kind: "failed", reason: answer.reason };
  }

  const run = await hydrateRun(options.signedIn, answer.run);
  const follower = new RunFollower(run);
  announce(ui, run, options.expectedTestVersions.length);
  ui.setRun(viewOf(follower));

  const watching = new AbortController();
  const stopWatching = (): void => watching.abort();
  signal.addEventListener("abort", stopWatching, { once: true });

  const following = followRun({
    signedIn: options.signedIn,
    follower,
    signal: watching.signal,
    ...(options.everyMs === undefined ? {} : { everyMs: options.everyMs }),
    onChange: () => {
      ui.setRun(viewOf(follower));
    },
  }).then(
    (ending) => ({ kind: "ended" as const, ending }),
    (cause: unknown) => {
      const reason = cause instanceof Error ? cause.message : String(cause);
      return { kind: "failed" as const, reason };
    },
  );

  // Keep the local view, and therefore any local LiveKit worker owned by the
  // caller, alive until every simulation and every requested grade is terminal.
  const completed = await untilAborted(
    options.localWorker === undefined
      ? following.then((result) => ({ kind: "run" as const, result }))
      : Promise.race([
          following.then((result) => ({ kind: "run" as const, result })),
          options.localWorker.ended.then((ending) => ({
            kind: "worker" as const,
            ending,
          })),
        ]),
    signal,
  );

  if (completed?.kind === "worker") {
    watching.abort();
    signal.removeEventListener("abort", stopWatching);
    await following;
    const reason =
      completed.ending.kind === "failed"
        ? completed.ending.reason
        : "The local LiveKit worker stopped before the Egma run finished.";
    ui.pushStatus(`${FAILURE_MARK} ${reason}`);
    return {
      kind: "failed",
      reason: `${reason} The hosted run is ${follower.resultsUrl}.`,
    };
  }

  // A stop changes only what can still happen in this terminal. Hosted work
  // continues, and no skill is installed because its question was never asked.
  if (signal.aborted) {
    watching.abort();
    signal.removeEventListener("abort", stopWatching);
    ui.setRun(viewOf(follower));
    const stopped = follower.progress;
    return {
      kind: "run-started",
      resultsUrl: follower.resultsUrl,
      resultsReady: stopped.gradingTerminal,
      total: stopped.total,
      // Never asked, so there is no answer to report.
      skill: { kind: "not-offered" },
      ...(options.monitoringUrl === undefined
        ? {}
        : { monitoringUrl: options.monitoringUrl }),
    };
  }

  if (completed?.kind !== "run") {
    watching.abort();
    signal.removeEventListener("abort", stopWatching);
    return {
      kind: "failed",
      reason:
        "Egma stopped answering before this run was complete: " +
        "the run follower ended without a result. " +
        `The hosted run is ${follower.resultsUrl}.`,
    };
  }
  if (completed.result.kind === "failed") {
    watching.abort();
    signal.removeEventListener("abort", stopWatching);
    return {
      kind: "failed",
      reason:
        `Egma stopped answering before this run was complete: ${completed.result.reason}. ` +
        `The hosted run is ${follower.resultsUrl}.`,
    };
  }
  if (completed.result.ending !== "finished") {
    watching.abort();
    signal.removeEventListener("abort", stopWatching);
    return {
      kind: "failed",
      reason:
        `Egma stopped following this run before it was complete. ` +
        `The hosted run is ${follower.resultsUrl}.`,
    };
  }

  watching.abort();
  signal.removeEventListener("abort", stopWatching);

  // Worker custody belongs only to run execution. Skill installation is a
  // separate optional question and must not keep credentials or a registered
  // worker alive while somebody considers it.
  await options.localWorker?.stop();

  const progress = follower.progress;
  ui.setRun(viewOf(follower));
  if (
    progress.executionFailed > 0 ||
    progress.executionCanceled > 0 ||
    progress.gradingErrors > 0
  ) {
    const reason =
      `The run finished with ${String(progress.executionFailed)} execution failures, ` +
      `${String(progress.executionCanceled)} canceled simulations, and ` +
      `${String(progress.gradingErrors)} grading errors. ` +
      `Review it at ${follower.resultsUrl}.`;
    ui.pushStatus(`${FAILURE_MARK} ${reason}`);
    return { kind: "failed", reason };
  }

  const places = skillPlacesFor(options.drivenAgentId, {
    repository: options.cwd,
    home: options.home,
  });
  // A coding agent the skills installer cannot name gets no offer. Aiming an
  // install at nobody would leave litter in somebody's repository and tell them
  // egma had helped.
  const skill: SkillOutcome =
    places === null ? { kind: "not-offered" } : await offerTheSkill(options, places);

  return {
    kind: "run-started",
    resultsUrl: follower.resultsUrl,
    resultsReady: progress.gradingTerminal,
    total: progress.total,
    skill,
    ...(options.monitoringUrl === undefined
      ? {}
      : { monitoringUrl: options.monitoringUrl }),
  };
}
