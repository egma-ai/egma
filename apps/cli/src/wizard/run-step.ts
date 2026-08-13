/**
 * The wizard's last step: start the run, show the first verdicts, offer the
 * skill, and leave.
 *
 * **The wizard waits for the suite, and `--no-wait` is how it does not.**
 * Somebody who started a suite is watching it, and a screen taken away at the
 * first verdict is taken away at the part they came for. The suite is small by
 * construction — a first one is four conversations, sized so they run at once —
 * so waiting is a couple of minutes rather than the ten a dozen tests would
 * have cost, which is what made leaving early the right default before.
 *
 * Either way the follow keeps going in the background while the developer
 * answers the last question, and the run carries on on the platform whether a
 * terminal is open or not.
 *
 * **The counts in the exit line come off the document the files were written
 * from, not off the follower.** Execution and grading settle separately: the
 * follow ends when the run finishes and verdicts land after that, so the
 * follower's own count is stale by the time there is anything to say. Reporting
 * it would have the wizard close on "none graded yet" directly above the path
 * of a summary holding every verdict.
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

import { folderPathsIn } from "../folder/egma-folder.ts";
import {
  startRun,
  type PlatformRun,
} from "../platform/runs.ts";
import type { SignedIn } from "../platform/signed-in.ts";
import { captureRun, type CapturedTally } from "../run/artifacts.ts";
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
  /** The versions the push just put on egma. Exactly what this run pins. */
  readonly testVersionIds: readonly string[];
  /** What this folder's suite is called, for the run's own label. */
  readonly suite: string;
  /** Which coding agent the skill would be installed into. */
  readonly drivenAgentId: string;
  /** The repository, for the project scope. */
  readonly cwd: string;
  /** The developer's home, for the global scope. Passed in, never assumed. */
  readonly home: string;
  readonly signal: AbortSignal;
  /** How long between asks while following. egma's own default when omitted. */
  readonly everyMs?: number;
  /**
   * Hold the run screen until every simulation has been judged.
   *
   * The default is off, and the paragraph at the top of this file is why. This
   * is for the case that reasoning does not cover: somebody who came to watch
   * the whole suite, and for whom leaving at the first verdict would be the
   * wizard closing on the thing they came for.
   */
  readonly waitForSuite?: boolean;
};

function viewOf(follower: RunFollower): RunView {
  return {
    runId: follower.runId,
    rows: follower.rows,
    tally: follower.tally,
    firstVerdict: follower.firstVerdict,
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
    `${ACTION_MARK} ${installed.replaced ? "Replaced the egma skill in" : "The egma skill is in"} ${installed.file}`,
  );
  return {
    kind: "installed",
    scope: installed.scope,
    file: installed.file,
    drivenAgentName: places.name,
    replaced: installed.replaced,
  };
}

/**
 * Write the run into the repository, and say on screen that it is there.
 *
 * The same capture the verb makes, for the same reason: the walk ends and the
 * screen it ended on is thrown away, so a developer who watched four verdicts
 * land has nothing afterwards but a URL. The files are what they keep, and what
 * their reviewer reads.
 *
 * Never an ending. Every promise the walk made was kept the moment the run
 * existed, and a folder that could not be written into does not take that back.
 */
async function writeTheRunDown(
  options: RunStepOptions,
  follower: RunFollower,
  stopped: boolean,
): Promise<CapturedTally | null> {
  const paths = folderPathsIn(options.cwd);
  const captured = await captureRun({
    signedIn: options.signedIn,
    runId: follower.runId,
    paths,
    // Somebody who stopped watching is not waiting for graders. What has been
    // decided by now is written, and the rest is on the results page.
    waitForGrading: !stopped,
  });

  if (captured.kind === "written") {
    options.ui.pushStatus(`${ACTION_MARK} The run is written into ${paths.runs}`);
    for (const file of captured.written.shown) {
      options.ui.pushStatus(`${DETAIL_MARK} ${file}`);
    }
    return captured.tally;
  }
  options.ui.pushStatus(
    `${FAILURE_MARK} ${
      captured.kind === "gone"
        ? "egma no longer has this run, so there was nothing to write into the repository."
        : `The run finished. egma could not write it into ${paths.runs}: ${captured.reason}`
    }`,
  );
  return null;
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
    agentId: options.agentId,
    connectionId: options.connectionId,
    testVersionIds: options.testVersionIds,
    label: options.suite,
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

  const follower = new RunFollower(answer.run);
  announce(ui, answer.run, options.testVersionIds.length);
  ui.setRun(viewOf(follower));

  // The follow outlives this await on purpose. The developer is about to be
  // asked one more question, and the run is not going to stand still while
  // they think about it.
  const watching = new AbortController();
  const stopWatching = (): void => watching.abort();
  signal.addEventListener("abort", stopWatching, { once: true });

  let firstLanded!: () => void;
  const firstVerdict = new Promise<void>((resolve) => {
    firstLanded = resolve;
  });

  const following = followRun({
    signedIn: options.signedIn,
    follower,
    signal: watching.signal,
    ...(options.everyMs === undefined ? {} : { everyMs: options.everyMs }),
    ...(options.waitForSuite === true ? { untilGraded: true } : {}),
    onChange: (change) => {
      ui.setRun(viewOf(follower));
      if (change.first) firstLanded();
    },
  })
    // A run that finished without a verdict, or one egma stopped talking to,
    // must still let the wizard move on — otherwise the last question is never
    // asked and the developer is left watching a list that will not move.
    .catch((cause: unknown) => {
      // Not when the follow was stopped on purpose: that is the wizard closing,
      // and it is not news.
      if (!watching.signal.aborted) {
        ui.pushStatus(
          `${FAILURE_MARK} egma stopped answering about this run: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }
      return "interrupted" as const;
    })
    .finally(() => firstLanded());

  // Whichever the developer came for: the moment they stop taking egma's word
  // for it, or the whole suite. `following` has already resolved by the time it
  // is awaited in the second case, so nothing after this has to know which.
  await untilAborted(
    options.waitForSuite === true ? following.then(() => undefined) : firstVerdict,
    signal,
  );

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
    const written = await writeTheRunDown(options, follower, true);
    const stopped = follower.tally;
    return {
      kind: "run-started",
      resultsUrl: follower.resultsUrl,
      graded: written?.graded ?? stopped.graded,
      total: written?.total ?? stopped.total,
      // Never asked, so there is no answer to report.
      skill: { kind: "not-offered" },
    };
  }

  // Written before the last question rather than after it. The run is over by
  // now, and a developer who answers "skip" and walks away should already have
  // the files — the offer is about their coding agent, not about this run.
  const written = await writeTheRunDown(options, follower, false);

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

  const tally = follower.tally;
  ui.setRun(viewOf(follower));

  return {
    kind: "run-started",
    resultsUrl: follower.resultsUrl,
    // The count that came back with the files, which is newer than the
    // follower's: grading lands after the run finishes, and a closing line
    // saying "none graded yet" above a summary full of verdicts is a terminal
    // contradicting a file it just wrote.
    graded: written?.graded ?? tally.graded,
    total: written?.total ?? tally.total,
    skill,
  };
}
