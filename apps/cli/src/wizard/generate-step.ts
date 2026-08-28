/**
 * The wizard's generate step: from what egma has learned to tests on egma.
 *
 * Five things happen, in one order, and the developer is in exactly one of
 * them: they are asked once whether they already have test cases written down;
 * what they point at is converted into files; what is missing is generated;
 * the lane's own work between the files landing and the list going up runs —
 * on LiveKit, the mocked world those tests will run in — and the whole list is
 * put on screen for one keystroke.
 *
 * Both dispatches are the same shape as every other intelligent step — the
 * developer's own coding agent, egma's own notes at the top of the task, every
 * action streamed. What is different is that this one *writes*, so the pane
 * fills in as the files appear.
 *
 * **What is on disk is the truth**, and it is what this step believes twice
 * over. While the agent works, the pane is drawn from the folder as much as
 * from what the agent says about it. When the writing stops, the files that
 * are really there must match the first-suite count before any are reviewed or
 * pushed.
 *
 * **What runs is the complete suite.** One invalid file or one atomic platform
 * refusal stops the step. The wizard never treats approval as permission to
 * omit a file, so the reviewed suite, pushed suite, and run suite are one set.
 */

import { mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";

import {
  CONFIG_FORMAT,
  createEgmaFolder,
  readRepository,
  recordRegisteredTarget,
  writeSuiteManifest,
  type FolderPaths,
  type FolderContents,
  type FolderTest,
  RepositoryValidationError,
} from "../folder/egma-folder.ts";
import {
  portableSuiteDirectory,
  withStablePathSuffix,
} from "../folder/portable-path.ts";
import type { DrivenAgent } from "../acp/driven-agent.ts";
import type { Registered } from "../platform/agents.ts";
import { listPersonas as listPersonasRequest } from "@egma/platform-api/client";

import {
  platformClient,
  platformRefusalMessage,
  platformResponse,
  platformText,
} from "../platform/client.ts";
import { readProject } from "../platform/projects.ts";
import { PlatformRefusedError } from "../platform/refused.ts";
import type { SignedIn } from "../platform/signed-in.ts";
import { createTestSuite } from "../platform/test-suites.ts";
import { pullRepository } from "../sync/pull.ts";
import { pushTests } from "../sync/push.ts";
import type { WizardUI } from "../ui/wizard-ui.ts";
import type { DrivenAgentLog } from "./driven-agent-log.ts";
import type { ExitReport } from "./exit-line.ts";
import type { Facts } from "./discovery.ts";
import { readExistingTests } from "./existing-tests.ts";
import { destinationOf, gateFrom } from "./gate.ts";
import type { MockToolEntry } from "../folder/mock-tools.ts";
import { MarkerStream, type ParsedLine } from "./markers.ts";
import { ACTION_MARK, DETAIL_MARK, FAILURE_MARK } from "./status.ts";
import { stopReasonOf, stopReport, untilAborted } from "./stop.ts";
import {
  convertInstructions,
  DEFAULT_TEST_COUNT,
  generateInstructions,
  GenerationTally,
  MAX_GENERATED_EXPECTED_BEHAVIORS,
  type GenerationContext,
} from "./test-generation.ts";

/**
 * How the step ended, and what it left behind for the step after it.
 *
 * The versions are here rather than read back off the disk because they are
 * the exact complete set the developer agreed to and the atomic push put on
 * Egma. Any invalid file stops before this set exists.
 */
export type GenerateOutcome = {
  readonly report: ExitReport;
  /** Exact test/version precondition from the complete repository push. */
  readonly pushed: readonly { readonly testId: string; readonly versionId: string }[];
  readonly suite: { readonly id: string; readonly name: string; readonly directory: string };
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
  readonly drivenAgent: DrivenAgent;
  /** The repository the folder goes in, and the whole of what is read. */
  readonly cwd: string;
  readonly signal: AbortSignal;
  readonly log: DrivenAgentLog;
  /** The key this machine holds, for the push. */
  readonly signedIn: SignedIn;
  /** What connect registered, which is what the tests are for. */
  readonly registered: Registered;
  /** Provider facts when the provider exposes them; otherwise repository context wins. */
  readonly source: {
    readonly prompt: string | null;
    readonly toolCount: number | null;
  };
  /** What the find-the-agent step reported. */
  readonly facts: Facts;
  /** Exactly how many tests a first suite holds. The default when it is left out. */
  readonly howMany?: number;
  /**
   * What happens between the test files landing and the list going up.
   *
   * The lane's own work, handed in rather than known here: on LiveKit it is the
   * mocked world being written, and on Retell there is nothing to do and no
   * screen for it. It answers the report the walk must stop on, or `null` to
   * carry on to the gate. It is also where the state machine learns the tests
   * exist, because that is the same moment.
   */
  readonly betweenWritingAndReview?:
    | ((written: WrittenTests) => Promise<BetweenReview>)
    | undefined;
  /** State-machine seam for the approval. It performs no I/O itself. */
  readonly onReviewApproved?: ((count: number) => void) | undefined;
};

/** What the work between the files landing and the gate going up left behind. */
export type BetweenReview = {
  /** Set only when the walk cannot carry on from here. */
  readonly halted: ExitReport | null;
  /** Integration files outside `egma/` reported for the gate to name. */
  readonly changed?: readonly string[] | undefined;
};

/** The tests that landed, and the suite directory they landed in. */
export type WrittenTests = {
  /** Every test Egma could use, by name, in the folder's own order. */
  readonly tests: readonly string[];
  /** The direct suite directory under `egma/tests/`. */
  readonly suiteDirectory: string;
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
  suiteRoot: string,
): Promise<ExitReport> {
  const report = stopReport(signal, drivenAgentName);
  if (report.kind !== "interrupted") return report;
  const kept = (await namesInFolder(suiteRoot)).length;
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
  suiteRoot: string,
  what: "converting" | "generating",
  instructions: string,
  goal: number,
): Promise<ExitReport | null> {
  const { ui, drivenAgent, signal, log } = options;

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
  const alreadyThere = await namesInFolder(suiteRoot);
  const seen = new Set(alreadyThere);
  const look = async (): Promise<void> => {
    let moved = false;
    for (const name of await namesInFolder(suiteRoot)) {
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
          ui.pushStatus(
            `${ACTION_MARK} Planned ${String(marker.names.length)} ${marker.names.length === 1 ? "test" : "tests"}`,
          );
          moved = true;
          break;
        case "writing":
          tally.writing(marker.name);
          ui.pushStatus(`${ACTION_MARK} Writing ${marker.name}`);
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
    result = await drivenAgent.run({
      instructions,
      watch: (chunk) => take(markers.push(chunk)),
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
        `${FAILURE_MARK} ${result.reason === "" ? `${drivenAgent.name} stopped, and did not say why.` : result.reason}`,
      );
      return null;
    case "interrupted":
      return stoppedHere(signal, drivenAgent.name, suiteRoot);
    case "unreachable":
      return { kind: "no-coding-agent" };
    case "needs-login":
      return {
        kind: "failed",
        reason: `${result.drivenAgentName} is not logged in, and Egma could not hand you to its login. Log in to it, then run egma again.`,
      };
    case "failed":
      ui.pushStatus(`What ${drivenAgent.name} printed is in ${log.file}`);
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
async function namesInFolder(suiteRoot: string): Promise<readonly string[]> {
  try {
    return (await readdir(suiteRoot))
      .filter((name) => name.endsWith(".md"))
      .map((name) => name.slice(0, -".md".length));
  } catch {
    return [];
  }
}

/**
 * The personas a generated file may name, read from the project it will push to.
 *
 * A file names them by name and egma resolves the name when the file is
 * uploaded, so a name egma does not hold is a test egma turns away at its own
 * door. **This used to answer none of them**, on the reasoning that nothing
 * listed a project's personas over the public API and that a file leaving the
 * line out received the project's default persona. Both halves were wrong by
 * 2026-08-24: `listPersonas` is a public operation, and a test naming no
 * persona is refused rather than given the default. A wizard that kept writing
 * personas-less files would be a wizard whose folder cannot be pushed.
 *
 * **The order is egma's own, and this no longer sorts one entry to the front.**
 * It used to put the project's default persona first. There is no default
 * persona any more — the pointer and everything guarding it were removed with
 * the persona rework — so the list arrives newest first and the wizard leans on
 * whichever entry that puts at the top. Every project still holds Egma's
 * Predefined personas, so the list is never empty for a project nobody has
 * authored in yet.
 */
async function personasEgmaHolds(
  signedIn: SignedIn,
  projectId: string,
): Promise<readonly string[]> {
  const answer = await listPersonasRequest(
    { projectId },
    { client: platformClient(signedIn) },
  );
  const response = platformResponse(answer, signedIn.url);
  if (!response.ok || answer.data === undefined) {
    throw new PlatformRefusedError(
      response.status,
      platformRefusalMessage(answer.error, response.status),
    );
  }
  return answer.data.personas
    .map((one) => platformText(one.name))
    .filter((name) => name !== "");
}

/**
 * The folder this repository's tests live in, made or recognised, pointing at
 * what egma has just registered.
 *
 * A folder that is already here keeps its own config file — it is somebody's
 * committed file — except for the two things egma has just learned and it has
 * not: which agent, and which connection.
 */
type GeneratedSuite = {
  readonly paths: FolderPaths;
  readonly suite: { readonly id: string; readonly name: string; readonly directory: string };
  readonly root: string;
  /** Who can call, read from the project these tests will be pushed to. */
  readonly personas: readonly string[];
};

async function folderFor(options: GenerateStepOptions): Promise<GeneratedSuite> {
  const agent = {
    name: options.registered.agent.name,
    id: options.registered.agent.id,
  };
  const connection = {
    name: options.registered.connection.name,
    id: options.registered.connection.id,
  };
  const project = await readProject(
    options.signedIn,
    options.registered.agent.projectId,
  );
  if (project === null) {
    throw new Error(`Egma could not read project ${options.registered.agent.projectId}.`);
  }

  /*
   * Who can call, read before a single file is written.
   *
   * Every test names at least one persona from birth, so this is read here and
   * not at push time: a folder written against an empty list is a folder that
   * cannot be pushed, and a refusal after a coding agent has written four
   * files is a far worse place to learn it.
   */
  const personas = await personasEgmaHolds(options.signedIn, project.id);

  const folder = await createEgmaFolder({
    repository: options.cwd,
    config: {
      format: CONFIG_FORMAT,
      platform: null,
      project: { name: project.name, id: project.id },
      agents: [{ ...agent, connections: [connection] }],
    },
  });
  if (!folder.created) {
    await recordRegisteredTarget(folder.paths.config, {
      project: { name: project.name, id: project.id },
      agent,
      connection,
    });
  }

  // Push is the complete project working copy. A fresh repository can still
  // point at a project with suites made in the browser or by an earlier local
  // attempt, so materialize those before creating one more remote identity.
  await pullRepository({ signedIn: options.signedIn, paths: folder.paths });
  options.ui.pushStatus(
    `${ACTION_MARK} Pulled the project's current suites, tests, and mock tools into this repository`,
  );

  const repository = await readRepository(folder.paths);
  const used = new Set(
    repository.suites.map((suite) => suite.directory.toLowerCase()),
  );
  const name = `${options.registered.agent.name} tests`;
  const remote = await createTestSuite(
    options.signedIn,
    { projectId: project.id, name },
  );
  const wanted = portableSuiteDirectory(remote.name);
  let directory = wanted;
  for (let suffix = 2; used.has(directory.toLowerCase()); suffix += 1) {
    directory = withStablePathSuffix(wanted, String(suffix));
  }
  const root = path.join(folder.paths.tests, directory);
  let createdRoot = false;
  try {
    await mkdir(root);
    createdRoot = true;
    await writeSuiteManifest(path.join(root, "suite.yaml"), {
      id: remote.id,
      name: remote.name,
    });
  } catch (cause) {
    if (createdRoot) {
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
    throw new Error(
      `Egma created suite ${remote.id}, but the wizard could not write egma/tests/${directory}/suite.yaml. Pull to recover it. ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  // Parse the complete repository again before any coding agent can write.
  await readRepository(folder.paths);
  return {
    paths: folder.paths,
    root,
    suite: { id: remote.id, name: remote.name, directory },
    personas,
  };
}

/** What is in the folder for this suite, and the world every test runs in. */
type SuiteContents = FolderContents & {
  readonly mockTools: readonly MockToolEntry[];
};

async function contentsFor(paths: FolderPaths, suiteId: string): Promise<SuiteContents> {
  try {
    const repository = await readRepository(paths);
    const suite = repository.suites.find((entry) => entry.manifest.id === suiteId);
    return { found: suite?.tests ?? [], unreadable: [], mockTools: repository.mockTools };
  } catch (cause) {
    if (!(cause instanceof RepositoryValidationError)) throw cause;
    // A complete repository parse has no partial success. Give the gate the
    // named problems, but no valid subset, so one bad file cannot turn the
    // developer's approval into permission to push fewer tests.
    return {
      found: [],
      mockTools: [],
      unreadable: cause.issues.map((issue) => {
        const [named = issue, ...detail] = issue.split(": ");
        const shown = named.startsWith("egma/") ? named : "egma";
        return {
          shown,
          file: path.join(paths.root, ...shown.split("/").slice(1)),
          reason: detail.join(": ") || issue,
        };
      }),
    };
  }
}

/** The complete atomic push, and what the wizard can run afterwards. */
type Pushed = Omit<GenerateOutcome, "suite">;

async function pushGate(
  options: GenerateStepOptions,
  paths: FolderPaths,
  suiteDirectory: string,
): Promise<Pushed> {
  const { ui } = options;

  const report = await pushTests({ signedIn: options.signedIn, paths });

  for (const test of report.tests) {
    ui.pushStatus(`${ACTION_MARK} ${test.state} ${test.name}`);
    ui.pushStatus(`${DETAIL_MARK} ${test.versionId}`);
  }
  for (const turned of report.turnedAway) {
    ui.pushStatus(`${FAILURE_MARK} Egma would not take ${turned.shown}: ${turned.reason}`);
  }
  if (report.turnedAway.length > 0) {
    return {
      report: {
        kind: "failed",
        reason: "The complete suite was not pushed. Fix every file named above, then run the wizard again.",
      },
      pushed: [],
    };
  }

  const selected = report.tests.filter((test) =>
    test.shown.startsWith(`egma/tests/${suiteDirectory}/`),
  );
  return {
    report: { kind: "tests-pushed", count: selected.length },
    pushed: selected.map((test) => ({ testId: test.testId, versionId: test.versionId })),
  };
}

/**
 * The whole step. Every ending is an ending the developer can act on, and the
 * files are on disk for all of them.
 */
export async function generateStep(options: GenerateStepOptions): Promise<GenerateOutcome> {
  const { ui, cwd, signal } = options;
  const howMany = options.howMany ?? DEFAULT_TEST_COUNT;

  const generated = await folderFor(options);
  const { paths, suite } = generated;
  ui.pushStatus(`${ACTION_MARK} Your tests live in ${generated.root}`);
  /** Any ending that pushed nothing, which is every ending but the last one. */
  const ending = (report: ExitReport): GenerateOutcome => ({ report, pushed: [], suite });

  /*
   * **Honest insurance, and it should never fire.** A Predefined persona
   * belongs to no organization and no project, so every project can name one
   * from the moment it exists — a project holding none is a project the
   * platform cannot make. If one ever answers
   * that way, stopping here is the kind ending: a test names at least one
   * persona from birth, so the alternative is a coding agent writing a folder
   * that is refused, file by file, at push time.
   */
  if (generated.personas.length === 0) {
    ui.pushStatus(
      `${FAILURE_MARK} Egma answered with no personas for this project.`,
    );
    return ending({
      kind: "failed",
      reason:
        "Every test names at least one persona, and Egma listed none for this project. Add a persona in Egma, then run egma again.",
    });
  }

  // The one question this step asks, and it is asked once. A developer who
  // closes the wizard instead of answering has answered too, so the wait ends
  // with the signal and not only with a keystroke.
  const said = await untilAborted(ui.waitForAnswer("existing-tests"), signal);
  if (signal.aborted) {
    return ending(await stoppedHere(signal, options.drivenAgent.name, generated.root));
  }

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
      generated.root,
      "converting",
      convertInstructions({
        cwd,
        suiteDirectory: suite.directory,
        shown: existing.shown,
        content: existing.content,
        taken: namesOf((await contentsFor(paths, suite.id)).found),
        personas: generated.personas,
        limit: howMany,
      }),
      // Nobody knows how many rows are in there, least of all egma, so the
      // pane counts what turns up rather than promising a number.
      0,
    );
    if (halted !== null) return ending(halted);
  }

  const converted = (await contentsFor(paths, suite.id)).found;
  const missing = Math.max(howMany - converted.length, 0);
  if (missing === 0) {
    ui.pushStatus(
      `${ACTION_MARK} ${converted.length} tests came out of your own material, so Egma generated none.`,
    );
  } else {
    const context: GenerationContext = {
      cwd,
      suiteDirectory: suite.directory,
      facts: options.facts,
      prompt: options.source.prompt,
      toolCount: options.source.toolCount,
      agentName: options.registered.agent.name,
      taken: namesOf(converted),
      personas: generated.personas,
    };
    const halted = await writeFiles(
      options,
      paths,
      generated.root,
      "generating",
      generateInstructions(context, missing),
      missing,
    );
    if (halted !== null) return ending(halted);
  }

  const about = {
    agentName: options.registered.agent.name,
    connectionName: options.registered.connection.name,
    productLabel: options.registered.connection.productLabel,
    modality: options.registered.connection.modality,
    destination: destinationOf(options.registered.connection),
    suite: suite.name,
  };

  const written = await contentsFor(paths, suite.id);
  const writtenCount = (await namesInFolder(generated.root)).length;
  if (writtenCount !== howMany) {
    return ending({
      kind: "failed",
      reason:
        `${options.drivenAgent.name} left ${String(writtenCount)} ${writtenCount === 1 ? "test" : "tests"} in the first suite, ` +
        `but this setup requires exactly ${String(howMany)}. Keep exactly ${String(howMany)} test files there, then run the wizard again.`,
    });
  }
  const tooBroad = written.found.filter(
    (file) => file.test.expectedBehaviors.length > MAX_GENERATED_EXPECTED_BEHAVIORS,
  );
  if (tooBroad.length > 0) {
    return ending({
      kind: "failed",
      reason:
        `${options.drivenAgent.name} wrote more than ${String(MAX_GENERATED_EXPECTED_BEHAVIORS)} expected behaviors in ` +
        `${tooBroad.map((file) => file.shown).join(", ")}. Keep only the distinct requirements for each scenario, then run the wizard again.`,
    });
  }
  const usable = written.found.filter(
    (file) => file.test.expectedBehaviors.length > 0,
  );
  if (usable.length === 0 && written.unreadable.length === 0) {
    return ending({
      kind: "failed",
      reason: `${options.drivenAgent.name} wrote no test Egma could use. What it printed is in ${options.log.file}.`,
    });
  }

  // The lane's own work between the files landing and the list going up. On
  // LiveKit that is the mocked world; on Retell it is nothing, and nothing is
  // exactly what the developer sees.
  let changed: readonly string[] = [];
  if (usable.length > 0) {
    const between = await options.betweenWritingAndReview?.({
      tests: usable.map((file) => file.test.name),
      suiteDirectory: suite.directory,
    });
    if (between?.halted != null) return ending(between.halted);
    changed = between?.changed ?? [];
  }

  // Read again, because the step above may have written into these files and
  // into the mocked world beside them. What is on disk is what is agreed to.
  const contents = await contentsFor(paths, suite.id);
  const gate = gateFrom(contents, about, contents.mockTools, changed);
  for (const held of gate.heldBack) {
    ui.pushStatus(`${FAILURE_MARK} ${held.shown} was not pushed: ${held.reason}`);
  }
  if (gate.rows.length === 0 && gate.heldBack.length === 0) {
    return ending({
      kind: "failed",
      reason: `${options.drivenAgent.name} wrote no test Egma could use. What it printed is in ${options.log.file}.`,
    });
  }

  ui.setGate(gate);
  await untilAborted(ui.waitForGate("run-tests"), signal);
  ui.setGate(null);
  if (signal.aborted) {
    return ending({
      kind: "tests-kept",
      count: gate.rows.length,
      stopped: stopReasonOf(signal) !== "quit",
    });
  }

  // Re-read the complete repository after approval. Approval never means
  // permission to omit a held-back file.
  const reread = await contentsFor(paths, suite.id);
  const approved = gateFrom(reread, about, reread.mockTools, changed);
  if (approved.heldBack.length > 0) {
    return ending({
      kind: "failed",
      reason: `The complete suite was not pushed. Fix ${approved.heldBack.map((held) => held.shown).join(", ")}, then run the wizard again.`,
    });
  }
  const pushed = await pushGate(options, paths, suite.directory);
  if (pushed.pushed.length > 0) options.onReviewApproved?.(pushed.pushed.length);
  return { report: pushed.report, pushed: pushed.pushed, suite };
}
