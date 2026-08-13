/**
 * The wizard's generate step: from what egma has learned to tests on egma.
 *
 * Four things happen, in one order, and the developer is in exactly one of
 * them: they are asked once whether they already have test cases written down;
 * what they point at is converted into files; what is missing is generated;
 * and the whole list is put on screen for one keystroke.
 *
 * Both dispatches are the same shape as every other intelligent step — the
 * developer's own coding agent, egma's own notes at the top of the task, every
 * action streamed. What is different is that this one *writes*, so the pane
 * fills in as the files appear.
 *
 * **What is on disk is the truth**, and it is what this step believes twice
 * over. While the agent works, the pane is drawn from the folder as much as
 * from what the agent says about it. When the writing stops, the list the
 * developer scans is built from the files that are really there — which is why
 * a coding agent that says it wrote twelve and wrote nine puts nine on screen.
 *
 * **What runs is what was agreed to.** The push can come back with a refusal
 * egma could not see coming: the platform's own door, on a rule only the
 * platform can check. That is one test off the list the developer just read, so
 * the step does not walk on into a run over a list nobody agreed to — the list
 * goes up again with the refused file held back in the platform's own words,
 * and the same one keystroke is asked for. Pressing it a second time without
 * fixing anything is consent to leave that test out; pressing it after fixing
 * the file puts the test up with the rest.
 *
 * A UI with nobody watching opens every list itself, so `--headless` agrees to
 * the second list the moment it is drawn and goes on with what the platform
 * accepted. That is right rather than a shortcut: consent to a run with nobody
 * watching was given in the command, and what the platform refused is on the
 * output as a named line before the run begins.
 */

import { readdir } from "node:fs/promises";

import {
  createEgmaFolder,
  DEFAULT_SUITE_NAME,
  isTestFileName,
  readConfig,
  readFolder,
  testNameFromFileName,
  updateConfig,
  type FolderPaths,
  type FolderTest,
} from "../folder/egma-folder.ts";
import { driveOneTask } from "../acp/drive.ts";
import type { DrivenAgentLaunch } from "../acp/registry.ts";
import type { Registered } from "../platform/agents.ts";
import type { SignedIn } from "../platform/signed-in.ts";
import type { RetellConfig } from "../retell/client.ts";
import { pushTests } from "../sync/push.ts";
import type { WizardUI } from "../ui/wizard-ui.ts";
import type { DrivenAgentLog } from "./driven-agent-log.ts";
import type { ExitReport } from "./exit-line.ts";
import type { Facts } from "./discovery.ts";
import { readExistingTests } from "./existing-tests.ts";
import { destinationOf, gateFrom, type HeldBack } from "./gate.ts";
import { MarkerStream, type ParsedLine } from "./markers.ts";
import { ACTION_MARK, DETAIL_MARK, FAILURE_MARK } from "./status.ts";
import { stopReasonOf, stopReport, untilAborted } from "./stop.ts";
import {
  convertInstructions,
  DEFAULT_TEST_COUNT,
  generateInstructions,
  GenerationTally,
  type GenerationContext,
} from "./test-generation.ts";

/**
 * How the step ended, and what it left behind for the step after it.
 *
 * The versions are here rather than read back off the disk because they are
 * the exact set the developer agreed to at the gate and the exact set the push
 * put on egma. A file that was held back at the gate is still in the folder,
 * and a run that re-read the folder would try to pin it.
 */
export type GenerateOutcome = {
  readonly report: ExitReport;
  /** What the push put on egma, by version id. Empty when nothing was pushed. */
  readonly pushed: readonly string[];
  /** What this folder's suite is called. */
  readonly suite: string;
};

/**
 * How often the folder is looked at while a coding agent writes into it.
 *
 * Often enough that a file appears on screen as the developer would say it
 * appeared, and rarely enough that reading one small directory is nothing.
 */
const FOLDER_LOOK_MS = 400;

export type GenerateStepOptions = {
  readonly ui: WizardUI;
  readonly launch: DrivenAgentLaunch;
  /** The repository the folder goes in, and the whole of what is read. */
  readonly cwd: string;
  readonly signal: AbortSignal;
  readonly log: DrivenAgentLog;
  /** The key this machine holds, for the push. */
  readonly signedIn: SignedIn;
  /** What connect registered, which is what the tests are for. */
  readonly registered: Registered;
  /** What the provider is running, which is what the tests are grounded in. */
  readonly config: RetellConfig;
  /** What the find-the-agent step reported. */
  readonly facts: Facts;
  /** How many tests a first suite holds. The default when it is left out. */
  readonly howMany?: number;
};

/**
 * How this step stops, with the folder counted.
 *
 * Everywhere else in the walk a stop leaves nothing behind. Here it leaves
 * files: the coding agent writes them as it goes, and they are the developer's
 * the moment they land. So the count is read off the disk at the moment of
 * stopping and travels with the report, and the exit line says where they are.
 */
async function stoppedHere(
  signal: AbortSignal,
  drivenAgentName: string,
  paths: FolderPaths,
): Promise<ExitReport> {
  const report = stopReport(signal, drivenAgentName);
  if (report.kind !== "interrupted") return report;
  const kept = (await namesInFolder(paths)).length;
  return kept === 0 ? report : { ...report, testsKept: kept };
}

/**
 * One dispatch that writes files, with the pane following what really lands.
 *
 * The result is deliberately thin: whether the agent could be driven at all,
 * and whether it stopped itself. Everything else about what happened is read
 * off the disk afterwards, because that is the only account of it that cannot
 * be wrong.
 */
async function writeFiles(
  options: GenerateStepOptions,
  paths: FolderPaths,
  what: "converting" | "generating",
  instructions: string,
  goal: number,
): Promise<ExitReport | null> {
  const { ui, launch, cwd, signal, log } = options;

  const tally = new GenerationTally(what, goal);
  const markers = new MarkerStream();
  ui.setGeneration(tally.progress);

  /**
   * The second account of what happened, and the one that cannot be wrong: the
   * folder itself.
   *
   * Marker lines are what a coding agent is asked for, and they are the only
   * thing that can say which file is being written *now*. But an agent may
   * write the files and forget to say so — a real one did, which is how this
   * came to be here — and it may write them any way it likes: through egma,
   * with a tool of its own, or with a shell command egma only ever sees the
   * text of. What every one of those has in common is a file appearing in the
   * folder. So the folder is watched, and the pane fills in either way.
   *
   * Only files that were not already there count. A run that converted the
   * developer's own material first would otherwise count that work twice.
   */
  const alreadyThere = await namesInFolder(paths);
  const seen = new Set(alreadyThere);
  const look = async (): Promise<void> => {
    let moved = false;
    for (const name of await namesInFolder(paths)) {
      if (seen.has(name)) continue;
      seen.add(name);
      tally.wrote(name);
      moved = true;
    }
    if (moved) ui.setGeneration(tally.progress);
  };
  const watching = setInterval(() => void look().catch(() => undefined), FOLDER_LOOK_MS);

  const take = (lines: readonly ParsedLine[]): string | null => {
    let abort: string | null = null;
    let moved = false;
    for (const line of lines) {
      if (line.kind === "prose") {
        log.write(`${line.text}\n`);
        continue;
      }
      const marker = line.marker;
      log.write(`${JSON.stringify(marker)}\n`);
      switch (marker.kind) {
        case "plan":
          tally.plan(marker.names);
          moved = true;
          break;
        case "writing":
          tally.writing(marker.name);
          moved = true;
          break;
        case "wrote":
          tally.wrote(marker.name);
          ui.pushStatus(`${ACTION_MARK} Wrote ${marker.name}`);
          moved = true;
          break;
        case "note":
          ui.pushStatus(`${ACTION_MARK} ${marker.text}`);
          break;
        case "abort":
          abort = marker.reason;
          break;
        case "found":
        case "none":
          // Markers the find-the-agent step asks for. Kept in the log, where
          // every marker goes, and not put on a screen about writing files.
          break;
      }
    }
    if (moved) ui.setGeneration(tally.progress);
    return abort;
  };

  ui.taskStarted();
  let result;
  try {
    result = await driveOneTask({
      launch,
      cwd,
      instructions,
      ui,
      signal,
      logStderr: (chunk) => log.write(chunk),
      watch: (chunk) => take(markers.push(chunk)),
      onLogin: (name) =>
        ui.pushStatus(`${ACTION_MARK} ${name} needs you to log in. Handing you to its own login.`),
    });
    // The agent's last line often arrives without the line ending that would
    // have finished it, and it is read before the pane comes down.
    take(markers.flush());
  } finally {
    // However this ended — a stop, an interruption, or something nobody
    // planned for — the timer stops and the pane comes down. A timer left
    // running is a wizard that never leaves.
    clearInterval(watching);
    ui.setGeneration(null);
    ui.taskFinished();
  }

  switch (result.kind) {
    case "done":
      return null;
    case "aborted":
      // The agent stopping itself is not the same as writing nothing. What it
      // wrote before it stopped is on disk, and the folder is read either way.
      ui.pushStatus(
        `${FAILURE_MARK} ${result.reason === "" ? `${launch.name} stopped, and did not say why.` : result.reason}`,
      );
      return null;
    case "interrupted":
      return stoppedHere(signal, launch.name, paths);
    case "unreachable":
      return { kind: "no-coding-agent" };
    case "needs-login":
      return {
        kind: "failed",
        reason: `${result.drivenAgentName} is not logged in, and egma could not hand you to its login. Log in to it, then run egma again.`,
      };
    case "failed":
      ui.pushStatus(`What ${launch.name} printed is in ${log.file}`);
      return { kind: "failed", reason: result.reason };
  }
}

/** The names already in the folder, so a second dispatch cannot repeat one. */
function namesOf(found: readonly FolderTest[]): readonly string[] {
  return found.map((file) => file.test.name);
}

/**
 * Every test file in the folder, by name, without reading a byte of any of
 * them. It is asked several times a second while an agent works, and what it
 * is asked is only whether a file is there yet.
 */
async function namesInFolder(paths: FolderPaths): Promise<readonly string[]> {
  try {
    return (await readdir(paths.tests)).filter(isTestFileName).map(testNameFromFileName);
  } catch {
    return [];
  }
}

/**
 * The personas a generated file may name.
 *
 * A file names them by name and egma resolves the name when the file is
 * uploaded, so a name egma does not hold is a test egma turns away at its own
 * door. Nothing lists a project's personas over the public API yet, so the
 * honest answer today is none of them, and both tasks say so plainly: leave the
 * line out, and the project's default persona applies. The day the listing
 * exists, this is where the list comes from and neither task changes.
 */
const PERSONAS_EGMA_HOLDS: readonly string[] = [];

/**
 * The folder this repository's tests live in, made or recognised, pointing at
 * what egma has just registered.
 *
 * A folder that is already here keeps its own config file — it is somebody's
 * committed file — except for the two things egma has just learned and it has
 * not: which agent, and which connection.
 */
async function folderFor(options: GenerateStepOptions): Promise<FolderPaths> {
  const agent = {
    name: options.registered.agent.name,
    id: options.registered.agent.id,
  };
  const connection = {
    name: options.registered.connection.name,
    id: options.registered.connection.id,
  };

  const folder = await createEgmaFolder({
    repository: options.cwd,
    config: {
      platform: null,
      agent,
      connection,
      suite: { name: DEFAULT_SUITE_NAME, id: null },
    },
  });
  if (!folder.created) {
    await updateConfig(folder.paths.config, {
      agent,
      connection,
      ...(folder.config.suite === null
        ? { suite: { name: DEFAULT_SUITE_NAME, id: null } }
        : {}),
    });
  }
  return folder.paths;
}

/** What the folder's config calls this suite, whoever named it. */
async function suiteNameIn(paths: FolderPaths): Promise<string> {
  try {
    return (await readConfig(paths.config)).suite?.name ?? DEFAULT_SUITE_NAME;
  } catch {
    return DEFAULT_SUITE_NAME;
  }
}

/** The push, and what the wizard has to work with afterwards. */
type Pushed = Omit<GenerateOutcome, "suite"> & {
  /**
   * What the platform's own door turned away, for the list to carry back.
   *
   * Which refusal is the door's is read off the push and never off the words:
   * the door's sentence is the door's, and a wizard that recognised it by its
   * wording would walk past the day the platform said it differently.
   */
  readonly refused: readonly HeldBack[];
};

async function pushGate(
  options: GenerateStepOptions,
  paths: FolderPaths,
  only: readonly string[],
): Promise<Pushed> {
  const { ui } = options;

  const report = await pushTests({ signedIn: options.signedIn, paths, only });

  for (const test of report.tests) {
    ui.pushStatus(`${ACTION_MARK} ${test.state} ${test.name}`);
    ui.pushStatus(`${DETAIL_MARK} ${test.versionId}`);
  }
  for (const turned of report.turnedAway) {
    ui.pushStatus(`${FAILURE_MARK} egma would not take ${turned.shown}: ${turned.reason}`);
  }
  if (report.conflicts.length > 0) {
    const names = report.conflicts.map((conflict) => conflict.name).join(", ");
    return {
      report: {
        kind: "failed",
        reason: `egma has a newer version of ${names}. Run egma pull, look at what changed, then egma push.`,
      },
      pushed: [],
      refused: [],
    };
  }

  return {
    report: { kind: "tests-pushed", count: report.tests.length },
    pushed: report.tests.map((test) => test.versionId),
    refused: report.turnedAway
      .filter((turned) => turned.refusedBy === "platform")
      .map((turned) => ({ shown: turned.shown, file: turned.file, reason: turned.reason })),
  };
}

/**
 * The whole step. Every ending is an ending the developer can act on, and the
 * files are on disk for all of them.
 */
export async function generateStep(options: GenerateStepOptions): Promise<GenerateOutcome> {
  const { ui, cwd, signal } = options;
  const howMany = options.howMany ?? DEFAULT_TEST_COUNT;

  const paths = await folderFor(options);
  ui.pushStatus(`${ACTION_MARK} Your tests live in ${paths.tests}`);
  const suite = await suiteNameIn(paths);
  /** Any ending that pushed nothing, which is every ending but the last one. */
  const ending = (report: ExitReport): GenerateOutcome => ({ report, pushed: [], suite });

  // The one question this step asks, and it is asked once. A developer who
  // closes the wizard instead of answering has answered too, so the wait ends
  // with the signal and not only with a keystroke.
  const said = await untilAborted(ui.waitForAnswer("existing-tests"), signal);
  if (signal.aborted) return ending(await stoppedHere(signal, options.launch.name, paths));

  const existing = await readExistingTests(cwd, said ?? null);
  if (existing.kind === "unusable") {
    // Said plainly and never fatally: prior work egma cannot read is a reason
    // to generate from what it does have, not a reason to stop.
    ui.pushStatus(`${FAILURE_MARK} ${existing.reason}`);
  }

  if (existing.kind === "read") {
    ui.pushStatus(`${ACTION_MARK} Turning ${existing.shown} into test files`);
    const halted = await writeFiles(
      options,
      paths,
      "converting",
      convertInstructions({
        cwd,
        shown: existing.shown,
        content: existing.content,
        taken: namesOf((await readFolder(paths)).found),
        personas: PERSONAS_EGMA_HOLDS,
      }),
      // Nobody knows how many rows are in there, least of all egma, so the
      // pane counts what turns up rather than promising a number.
      0,
    );
    if (halted !== null) return ending(halted);
  }

  const converted = (await readFolder(paths)).found;
  const missing = Math.max(howMany - converted.length, 0);
  if (missing === 0) {
    ui.pushStatus(
      `${ACTION_MARK} ${converted.length} tests came out of your own material, so egma generated none.`,
    );
  } else {
    const context: GenerationContext = {
      cwd,
      facts: options.facts,
      prompt: options.config.prompt,
      toolCount: options.config.tools.length,
      agentName: options.registered.agent.name,
      taken: namesOf(converted),
      personas: PERSONAS_EGMA_HOLDS,
    };
    const halted = await writeFiles(
      options,
      paths,
      "generating",
      generateInstructions(context, missing),
      missing,
    );
    if (halted !== null) return ending(halted);
  }

  const about = {
    agentName: options.registered.agent.name,
    connectionName: options.registered.connection.name,
    connectionType: options.registered.connection.type,
    modality: options.registered.connection.modality,
    destination: destinationOf(options.registered.connection),
    suite,
  };

  /** What the platform's door turned away from the push the last key agreed to. */
  let refused: readonly HeldBack[] = [];
  /** Every file a keystroke has already agreed to go without. */
  const agreedToGoWithout = new Set<string>();
  /** Said once, however many times the list goes up. */
  const alreadySaid = new Set<string>();

  for (;;) {
    // What is really on disk, whatever anybody said about it, and what the
    // platform said about the files it was handed.
    const folder = await readFolder(paths);
    const gate = gateFrom(folder, about, refused);

    for (const held of gate.heldBack) {
      const line = `${FAILURE_MARK} ${held.shown} was not pushed: ${held.reason}`;
      if (alreadySaid.has(line)) continue;
      alreadySaid.add(line);
      ui.pushStatus(line);
    }

    // Nothing to put on a list and nothing the platform has refused: the coding
    // agent wrote nothing egma can use, which is a different ending from the
    // platform refusing what it wrote.
    if (gate.rows.length === 0 && refused.length === 0) {
      return ending({
        kind: "failed",
        reason: `${options.launch.name} wrote no test egma could use. What it printed is in ${options.log.file}.`,
      });
    }

    ui.setGate(gate);
    await untilAborted(ui.waitForGate("run-tests"), signal);
    ui.setGate(null);

    if (signal.aborted) {
      // Closing the wizard here is a decision and not a failure: nothing is
      // running, the files are written, and they are the developer's. So Ctrl-C
      // and `q` leave the same line about where the files are — an interruption
      // here shut no coding agent down and stopped no task, and saying it did
      // would be egma telling a story about itself rather than about the run.
      return ending({
        kind: "tests-kept",
        count: gate.rows.length,
        stopped: stopReasonOf(signal) !== "quit",
      });
    }

    // The keystroke was over this list, held-back files and all. Every one of
    // them is now a file the developer has agreed to go without, which is what
    // makes leaving it out of the run consented rather than quiet — and what
    // stops the same refusal sending them back to the same list forever.
    for (const held of gate.heldBack) agreedToGoWithout.add(held.file);

    const pushed = await pushGate(options, paths, [
      ...gate.rows.map((row) => row.file),
      // What the door refused before goes up again. The developer may have
      // fixed it at this very list — `e` opens it — and the only way to find
      // out is to knock. A file it refuses again is refused with the same
      // sentence, which was on the list this keystroke agreed to.
      ...refused.map((held) => held.file),
    ]);

    const unagreed = pushed.refused.filter((held) => !agreedToGoWithout.has(held.file));
    if (unagreed.length === 0) return { report: pushed.report, pushed: pushed.pushed, suite };

    // The platform refused something nobody agreed to go without, so the list
    // that would run is not the list the keystroke was over. Round it goes
    // again, carrying what the platform said, and nothing runs until a key has
    // been pressed over the real list.
    refused = pushed.refused;
  }
}
