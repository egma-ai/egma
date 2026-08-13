/**
 * What egma can work out about this machine without asking anybody.
 *
 * Three facts, all of them free: which coding agent egma is about to drive,
 * whether this folder is a git repository, and whether somebody has already
 * been here — an `egma/` folder with tests in it means a teammate onboarded
 * this repository and this developer's path is the shorter one.
 *
 * It is worked out while the developer is reading the intro and shown while
 * they are away in a browser, because that is the only dead time the wizard
 * has. Nothing waits on it and no step reads it: it is for the screen.
 */

import { readdir, stat } from "node:fs/promises";
import path from "node:path";

import {
  FOLDER_NAME,
  isTestFileName,
  TESTS_FOLDER_NAME,
} from "../folder/egma-folder.ts";

export type Detection = {
  /** The coding agent egma will drive, or `null` when there is none yet. */
  readonly drivenAgentName: string | null;
  /** Whether the folder is inside a git repository. */
  readonly gitRepository: boolean;
  /** How many test files an egma folder here already holds. */
  readonly testsAlreadyHere: number;
  /** Whether there is an egma folder here at all. */
  readonly egmaFolder: boolean;
};

async function isFolder(candidate: string): Promise<boolean> {
  try {
    return (await stat(candidate)).isDirectory();
  } catch {
    return false;
  }
}

/** Whether this folder, or one above it, is a git repository. */
async function insideGit(from: string): Promise<boolean> {
  let at = path.resolve(from);
  for (;;) {
    if (await isFolder(path.join(at, ".git"))) return true;
    const above = path.dirname(at);
    if (above === at) return false;
    at = above;
  }
}

/** Everything egma can see for itself, for the screen to draw. */
export async function detect(options: {
  readonly cwd: string;
  readonly drivenAgentName: string | null;
}): Promise<Detection> {
  const folder = path.join(options.cwd, FOLDER_NAME);
  const tests = path.join(folder, TESTS_FOLDER_NAME);

  const [gitRepository, egmaFolder, names] = await Promise.all([
    insideGit(options.cwd),
    isFolder(folder),
    readdir(tests).catch(() => [] as string[]),
  ]);

  return {
    drivenAgentName: options.drivenAgentName,
    gitRepository,
    egmaFolder,
    testsAlreadyHere: names.filter(isTestFileName).length,
  };
}

/**
 * The facts as lines, said the same way wherever they are shown.
 *
 * A fact that is not true yet is still a line, because "no egma folder here"
 * is what tells a developer this is the first time anybody has done this in
 * their repository.
 */
export function detectionLines(detection: Detection): readonly string[] {
  const lines: string[] = [];
  if (detection.drivenAgentName !== null) {
    lines.push(`Coding agent   ${detection.drivenAgentName}`);
  }
  lines.push(`Git            ${detection.gitRepository ? "this is a repository" : "not a repository"}`);
  lines.push(
    `egma folder    ${
      detection.egmaFolder
        ? `already here, ${detection.testsAlreadyHere} ${detection.testsAlreadyHere === 1 ? "test" : "tests"} in it`
        : "none yet — egma will make one"
    }`,
  );
  return lines;
}
