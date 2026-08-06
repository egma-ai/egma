/**
 * What `egma` does with the words after it.
 *
 * A bare invocation runs the wizard. Everything else is a flag on the same
 * walk, because the wizard is a skin over the same code and never a second path
 * through it.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import {
  DEFAULT_DRIVEN_AGENT_ID,
  REGISTRY_SNAPSHOT_MIRRORED_ON,
  UnlaunchableDrivenAgentError,
  launchForId,
  type DrivenAgentLaunch,
} from "./acp/registry.ts";
import type { FolderCommandOptions } from "./commands/folder-verbs.ts";
import { runInitCommand } from "./commands/init.ts";
import { runLoginCommand } from "./commands/login.ts";
import { runPullCommand } from "./commands/pull.ts";
import { runPushCommand } from "./commands/push.ts";
import { resolvePlatformAccess, UnusableUrlError } from "./platform/credentials.ts";
import { HeadlessUI } from "./ui/headless-ui.ts";
import { buildExitLine, type ExitReport } from "./wizard/exit-line.ts";
import type { PlatformAccess } from "./wizard/login-step.ts";
import type { StopReason } from "./wizard/stop.ts";

/**
 * The wizard's machinery arrives through a dynamic import, and the verbs never
 * ask for it.
 *
 * A terminal renderer and a protocol client are the two most expensive things
 * this package loads, and a headless verb uses neither — it prints lines and
 * talks to egma over HTTP. Loading them anyway put a quarter of a second in
 * front of every `egma login`, `egma pull` and `egma push`, which is time a
 * coding agent driving the product pays on every single call.
 */
async function wizardMachinery(): Promise<{
  readonly startTui: typeof import("./ui/tui/start-tui.ts").startTui;
  readonly walk: typeof import("./wizard/walk.ts").walk;
}> {
  const [{ startTui }, { walk }] = await Promise.all([
    import("./ui/tui/start-tui.ts"),
    import("./wizard/walk.ts"),
  ]);
  return { startTui, walk };
}

/**
 * The verbs. A bare `egma` runs the wizard; naming one runs it headlessly,
 * because a verb is what a coding agent types and a coding agent has no
 * keystroke to give.
 */
export const VERBS = ["login", "init", "pull", "push"] as const;

export type Verb = (typeof VERBS)[number];

export type Invocation = {
  readonly help: boolean;
  readonly version: boolean;
  /** The verb that was named, or `null` for the wizard. */
  readonly verb: Verb | null;
  /** The developer has said, in the command, to run with nobody watching. */
  readonly headless: boolean;
  readonly drivenAgentId: string;
  readonly cwd: string | null;
  /** `--url`: which egma to talk to, when it is not egma's own. */
  readonly url: string | null;
  /** `--force`: do the work again even though it has been done. */
  readonly force: boolean;
  /** What `egma init` should write into the folder's config file. */
  readonly agentName: string | null;
  readonly connectionName: string | null;
  readonly suiteName: string | null;
  /**
   * A test seam, not product surface: `--file` and `-- <command>` let a test
   * pin the file and start a scripted agent in place of a real one. Neither is
   * documented, and neither is stable.
   */
  readonly file: string | null;
  /** A command to start as the coding agent, in place of a registry lookup. */
  readonly drivenAgentCommand: readonly string[];
  readonly unknown: readonly string[];
};

function isVerb(argument: string): argument is Verb {
  return (VERBS as readonly string[]).includes(argument);
}

export function parseArgs(argv: readonly string[]): Invocation {
  let help = false;
  let version = false;
  let verb: Verb | null = null;
  let headless = false;
  let drivenAgentId = DEFAULT_DRIVEN_AGENT_ID;
  let cwd: string | null = null;
  let url: string | null = null;
  let force = false;
  let agentName: string | null = null;
  let connectionName: string | null = null;
  let suiteName: string | null = null;
  let file: string | null = null;
  let drivenAgentCommand: string[] = [];
  const unknown: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] as string;
    if (argument === "--") {
      drivenAgentCommand = argv.slice(index + 1) as string[];
      break;
    }
    if (argument === "-h" || argument === "--help") help = true;
    else if (argument === "-v" || argument === "--version") version = true;
    else if (argument === "--headless") headless = true;
    else if (argument === "--coding-agent") drivenAgentId = argv[(index += 1)] ?? drivenAgentId;
    else if (argument === "--cwd") cwd = argv[(index += 1)] ?? null;
    else if (argument === "--url") url = argv[(index += 1)] ?? null;
    else if (argument === "--force") force = true;
    else if (argument === "--agent") agentName = argv[(index += 1)] ?? null;
    else if (argument === "--connection") connectionName = argv[(index += 1)] ?? null;
    else if (argument === "--suite") suiteName = argv[(index += 1)] ?? null;
    else if (argument === "--file") file = argv[(index += 1)] ?? null;
    else if (verb === null && isVerb(argument)) verb = argument;
    else unknown.push(argument);
  }

  return {
    help,
    version,
    verb,
    headless,
    drivenAgentId,
    cwd,
    url,
    force,
    agentName,
    connectionName,
    suiteName,
    file,
    drivenAgentCommand,
    unknown,
  };
}

export function helpText(): string {
  return [
    "egma — walk from a voice agent to graded results.",
    "",
    "Usage:",
    "  egma [options]           The wizard.",
    "  egma login [options]     Sign this machine in. No questions, plain lines.",
    "  egma init [options]      Make the egma folder this repository's tests",
    "                           live in. Safe to run again.",
    "  egma pull [options]      Write egma's current test versions into it.",
    "  egma push [options]      Upload the tests in it. Refuses, naming names,",
    "                           when egma has moved on since your last pull.",
    "",
    "Options:",
    "  --coding-agent <id>  Which coding agent to drive, named as the agent",
    `                       registry names it. Default: ${DEFAULT_DRIVEN_AGENT_ID}`,
    "  --cwd <path>         The folder to work in. Default: this folder.",
    "  --url <address>      The egma to talk to, for a self-hosted one. Kept",
    "                       after the first login, so it is set once. EGMA_URL",
    "                       does the same for a whole shell.",
    "  --force              With login: sign in again even when this machine",
    "                       already holds a key.",
    "  --agent <name>       With init: what to call the voice agent this",
    "                       folder's tests are for.",
    "  --connection <name>  With init: what to call the way egma reaches it.",
    "  --suite <name>       With init: what to call this folder's test suite.",
    "  --headless           Run with no terminal and no keystroke: plain lines,",
    "                       and the task taken as already agreed to.",
    "  -h, --help           Print this.",
    "  -v, --version        Print the version.",
    "",
    "Environment:",
    "  EGMA_URL             The egma to talk to, for a whole shell. Same as --url.",
    "  EGMA_HOME            The folder egma keeps this machine's key in.",
    "                       Default: ~/.egma",
    "",
    "What egma login prints, one fact per line:",
    "  url, code, approve_url, browser, waiting, status, credentials",
    "",
    "What egma login answers with:",
    "  0 signed in   2 denied   3 the code ran out",
    "  4 egma did not answer, or refused   130 stopped part way",
    "",
    "What egma init, pull and push print, one fact per line:",
    "  url, folder, and then one line per test: what happened to it, the file,",
    "  and the version the file now pins. push names every conflicting test on",
    "  its own conflict: line.",
    "",
    "What egma init, pull and push answer with:",
    "  0 done   1 no egma folder here   2 not signed in",
    "  4 egma did not answer, or refused",
    "  5 push refused: egma has moved on, pull first",
    "  6 egma turned a test away at its door   130 stopped part way",
    "",
    `The agent registry was mirrored on ${REGISTRY_SNAPSHOT_MIRRORED_ON}.`,
  ].join("\n");
}

/** What a developer is told when the wizard has no terminal to run in. */
export function noTerminalRefusal(): string {
  return [
    "egma's wizard needs a terminal it can draw on and read one keystroke from, and this is not one. Nothing was started.",
    "",
    "That keystroke is how you agree to egma driving your coding agent, so egma will not drive it without one.",
    "",
    "Run egma --headless to say here and now that you agree, and to get plain lines instead of a wizard. Run egma --help for the rest.",
  ].join("\n");
}

export function version(): string {
  const manifest = readFileSync(new URL("../package.json", import.meta.url), "utf8");
  return (JSON.parse(manifest) as { version?: string }).version ?? "0.0.0";
}

function launchFrom(invocation: Invocation): DrivenAgentLaunch {
  const [command, ...args] = invocation.drivenAgentCommand;
  if (command !== undefined) {
    // egma was told a command, not an agent, so the command is all it can
    // honestly call the thing.
    return { id: "named-command", name: path.basename(command), command, args, env: {} };
  }
  return launchForId(invocation.drivenAgentId);
}

/** What the whole walk answers with, which is not what `egma login` answers. */
function walkExitCode(report: ExitReport): number {
  switch (report.kind) {
    case "task-done":
    case "quit":
      return 0;
    case "interrupted":
      return 130;
    case "failed":
      return 1;
  }
}

async function runHeadless(
  launch: DrivenAgentLaunch,
  cwd: string,
  file: string | null,
  platform: PlatformAccess,
): Promise<number> {
  const controller = new AbortController();
  const stop = (reason: StopReason): void => controller.abort(reason);
  const onSignal = (): void => stop("interrupt");
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  const { walk } = await wizardMachinery();
  const ui = new HeadlessUI({ write: (line) => process.stdout.write(`${line}\n`) });
  try {
    const report = await walk({
      ui,
      launch,
      cwd,
      signal: controller.signal,
      platform,
      ...(file === null ? {} : { file }),
    });
    process.stdout.write(`${buildExitLine(report)}\n`);
    return walkExitCode(report);
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

async function runWizard(
  launch: DrivenAgentLaunch,
  cwd: string,
  file: string | null,
  platform: PlatformAccess,
): Promise<number> {
  const { startTui, walk } = await wizardMachinery();
  const controller = new AbortController();
  const tui = startTui({ stop: (reason) => controller.abort(reason) });

  // A signal can arrive when the terminal cannot deliver a keystroke, so the
  // same teardown is wired to both.
  const onSignal = (): void => controller.abort("interrupt");
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  try {
    const report = await walk({
      ui: tui.ui,
      launch,
      cwd,
      signal: controller.signal,
      platform,
      ...(file === null ? {} : { file }),
    });
    tui.close(report);
    return walkExitCode(report);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    tui.close({ kind: "failed", reason });
    return 1;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

/**
 * The folder verbs: no terminal needed, no keystroke taken, no question asked.
 *
 * One runner for the three of them, because what they share is everything a
 * caller sees — where they work, where they print, and that a signal stops them
 * rather than leaving half a folder behind.
 */
async function runFolderVerb(
  verb: "init" | "pull" | "push",
  invocation: Invocation,
  access: PlatformAccess,
): Promise<number> {
  const controller = new AbortController();
  const onSignal = (): void => controller.abort("interrupt");
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  const options: FolderCommandOptions = {
    access,
    cwd: path.resolve(invocation.cwd ?? process.cwd()),
    out: (line) => void process.stdout.write(`${line}\n`),
    fail: (line) => void process.stderr.write(`${line}\n`),
  };

  try {
    if (verb === "init") {
      return await runInitCommand({
        ...options,
        names: {
          agent: invocation.agentName,
          connection: invocation.connectionName,
          suite: invocation.suiteName,
        },
      });
    }
    return verb === "pull" ? await runPullCommand(options) : await runPushCommand(options);
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

/** The login verb: no terminal needed, no keystroke taken, no question asked. */
async function runLogin(invocation: Invocation, access: PlatformAccess): Promise<number> {
  const controller = new AbortController();
  const onSignal = (): void => controller.abort("interrupt");
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  try {
    return await runLoginCommand({
      access,
      force: invocation.force,
      env: process.env,
      signal: controller.signal,
      out: (line) => process.stdout.write(`${line}\n`),
      fail: (line) => process.stderr.write(`${line}\n`),
    });
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

export async function main(argv: readonly string[]): Promise<void> {
  const invocation = parseArgs(argv);

  if (invocation.help) {
    process.stdout.write(`${helpText()}\n`);
    return;
  }
  if (invocation.version) {
    process.stdout.write(`${version()}\n`);
    return;
  }
  if (invocation.unknown.length > 0) {
    process.stderr.write(
      `egma does not know the option ${invocation.unknown[0]}. Run egma --help to see the ones it does.\n`,
    );
    process.exitCode = 1;
    return;
  }

  // Which egma, resolved once for every path below, and refused here when the
  // address a developer named is not one. A bad address is turned away before
  // anything is started on it rather than after.
  let access: PlatformAccess;
  try {
    access = await resolvePlatformAccess({ env: process.env, flag: invocation.url });
  } catch (error) {
    if (error instanceof UnusableUrlError) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  // A verb needs no terminal and takes no keystroke: it drives no coding agent,
  // so there is nothing for a keystroke to agree to.
  if (invocation.verb === "login") {
    process.exitCode = await runLogin(invocation, access);
    return;
  }
  if (
    invocation.verb === "init" ||
    invocation.verb === "pull" ||
    invocation.verb === "push"
  ) {
    process.exitCode = await runFolderVerb(invocation.verb, invocation, access);
    return;
  }

  // The wizard earns consent with one keystroke, and a terminal that cannot
  // deliver one cannot give it. Falling back to a run nobody agreed to would
  // drive the developer's coding agent because a pipe was on the end of the
  // command, so egma refuses and names the flag that means "I agree".
  const drawable = process.stdout.isTTY === true && process.stdin.isTTY === true;
  if (!invocation.headless && !drawable) {
    process.stderr.write(`${noTerminalRefusal()}\n`);
    process.exitCode = 1;
    return;
  }

  const cwd = path.resolve(invocation.cwd ?? process.cwd());

  let launch: DrivenAgentLaunch;
  try {
    launch = launchFrom(invocation);
  } catch (error) {
    if (error instanceof UnlaunchableDrivenAgentError) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  process.exitCode = invocation.headless
    ? await runHeadless(launch, cwd, invocation.file, access)
    : await runWizard(launch, cwd, invocation.file, access);
}
