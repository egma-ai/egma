/**
 * Putting the Egma skill where the developer's coding agent will find it.
 *
 * Every skill egma has until now is content it *sends* — read out of this
 * package at the moment a task is dispatched, never written anywhere. This is
 * the one that is offered as a file, at the end of the walk, so that the
 * developer's own coding agent can drive egma later, on its own, without egma
 * being there.
 *
 * Three rules, and each one is a decision the offer would be worthless without.
 *
 * **egma writes the file itself.** One `mkdir` and one `writeFile` at a path
 * this module names. No third-party installer, no package manager, no network:
 * a skill install that could fail because somebody else's CLI changed its
 * flags is not an install a developer can rely on, and a tool that runs another
 * tool to write one file has made a supply chain out of nothing.
 *
 * **Nothing is installed unless the developer says so.** There is no default
 * scope and no silent write. Skip is a first-class answer and it leaves the
 * machine exactly as it was — not an empty directory, not a marker file,
 * nothing.
 *
 * **The home is passed in, never assumed.** Global scope writes into the
 * developer's home directory, which means a check of this code would otherwise
 * have to write into the home of whoever ran it. `EGMA_HOME` is egma's own
 * folder and is deliberately not reused here — a developer who moved egma's
 * key somewhere else did not thereby move their coding agent's configuration.
 */

import { mkdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { installableSkill } from "./index.ts";

/** Where a skill goes: inside this repository, or beside the agent itself. */
export type SkillScope = "project" | "global";

/** What the offer's three keys answer. */
export type SkillChoice = SkillScope | "skip";

/**
 * Where one coding agent keeps its skills.
 *
 * Both of the agents egma drives today keep them the same way: a directory of
 * skills, one directory per skill, a `SKILL.md` inside it. They differ only in
 * which dot-directory the tree hangs from — so the convention is described
 * once, per agent, as that one name.
 */
type SkillConvention = {
  /** The directory in a repository, and under a home, e.g. `.claude`. */
  readonly home: string;
  /** What the developer calls the agent, for the sentence that offers this. */
  readonly name: string;
};

/**
 * The agents whose skill convention egma knows, by the id the protocol
 * registry gives them.
 *
 * It is deliberately a short list rather than a guess: writing a `SKILL.md`
 * into a directory an agent does not read would be egma leaving litter in
 * somebody's repository and telling them it had done something useful. An
 * agent that is not here gets no offer at all, which is honest.
 */
const CONVENTIONS: Readonly<Record<string, SkillConvention>> = {
  "claude-acp": { home: ".claude", name: "Claude Code" },
  "codex-acp": { home: ".codex", name: "Codex" },
};

/** What the skill directory is called, under whichever tree it lands in. */
export const SKILL_DIRECTORY_NAME = "egma";

/** The file itself. Both conventions name it the same. */
export const SKILL_FILE_NAME = "SKILL.md";

/** Both places one agent's skill could go, and what to call the agent. */
export type SkillPlaces = {
  readonly drivenAgentId: string;
  /** What the offer says, e.g. `Claude Code`. */
  readonly name: string;
  /** Inside this repository, committed with everything else in it. */
  readonly project: string;
  /** Beside the agent, for every repository on this machine. */
  readonly global: string;
};

export type PlaceOptions = {
  /** The repository the wizard is running in. */
  readonly repository: string;
  /**
   * The developer's home directory. Passed in so that a check can point it
   * somewhere throwaway; nothing here reads the real one behind a caller's
   * back.
   */
  readonly home: string;
};

/**
 * The developer's home directory, from the environment the way every tool on
 * the machine reads it, with the platform's own answer as the backstop.
 */
export function homeIn(env: NodeJS.ProcessEnv): string {
  const named = env.HOME?.trim() ?? env.USERPROFILE?.trim() ?? "";
  return named === "" ? homedir() : named;
}

/**
 * Where this coding agent's skill would go, or `null` when egma does not know
 * where this one keeps them.
 */
export function skillPlacesFor(
  drivenAgentId: string,
  options: PlaceOptions,
): SkillPlaces | null {
  const convention = CONVENTIONS[drivenAgentId];
  if (convention === undefined) return null;

  const under = (root: string): string =>
    path.join(root, convention.home, "skills", SKILL_DIRECTORY_NAME, SKILL_FILE_NAME);

  return {
    drivenAgentId,
    name: convention.name,
    project: under(options.repository),
    global: under(options.home),
  };
}

/** Where the skill landed. */
export type InstalledSkill = {
  readonly scope: SkillScope;
  /** Absolute, so the line that says where it went is one a developer can use. */
  readonly file: string;
  /**
   * True when a file was already there and this one is now in its place.
   *
   * It travels out because the line the developer keeps has to say it. egma
   * overwrites on purpose — half an old skill beside half a new one would be
   * worse than either — but overwriting somebody's file without telling them
   * is how a tool loses an edit they made and never finds out.
   */
  readonly replaced: boolean;
};

export type InstallOptions = {
  readonly places: SkillPlaces;
  readonly scope: SkillScope;
};

/**
 * Write the skill at the chosen scope.
 *
 * The file is overwritten if one is already there, which is what a developer
 * accepting the offer a second time means: this package's copy is the current
 * one, and half an old skill beside half a new one would be worse than either.
 *
 * Whether there was one is answered before the write and carried out, because
 * a developer who had edited that file has just lost the edit and the line
 * they keep is the only place they will ever hear about it. The look is not a
 * gate on the write and nothing branches on it — it is one question asked of
 * the disk, so there is nothing here for two runs at once to race over.
 */
export async function installEgmaSkill(options: InstallOptions): Promise<InstalledSkill> {
  const file = options.scope === "project" ? options.places.project : options.places.global;
  const replaced = await stat(file).then(
    (found) => found.isFile(),
    () => false,
  );
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${installableSkill()}\n`, "utf8");
  return { scope: options.scope, file, replaced };
}

/** What the developer is told once the file is written. */
export function installedLine(
  scope: SkillScope,
  file: string,
  drivenAgentName: string,
  replaced = false,
): string {
  // Said first, because it is the only part of this line that is news about
  // something the developer had rather than about something egma did.
  const put = replaced
    ? `The Egma skill in ${file} was replaced with this version's.`
    : `The Egma skill is in ${file}.`;
  return scope === "project"
    ? `${put} Commit it, and everybody on this repository has it.`
    : `${put} Every repository you open ${drivenAgentName} in has it.`;
}

/** What the developer is told when they skip, so skipping is never silent. */
export function skippedLine(drivenAgentName: string): string {
  return `Nothing was installed. ${drivenAgentName} can still drive Egma — tell it to run egma --help.`;
}
