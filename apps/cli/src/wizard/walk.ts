/**
 * The walk: what the wizard actually does, once, from start to exit line.
 *
 * Today it is one task, which is the point — it proves the whole path (start
 * the developer's coding agent, drive it, show every action, leave one line
 * behind) before any product flow rides on it. The flow never draws anything
 * and never reads a keystroke: it pushes state at the UI and parks on a gate.
 */

import { readdir, stat } from "node:fs/promises";
import path from "node:path";

import { driveOneTask, type DriveResult } from "../acp/drive.ts";
import type { DrivenAgentLaunch } from "../acp/registry.ts";
import type { WizardUI } from "../ui/wizard-ui.ts";
import { openDrivenAgentLog, type DrivenAgentLog } from "./driven-agent-log.ts";
import type { ExitReport } from "./exit-line.ts";
import { stopReport, untilAborted } from "./stop.ts";

/**
 * Files a repository is likely to have that say what it is in a few lines. The
 * task is trivial on purpose; the point is the path, not the answer.
 */
const PREFERRED_FILES = [
  "package.json",
  "pyproject.toml",
  "go.mod",
  "Cargo.toml",
  "README.md",
];

export type WalkOptions = {
  readonly ui: WizardUI;
  readonly launch: DrivenAgentLaunch;
  readonly cwd: string;
  /** The file the agent is asked about. Chosen from the folder when omitted. */
  readonly file?: string;
  readonly signal: AbortSignal;
  /** Where the agent's own output is kept. A fresh file per run by default. */
  readonly log?: DrivenAgentLog;
};

async function isFile(candidate: string): Promise<boolean> {
  try {
    return (await stat(candidate)).isFile();
  } catch {
    return false;
  }
}

/** A file in this folder for the agent to read, or `null` when there is none. */
export async function chooseFile(cwd: string): Promise<string | null> {
  for (const name of PREFERRED_FILES) {
    if (await isFile(path.join(cwd, name))) return name;
  }
  const entries = await readdir(cwd, { withFileTypes: true });
  const plain = entries.find((entry) => entry.isFile() && !entry.name.startsWith("."));
  return plain?.name ?? null;
}

/** What egma asks the agent to do. One file, one sentence, no changes. */
export function instructionsFor(file: string): string {
  return [
    `Read the file ${file} in the current folder.`,
    "Then reply with one short sentence saying what it is.",
    "Do not change any file, and do not run any command.",
  ].join(" ");
}

function reportFor(
  result: DriveResult,
  drivenAgentName: string,
  file: string,
  signal: AbortSignal,
): ExitReport {
  switch (result.kind) {
    case "done":
      return { kind: "task-done", drivenAgentName, file };
    case "interrupted":
      return stopReport(signal, drivenAgentName);
    case "needs-login":
      return {
        kind: "failed",
        reason: `${result.drivenAgentName} is not logged in. Log in to it, then run egma again.`,
      };
    case "failed":
      return { kind: "failed", reason: result.reason };
  }
}

/** Runs the walk and returns the line the wizard will leave behind. */
export async function walk(options: WalkOptions): Promise<ExitReport> {
  const { ui, launch, cwd, signal } = options;

  ui.setDrivenAgent({ id: launch.id, name: launch.name });

  const log = options.log ?? openDrivenAgentLog();
  ui.setDrivenAgentLog(log.file);

  const file = options.file ?? (await chooseFile(cwd));
  if (file === null) {
    const report: ExitReport = {
      kind: "failed",
      reason:
        "there is no file in this folder for your coding agent to read. Run egma inside your repository.",
    };
    ui.setExit(report);
    return report;
  }
  ui.setTaskFile(file);

  await untilAborted(ui.waitForGate("begin"), signal);
  if (signal.aborted) {
    const report = stopReport(signal, launch.name);
    ui.setExit(report);
    return report;
  }

  ui.taskStarted();
  const result = await driveOneTask({
    launch,
    cwd,
    instructions: instructionsFor(file),
    ui,
    signal,
    logStderr: (chunk) => log.write(chunk),
  });
  ui.taskFinished();

  if (result.kind === "done") ui.setSummary(result.summary);
  // A failure is the one time the agent's own output is worth reading, so it is
  // the one time the developer is told where it is.
  if (result.kind === "failed" || result.kind === "needs-login") {
    ui.pushStatus(`What ${launch.name} itself printed is in ${log.file}`);
  }

  const report = reportFor(result, launch.name, file, signal);
  ui.setExit(report);
  return report;
}
