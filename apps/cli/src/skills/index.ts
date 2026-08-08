/**
 * egma's skills: content, not code.
 *
 * A skill is a markdown file that teaches a coding agent one concern. It ships
 * inside this package and it is read out of the package at dispatch time and
 * put at the top of the task's instructions. Nothing is installed, nothing is
 * copied, and nothing is written to the developer's disk while the wizard runs
 * — a skill reaches the coding agent the same way a sentence does.
 *
 * The files sit beside `dist` rather than inside it, at the same depth from
 * this module either way, so the one relative path works in the source tree, in
 * the built output, and in the published package.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** One skill, named by its file. */
export type SkillName = "context-finding" | "retell" | "writing-tests";

export const SKILL_NAMES: readonly SkillName[] = ["context-finding", "retell", "writing-tests"];

/** Where the packaged skill files live, relative to the package root. */
export const SKILLS_DIRECTORY = "skills";

const cache = new Map<SkillName, string>();

/** The absolute path of a skill's file, wherever this package is running from. */
export function skillFile(name: SkillName): string {
  return fileURLToPath(new URL(`../../${SKILLS_DIRECTORY}/${name}.md`, import.meta.url));
}

/**
 * The one skill egma offers to *install* rather than to send.
 *
 * It ships as `skills/egma/SKILL.md` — a directory and a file name, rather
 * than one flat markdown file like the sent ones — because that is the shape a
 * coding agent reads a skill in, and the install is a copy of this file to the
 * same file name somewhere else. Keeping it in that shape here means the thing
 * that ships is the thing that lands.
 */
export const INSTALLABLE_SKILL_PATH = `${SKILLS_DIRECTORY}/egma/SKILL.md`;

/** Where the installable skill is, wherever this package is running from. */
export function installableSkillFile(): string {
  return fileURLToPath(new URL(`../../${INSTALLABLE_SKILL_PATH}`, import.meta.url));
}

let installable: string | null = null;

/** Its content, read from the package. */
export function installableSkill(): string {
  installable ??= readFileSync(installableSkillFile(), "utf8").trimEnd();
  return installable;
}

/** A skill's content, read from the package. */
export function skill(name: SkillName): string {
  const held = cache.get(name);
  if (held !== undefined) return held;
  const content = readFileSync(skillFile(name), "utf8").trimEnd();
  cache.set(name, content);
  return content;
}

/**
 * The instructions for one dispatched task: the skills it needs, then the task
 * itself. The skills come first because they are what the coding agent has to
 * know before the task makes sense, and last place in a long prompt is where
 * the thing to actually do belongs.
 */
export function instructionsWith(skills: readonly SkillName[], task: string): string {
  const parts = skills.map((name) => skill(name));
  parts.push(task.trim());
  return parts.join("\n\n---\n\n");
}
