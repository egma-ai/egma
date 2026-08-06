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
import { HeadlessUI } from "./ui/headless-ui.ts";
import { startTui } from "./ui/tui/start-tui.ts";
import { buildExitLine, buildExitNotice, type ExitReport } from "./wizard/exit-line.ts";
import { pasteFallbackMessage } from "./wizard/no-coding-agent.ts";
import type { StopReason } from "./wizard/stop.ts";
import { walk } from "./wizard/walk.ts";

export type Invocation = {
  readonly help: boolean;
  readonly version: boolean;
  /** The developer has said, in the command, to run with nobody watching. */
  readonly headless: boolean;
  readonly drivenAgentId: string;
  readonly cwd: string | null;
  /**
   * A test seam, not product surface: `-- <command>` starts a scripted agent in
   * place of a real one. It is not documented and it is not stable.
   */
  readonly drivenAgentCommand: readonly string[];
  readonly unknown: readonly string[];
};

export function parseArgs(argv: readonly string[]): Invocation {
  let help = false;
  let version = false;
  let headless = false;
  let drivenAgentId = DEFAULT_DRIVEN_AGENT_ID;
  let cwd: string | null = null;
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
    else unknown.push(argument);
  }

  return { help, version, headless, drivenAgentId, cwd, drivenAgentCommand, unknown };
}

export function helpText(): string {
  return [
    "egma — walk from a voice agent to graded results.",
    "",
    "Usage:",
    "  egma [options]",
    "",
    "Options:",
    "  --coding-agent <id>  Which coding agent to drive, named as the agent",
    `                       registry names it. Default: ${DEFAULT_DRIVEN_AGENT_ID}`,
    "  --cwd <path>         The folder to work in. Default: this folder.",
    "  --headless           Run with no terminal and no keystroke: plain lines,",
    "                       and the task taken as already agreed to.",
    "  -h, --help           Print this.",
    "  -v, --version        Print the version.",
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

function exitCodeFor(report: ExitReport): number {
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
    case "failed":
      return 1;
  }
}

async function runHeadless(launch: DrivenAgentLaunch, cwd: string): Promise<number> {
  const controller = new AbortController();
  const stop = (reason: StopReason): void => controller.abort(reason);
  const onSignal = (): void => stop("interrupt");
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  const ui = new HeadlessUI({ write: (line) => process.stdout.write(`${line}\n`) });
  try {
    const report = await walk({ ui, launch, cwd, signal: controller.signal });
    const notice = buildExitNotice(report);
    if (notice !== null) process.stdout.write(`${notice}\n\n`);
    process.stdout.write(`${buildExitLine(report)}\n`);
    return exitCodeFor(report);
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

async function runWizard(launch: DrivenAgentLaunch, cwd: string): Promise<number> {
  const controller = new AbortController();
  const tui = startTui({ stop: (reason) => controller.abort(reason) });

  // A signal can arrive when the terminal cannot deliver a keystroke, so the
  // same teardown is wired to both.
  const onSignal = (): void => controller.abort("interrupt");
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  try {
    const report = await walk({ ui: tui.ui, launch, cwd, signal: controller.signal });
    tui.close(report);
    return exitCodeFor(report);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    tui.close({ kind: "failed", reason });
    return 1;
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
    ? await runHeadless(launch, cwd)
    : await runWizard(launch, cwd);
}
