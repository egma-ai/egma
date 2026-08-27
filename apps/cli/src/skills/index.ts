/**
 * The instructions Egma gives coding agents.
 *
 * Public Agent Skills are authored once in the repository-root `skills/` tree.
 * `tools/project-agent-skills.mjs` projects those exact bytes into this npm
 * package, so the CLI can read the release snapshot without a network or a
 * checkout. The wizard composes those public instructions with its own task
 * protocol instead of maintaining another authored copy.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export type PublicSkillName =
  | "egma"
  | "integrate-egma"
  | "write-egma-tests";
export const PUBLIC_SKILL_NAMES: readonly PublicSkillName[] = [
  "egma",
  "integrate-egma",
  "write-egma-tests",
];

export const SKILLS_DIRECTORY = "skills";

const cache = new Map<string, string>();

function packageFile(relative: string): string {
  return fileURLToPath(new URL(`../../${relative}`, import.meta.url));
}

/**
 * The whole projected skills tree inside this package.
 *
 * It is what the end-of-wizard offer points the skills CLI at: one directory
 * holding one directory per skill, which is the shape that installer reads.
 */
export function publicSkillsDirectory(): string {
  return packageFile(SKILLS_DIRECTORY);
}

/** One public Agent Skill in the package projection. */
export function publicSkillFile(name: PublicSkillName): string {
  return packageFile(`${SKILLS_DIRECTORY}/${name}/SKILL.md`);
}

/** The folder relative references in a projected public skill resolve from. */
export function publicSkillDirectory(name: PublicSkillName): string {
  return packageFile(`${SKILLS_DIRECTORY}/${name}/`);
}

function contentAt(file: string): string {
  const held = cache.get(file);
  if (held !== undefined) return held;
  const content = readFileSync(file, "utf8").trimEnd();
  cache.set(file, content);
  return content;
}

export function publicSkill(name: PublicSkillName): string {
  return contentAt(publicSkillFile(name));
}

/** The public skill that teaches a coding agent to drive Egma afterwards. */
export const DRIVING_SKILL_PATH = `${SKILLS_DIRECTORY}/egma/SKILL.md`;

export function drivingSkillFile(): string {
  return publicSkillFile("egma");
}

export function drivingSkill(): string {
  return publicSkill("egma");
}

/**
 * Compose reusable instruction content before the run-specific task.
 *
 * Public skills and task-specific adapter text are already complete strings
 * here. The caller therefore makes the delivery seam visible instead of
 * hiding a public skill behind an internal alias.
 */
export function instructionsWith(parts: readonly string[], task: string): string {
  return [...parts, task.trim()].join("\n\n---\n\n");
}
