/**
 * The walk: what the wizard actually does, once, from start to exit line.
 *
 * Today it is one task, which is the point — it proves the whole path (start
 * the developer's agent, drive it, show every action, leave one line behind)
 * before any product flow rides on it. The flow never draws anything and never
 * reads a keystroke: it pushes state at the UI and parks on a gate.
 */

import { readdir, stat } from "node:fs/promises";
import path from "node:path";

import { driveOneTask, type TaskOutcome } from "../acp/drive.ts";
import type { AgentLaunch } from "../acp/registry.ts";
import type { WizardUI } from "../ui/wizard-ui.ts";
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
  readonly launch: AgentLaunch;
  readonly cwd: string;
  /** The file the agent is asked about. Chosen from the folder when omitted. */
  readonly file?: string;
  readonly signal: AbortSignal;
  readonly logStderr?: (chunk: string) => void;
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
  outcome: TaskOutcome,
  agentName: string,
  file: string,
  signal: AbortSignal,
): ExitReport {
  switch (outcome.kind) {
    case "done":
      return { kind: "task-done", agentName, file };
    case "interrupted":
      return stopReport(signal, agentName);
    case "needs-login":
      return {
        kind: "failed",
        reason: `${outcome.agentName} is not logged in. Log in to it, then run egma again.`,
      };
    case "failed":
      return { kind: "failed", reason: outcome.reason };
  }
}

/** Runs the walk and returns the line the wizard will leave behind. */
export async function walk(options: WalkOptions): Promise<ExitReport> {
  const { ui, launch, cwd, signal } = options;

  ui.setAgent({ id: launch.id, name: launch.name });

  const file = options.file ?? (await chooseFile(cwd));
  if (file === null) {
    const report: ExitReport = {
      kind: "failed",
      reason: "there is no file in this folder for the agent to read. Run egma inside your repository.",
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
  const outcome = await driveOneTask({
    launch,
    cwd,
    instructions: instructionsFor(file),
    ui,
    signal,
    ...(options.logStderr === undefined ? {} : { logStderr: options.logStderr }),
  });
  ui.taskFinished();

  if (outcome.kind === "done") ui.setSummary(outcome.summary);

  const report = reportFor(outcome, launch.name, file, signal);
  ui.setExit(report);
  return report;
}
