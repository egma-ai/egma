/**
 * `egma run`: start a run over this folder's tests, and follow it.
 *
 * Headless in the same sense every other verb is: no terminal, no keystroke, no
 * question. It prints one fact per line and answers with a number, so a coding
 * agent can start a run, watch it, and act on what came back without anybody
 * reading a screen.
 *
 * Four promises this verb keeps, and each is a decision rather than a detail.
 *
 * **What it pins is what it says it pins.** The versions go on the wire and
 * every one of them is printed, so what executed is readable afterwards from
 * the terminal's own output as well as from the platform.
 *
 * **What the folder says and what egma holds either agree or nothing starts.**
 * A file egma has never seen and a file egma holds different content for are
 * both doors, not notes, and both name `egma push`. A run that went ahead over
 * the difference would answer green about content nobody executed, and a
 * coding agent reading that green reports an edit verified that never ran.
 *
 * **A refusal is repeated, never rewritten.** The platform decides whether a
 * run can happen — a connection type whose adapter has not shipped is the case
 * this exists for — and when it says no, its sentence is what appears. egma
 * neither paraphrases it nor wraps it in an explanation it did not give.
 *
 * **The four verdicts stay four.** `passed`, `failed`, `skipped` and `errored`
 * are counted and printed as themselves. The exit number tells them apart too:
 * a suite with a red test and a suite egma could not conduct want different
 * next actions, and a single "not zero" would hide which one happened.
 */

import { readConfig, folderPathsIn, type FolderConfig } from "../folder/egma-folder.ts";
import { PlatformUnreachableError } from "../platform/device-flow.ts";
import { startRun } from "../platform/runs.ts";
import { PlatformRefusedError } from "../platform/refused.ts";
import { notSignedInRefusal, signedInAt, type SignedIn } from "../platform/signed-in.ts";
import { followRun, RunFollower } from "../run/follow.ts";
import { changeLines, tallyLines } from "../run/lines.ts";
import {
  pushEditsRefusal,
  pushFirstRefusal,
  selectFromFolder,
  type Selection,
} from "../run/selection.ts";
import type { FolderCommandOptions } from "./folder-verbs.ts";

export const RUN_EXIT = {
  /** The run finished, and nothing failed and nothing errored. */
  done: 0,
  /** There was nothing here to run, or the folder does not say what to run it against. */
  nothing: 1,
  /** This machine holds no key for this egma. */
  notSignedIn: 2,
  /** The run finished and at least one test failed. */
  failed: 3,
  /** egma did not answer, or answered and would not talk to us. */
  unreachable: 4,
  /** egma would not start the run, and said why in its own words. */
  refused: 5,
  /** Nothing failed, but at least one simulation errored — so nothing concluded. */
  errored: 6,
  /** Stopped part way through. */
  interrupted: 130,
} as const;

export type RunCommandOptions = FolderCommandOptions & {
  /**
   * Start the run and return, without waiting for a single verdict.
   *
   * For a coding agent that wants the run going and will read the results page
   * later, and for anything running the suite as a side effect of something
   * else. The run itself is unaffected — it carries on on the platform either
   * way, which is the same thing the wizard relies on.
   */
  readonly noFollow?: boolean;
  readonly signal?: AbortSignal;
  /** How long between asks while following. egma's own default when omitted. */
  readonly everyMs?: number;
};

/** What the folder says this run is against, or what is missing from it. */
function targetIn(config: FolderConfig): { readonly agentId: string; readonly connectionId: string } | string {
  const agentId = config.agent?.id ?? "";
  const connectionId = config.connection?.id ?? "";
  if (agentId === "" || connectionId === "") {
    return "This folder does not say which voice agent to run against, or how Egma reaches it. Run egma connect here first.";
  }
  return { agentId, connectionId };
}

/** The whole selection, printed: what would run, and what stands in the way. */
function reportSelection(options: RunCommandOptions, selection: Selection): void {
  for (const one of selection.pinned) options.out(`pin: ${one.name} ${one.versionId}`);
  for (const one of selection.diverged) options.out(`not-pushed: ${one.name}`);
  for (const one of selection.unknown) options.out(`unknown: ${one.name}`);
}

export async function runRunCommand(options: RunCommandOptions): Promise<number> {
  options.out(`url: ${options.access.url}`);

  const paths = folderPathsIn(options.cwd);
  let config: FolderConfig;
  try {
    config = await readConfig(paths.config);
  } catch {
    options.out("status: no-folder");
    options.fail(
      `There is no egma folder in ${options.cwd}. Run egma init here, or run this from the folder your repository is in.`,
    );
    return RUN_EXIT.nothing;
  }
  options.out(`folder: ${paths.root}`);

  const signedIn: SignedIn | null = await signedInAt(options.access);
  if (signedIn === null) {
    options.out("status: not-signed-in");
    options.fail(notSignedInRefusal(options.access.url));
    return RUN_EXIT.notSignedIn;
  }

  const target = targetIn(config);
  if (typeof target === "string") {
    options.out("status: not-connected");
    options.fail(target);
    return RUN_EXIT.nothing;
  }
  options.out(`agent: ${target.agentId}`);
  options.out(`connection: ${target.connectionId}`);

  let selection: Selection;
  try {
    selection = await selectFromFolder({ signedIn, paths });
  } catch (cause) {
    return unreachable(options, cause);
  }

  reportSelection(options, selection);

  if (selection.unknown.length > 0) {
    // Its own word, and never `refused`. `refused` is the platform saying no
    // to a run it will not conduct, and it answers with its own number — a
    // reader that saw the same status line come back with two different
    // numbers would have to guess which of the two had happened.
    options.out("status: not-on-egma");
    options.fail(pushFirstRefusal(selection.unknown));
    return RUN_EXIT.nothing;
  }
  if (selection.diverged.length > 0) {
    // Its own word again, and never `refused`: this is egma refusing to ask,
    // not the platform refusing to conduct, and the two want different next
    // actions from whoever is reading. Nothing is started — a run over what
    // egma holds would come back green about content nobody executed, which is
    // exactly the failure this verb exists to make impossible.
    options.out("status: not-pushed");
    options.fail(pushEditsRefusal(selection.diverged));
    return RUN_EXIT.nothing;
  }
  if (selection.pinned.length === 0) {
    options.out("status: no-tests");
    options.fail(
      `There are no tests in ${paths.tests}. Run egma to write a first suite, or write one yourself and run egma push.`,
    );
    return RUN_EXIT.nothing;
  }

  let answer;
  try {
    answer = await startRun(signedIn, {
      agentId: target.agentId,
      connectionId: target.connectionId,
      testVersionIds: selection.pinned.map((one) => one.versionId),
      ...(config.suite?.name === undefined ? {} : { label: config.suite.name }),
    });
  } catch (cause) {
    return unreachable(options, cause);
  }

  if (answer.kind === "refused") {
    // egma's own sentence, printed as it arrived. Whatever egma will not do,
    // and why, is egma's to say — repeating it is the only honest relay.
    options.out("status: refused");
    options.out(`reason: ${answer.reason}`);
    options.fail(answer.reason);
    return RUN_EXIT.refused;
  }

  const { run } = answer;
  options.out(`run: ${run.id}`);
  options.out(`tests: ${selection.pinned.length}`);
  options.out(`simulations: ${run.expectedSimulationCount}`);
  options.out(`results: ${run.resultsUrl}`);

  const follower = new RunFollower(run);
  for (const row of follower.rows) {
    options.out(`simulation: ${row.name} ${row.persona} ${row.status}`);
  }

  if (options.noFollow === true) {
    options.out("status: started");
    return RUN_EXIT.done;
  }

  let ending;
  try {
    ending = await followRun({
      signedIn,
      follower,
      onChange: (change) => {
        for (const line of changeLines(change)) options.out(line);
      },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.everyMs === undefined ? {} : { everyMs: options.everyMs }),
    });
  } catch (cause) {
    return unreachable(options, cause);
  }

  const tally = follower.tally;
  for (const line of tallyLines(tally)) options.out(line);

  if (ending === "interrupted") {
    // The run is on the platform and it is still going. Saying it stopped
    // would be saying something that did not happen.
    options.out("status: left-running");
    return RUN_EXIT.interrupted;
  }

  options.out(`status: ${follower.runStatus}`);
  if (tally.failed > 0) return RUN_EXIT.failed;
  if (tally.errored > 0) return RUN_EXIT.errored;
  return RUN_EXIT.done;
}

/** The one ending that is about egma rather than about the run. */
function unreachable(options: RunCommandOptions, cause: unknown): number {
  if (cause instanceof PlatformUnreachableError || cause instanceof PlatformRefusedError) {
    options.out("status: unreachable");
    options.out(`reason: ${cause.message}`);
    options.fail(cause.message);
    return RUN_EXIT.unreachable;
  }
  throw cause;
}
