/**
 * The wizard's last step: start the run, show the first trace result, offer the
 * skill, and leave.
 *
 * **The wizard does not wait for the suite.** It waits until the first
 * completed trace has terminal grading and nothing more. That is the moment
 * the whole walk is timed against — a
 * developer who has watched egma find their voice agent, reach it and write
 * tests for it has still only been told things until a result is ready, and
 * then they have been shown one. Everything after that is the suite finishing,
 * which happens on the platform whether a terminal is open or not.
 *
 * So the follow keeps going in the background while the developer answers the
 * last question, and the counts in the exit line are the counts at the moment
 * the wizard closed. "Three of twelve results ready" is a true sentence and a
 * useful one; waiting nine more minutes to be able to say twelve of twelve
 * would be the wizard holding a terminal open for its own tidiness.
 *
 * The skill offer is here rather than anywhere else for the same reason it is
 * a question rather than a default: it is the only thing in the walk that
 * writes outside the repository, and it is asked when the developer has just
 * seen what egma is for and can decide whether they want more of it.
 *
 * **A stop from here is still this ending.** Once the run exists, every
 * promise the walk made has been kept — the tests are on egma and the suite is
 * going — so Ctrl-C over the run screen or the offer closes a window rather
 * than cancelling work, and the developer leaves with the address of a live
 * run in their scrollback. The counts are whatever they were at that moment.
 */

import {
  hydrateRun,
  startRun,
  type PlatformRun,
} from "../platform/runs.ts";
import type { SignedIn } from "../platform/signed-in.ts";
import { followRun, RunFollower } from "../run/follow.ts";
import type { RunView } from "../run/view.ts";
import {
  installEgmaSkill,
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

  const installed = await installEgmaSkill({ places, scope });
  ui.pushStatus(
    `${ACTION_MARK} ${installed.replaced ? "Replaced the Egma skill in" : "The Egma skill is in"} ${installed.file}`,
  );
  return {
    kind: "installed",
    scope: installed.scope,
    file: installed.file,
    drivenAgentName: places.name,
    replaced: installed.replaced,
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

  // The follow outlives this await on purpose. The developer is about to be
  // asked one more question, and the run is not going to stand still while
  // they think about it.
  const watching = new AbortController();
  const stopWatching = (): void => watching.abort();
  signal.addEventListener("abort", stopWatching, { once: true });

  let resultReady!: () => void;
  const firstResult = new Promise<void>((resolve) => {
    resultReady = resolve;
    // The simulator can finish one conversation between the run POST and the
    // first bounded simulation page. In that case hydration already carries
    // the first terminal grading state, so there is no new change to open
    // the offer below.
    if (follower.firstResult !== null) resolve();
  });

  const following = followRun({
    signedIn: options.signedIn,
    follower,
    signal: watching.signal,
    ...(options.everyMs === undefined ? {} : { everyMs: options.everyMs }),
    onChange: (change) => {
      ui.setRun(viewOf(follower));
      if (change.firstResult) resultReady();
    },
  })
    // A run that finished without a completed trace result, or one Egma stopped talking to,
    // must still let the wizard move on — otherwise the last question is never
    // asked and the developer is left watching a list that will not move.
    .catch((cause: unknown) => {
      // Not when the follow was stopped on purpose: that is the wizard closing,
      // and it is not news.
      if (!watching.signal.aborted) {
        ui.pushStatus(
          `${FAILURE_MARK} Egma stopped answering about this run: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }
      return "interrupted" as const;
    })
    .finally(() => resultReady());

  await untilAborted(firstResult, signal);

  // From here the walk has done what it set out to do, and it says so however
  // it ends. The tests are on egma, the run is live, and the screen the
  // developer is looking at says the suite carries on without this terminal —
  // so a stop here is them closing a window on work that is still going, and
  // not egma stopping short. Telling them egma stopped before the task
  // finished would be telling them something that did not happen, and leaving
  // the address out would leave them with a run and no way to open it.
  //
  // What a stop does change is that nothing is installed: before the question
  // it is never asked, and at the question an unanswered question is a skip.
  if (signal.aborted) {
    watching.abort();
    signal.removeEventListener("abort", stopWatching);
    await following;
    ui.setRun(viewOf(follower));
    const stopped = follower.progress;
    return {
      kind: "run-started",
      resultsUrl: follower.resultsUrl,
      resultsReady: stopped.gradingTerminal,
      total: stopped.total,
      // Never asked, so there is no answer to report.
      skill: { kind: "not-offered" },
    };
  }

  const places = skillPlacesFor(options.drivenAgentId, {
    repository: options.cwd,
    home: options.home,
  });
  // A coding agent whose skill convention egma does not know gets no offer.
  // Writing a file into a directory it may never read would be egma leaving
  // litter behind and calling it help.
  const skill: SkillOutcome =
    places === null ? { kind: "not-offered" } : await offerTheSkill(options, places);

  watching.abort();
  signal.removeEventListener("abort", stopWatching);
  await following;

  const progress = follower.progress;
  ui.setRun(viewOf(follower));

  return {
    kind: "run-started",
    resultsUrl: follower.resultsUrl,
    resultsReady: progress.gradingTerminal,
    total: progress.total,
    skill,
  };
}
