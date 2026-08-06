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
import { runLoginCommand } from "./commands/login.ts";
import { resolvePlatformAccess, UnusableUrlError } from "./platform/credentials.ts";
import { HeadlessUI } from "./ui/headless-ui.ts";
import { startTui } from "./ui/tui/start-tui.ts";
import { buildExitLine, buildExitNotice, type ExitReport } from "./wizard/exit-line.ts";
import type { PlatformAccess } from "./wizard/login-step.ts";
import { pasteFallbackMessage } from "./wizard/no-coding-agent.ts";
import type { StopReason } from "./wizard/stop.ts";
import { walk } from "./wizard/walk.ts";

/**
 * The verbs. A bare `egma` runs the wizard; naming one runs it headlessly,
 * because a verb is what a coding agent types and a coding agent has no
 * keystroke to give.
 */
export const VERBS = ["login"] as const;

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
  /**
   * A test seam, not product surface: `-- <command>` starts a scripted agent in
   * place of a real one. It is not documented and it is not stable.
   */
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
    case "found-agent":
    case "quit":
    // egma did everything it could here: it named what is missing and handed
    // over words that work without it. That is the run finishing, not failing.
    case "no-coding-agent":
      return 0;
    case "interrupted":
      return 130;
    case "no-agent-context":
    // The coding agent stopped the work itself. Nothing was found, and the run
    // did not do what it set out to do.
    case "coding-agent-stopped":
    case "failed":
      return 1;
  }
}

async function runHeadless(
  launch: DrivenAgentLaunch,
  cwd: string,
  platform: PlatformAccess,
): Promise<number> {
  const controller = new AbortController();
  const stop = (reason: StopReason): void => controller.abort(reason);
  const onSignal = (): void => stop("interrupt");
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  const ui = new HeadlessUI({ write: (line) => process.stdout.write(`${line}\n`) });
  try {
    const report = await walk({ ui, launch, cwd, signal: controller.signal, platform });
    const notice = buildExitNotice(report);
    if (notice !== null) process.stdout.write(`${notice}\n\n`);
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
  platform: PlatformAccess,
): Promise<number> {
  const controller = new AbortController();
  const tui = startTui({ stop: (reason) => controller.abort(reason) });

  // A signal can arrive when the terminal cannot deliver a keystroke, so the
  // same teardown is wired to both.
  const onSignal = (): void => controller.abort("interrupt");
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  try {
    const report = await walk({ ui: tui.ui, launch, cwd, signal: controller.signal, platform });
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
      // There is no coding agent here for egma to drive, so there is nothing to
      // open a wizard for. The developer gets the words that work anyway.
      process.stdout.write(`${error.message}\n\n${pasteFallbackMessage()}\n`);
      return;
    }
    throw error;
  }

  process.exitCode = invocation.headless
    ? await runHeadless(launch, cwd, access)
    : await runWizard(launch, cwd, access);
}
