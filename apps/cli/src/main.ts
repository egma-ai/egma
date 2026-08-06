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
  DEFAULT_AGENT_ID,
  REGISTRY_SNAPSHOT_MIRRORED_ON,
  UnlaunchableAgentError,
  launchForId,
  type AgentLaunch,
} from "./acp/registry.ts";
import { HeadlessUI } from "./ui/headless-ui.ts";
import { startTui } from "./ui/tui/start-tui.ts";
import { buildExitLine, type ExitReport } from "./wizard/exit-line.ts";
import type { StopReason } from "./wizard/stop.ts";
import { walk } from "./wizard/walk.ts";

export type Invocation = {
  readonly help: boolean;
  readonly version: boolean;
  readonly headless: boolean;
  readonly agentId: string;
  readonly cwd: string | null;
  readonly file: string | null;
  /** A command to start as the agent, in place of a registry lookup. */
  readonly agentCommand: readonly string[];
  readonly unknown: readonly string[];
};

export function parseArgs(argv: readonly string[]): Invocation {
  let help = false;
  let version = false;
  let headless = false;
  let agentId = DEFAULT_AGENT_ID;
  let cwd: string | null = null;
  let file: string | null = null;
  let agentCommand: string[] = [];
  const unknown: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] as string;
    if (argument === "--") {
      agentCommand = argv.slice(index + 1) as string[];
      break;
    }
    if (argument === "-h" || argument === "--help") help = true;
    else if (argument === "-v" || argument === "--version") version = true;
    else if (argument === "--headless") headless = true;
    else if (argument === "--agent") agentId = argv[(index += 1)] ?? agentId;
    else if (argument === "--cwd") cwd = argv[(index += 1)] ?? null;
    else if (argument === "--file") file = argv[(index += 1)] ?? null;
    else unknown.push(argument);
  }

  return { help, version, headless, agentId, cwd, file, agentCommand, unknown };
}

export function helpText(): string {
  return [
    "egma — walk from a voice agent to graded results.",
    "",
    "Usage:",
    "  egma [options] [-- <command> [args...]]",
    "",
    "Options:",
    "  --agent <id>    Which coding agent to drive, named as the agent registry",
    `                  names it. Default: ${DEFAULT_AGENT_ID}`,
    "  --file <path>   The file the agent is asked to read.",
    "  --cwd <path>    The folder to work in. Default: this folder.",
    "  --headless      Run without the terminal UI and print plain lines.",
    "  -h, --help      Print this.",
    "  -v, --version   Print the version.",
    "",
    "  -- <command>    Start this command as the coding agent, instead of looking",
    "                  one up in the agent registry.",
    "",
    `The agent registry was mirrored on ${REGISTRY_SNAPSHOT_MIRRORED_ON}.`,
  ].join("\n");
}

export function version(): string {
  const manifest = readFileSync(new URL("../package.json", import.meta.url), "utf8");
  return (JSON.parse(manifest) as { version?: string }).version ?? "0.0.0";
}

function launchFrom(invocation: Invocation): AgentLaunch {
  const [command, ...args] = invocation.agentCommand;
  if (command !== undefined) {
    // egma was told a command, not an agent, so the command is all it can
    // honestly call the thing.
    return { id: "named-command", name: path.basename(command), command, args, env: {} };
  }
  return launchForId(invocation.agentId);
}

function exitCodeFor(report: ExitReport): number {
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

async function runHeadless(launch: AgentLaunch, cwd: string, file: string | null): Promise<number> {
  const controller = new AbortController();
  const stop = (reason: StopReason): void => controller.abort(reason);
  const onSignal = (): void => stop("interrupt");
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  const ui = new HeadlessUI({ write: (line) => process.stdout.write(`${line}\n`) });
  try {
    const report = await walk({
      ui,
      launch,
      cwd,
      signal: controller.signal,
      ...(file === null ? {} : { file }),
    });
    process.stdout.write(`${buildExitLine(report)}\n`);
    return exitCodeFor(report);
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

async function runWizard(launch: AgentLaunch, cwd: string, file: string | null): Promise<number> {
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
      ...(file === null ? {} : { file }),
    });
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

  const cwd = path.resolve(invocation.cwd ?? process.cwd());

  let launch: AgentLaunch;
  try {
    launch = launchFrom(invocation);
  } catch (error) {
    if (error instanceof UnlaunchableAgentError) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  // A terminal that cannot deliver a keystroke cannot run the wizard, so the
  // same walk runs as plain lines rather than as a UI nobody can answer.
  const drawable = process.stdout.isTTY === true && process.stdin.isTTY === true;
  process.exitCode =
    invocation.headless || !drawable
      ? await runHeadless(launch, cwd, invocation.file)
      : await runWizard(launch, cwd, invocation.file);
}
