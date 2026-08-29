/** Paths to the public Agent Skills projected into the npm package. */

import { fileURLToPath } from "node:url";

export type PublicSkillName = "egma" | "integrate-egma" | "write-egma-tests";

export const PUBLIC_SKILL_NAMES: readonly PublicSkillName[] = [
  "egma",
  "integrate-egma",
  "write-egma-tests",
];

export const SKILLS_DIRECTORY = "skills";

function packageFile(relative: string): string {
  return fileURLToPath(new URL(`../../${relative}`, import.meta.url));
}

export function publicSkillsDirectory(): string {
  return packageFile(SKILLS_DIRECTORY);
}

export function publicSkillFile(name: PublicSkillName): string {
  return packageFile(`${SKILLS_DIRECTORY}/${name}/SKILL.md`);
}

/** The root from which a packaged skill's relative files are resolved. */
export function publicSkillDirectory(name: PublicSkillName): string {
  return packageFile(`${SKILLS_DIRECTORY}/${name}/`);
}
