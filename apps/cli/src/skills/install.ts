/**
 * Putting Egma's public skills where the developer's coding agent will find
 * them.
 *
 * Public Egma skills can be installed independently from the repository. The
 * wizard also carries their release snapshot: it sends them as task context
 * while it works, and offers the whole set as local files at the end of the
 * walk. That lets the developer's coding agent drive Egma later without the
 * wizard being there.
 *
 * Three rules, and each one is a decision the offer would be worthless without.
 *
 * **The standard skills CLI writes the files.** Egma used to hardcode four
 * agents' directory conventions and refuse everybody else. The field moved —
 * many agents, symlinked canonical skill stores, `AGENTS.md` layouts — and
 * tracking it is not Egma's job. `skills` (vercel-labs) exists to track it, and
 * this repository already trusts it for its own development skills. So the
 * offer runs `skills add` against the skills directory inside Egma's own
 * package.
 *
 * **The CLI is vendored, never fetched.** `skills` is a pinned dependency of
 * this package, so accepting the offer runs code that arrived with Egma and
 * was verified when Egma was installed. Nothing reaches the network, nothing
 * resolves a version at the moment a developer says yes, and a machine with no
 * network still installs. An unpinned `npx skills` would be exactly the supply
 * chain the hand-rolled writer was built to avoid.
 *
 * **Nothing is installed unless the developer says so.** There is no default
 * scope and no silent write. Skip is a first-class answer and it leaves the
 * machine exactly as it was.
 *
 * **The home is passed in, never assumed.** Global scope writes into the
 * developer's home directory, which means a check of this code would otherwise
 * have to write into the home of whoever ran it. `EGMA_HOME` is Egma's own
 * folder and is deliberately not reused here — a developer who moved Egma's key
 * somewhere else did not thereby move their coding agent's configuration.
 */

import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import process from "node:process";

import { PUBLIC_SKILL_NAMES, publicSkillsDirectory } from "./index.ts";

/** Where a skill goes: inside this repository, or beside the agent itself. */
export type SkillScope = "project" | "global";

/** What the offer's three keys answer. */
export type SkillChoice = SkillScope | "skip";

/** The package whose CLI writes the files, pinned as a dependency of this one. */
export const SKILLS_CLI_PACKAGE = "skills";

/**
 * The file the installer writes at the repository root at project scope.
 *
 * It is the second thing a project install puts in somebody's repository, and
 * the only one that is not a skill. A developer who is told about four skill
 * directories and then finds a fifth file in their diff has been told most of
 * the truth, so both the offer and the line the offer leaves behind name it.
 */
export const SKILLS_LOCK_FILE = "skills-lock.json";

/**
 * What the skills CLI calls each coding agent Egma can drive.
 *
 * The two lists are separate vocabularies and this is the whole of the
 * translation between them. It is not a directory convention: where a skill
 * lands is the CLI's business, and Egma stopped having an opinion about it.
 */
const SKILLS_CLI_AGENTS: Readonly<Record<string, string>> = {
  claude: "claude-code",
  codex: "codex",
  cursor: "cursor",
  opencode: "opencode",
};

/** What each coding agent is called in the sentence that offers this. */
const DRIVEN_AGENT_NAMES: Readonly<Record<string, string>> = {
  claude: "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  opencode: "OpenCode",
};

/** What the offer would do, at either scope. */
export type SkillPlaces = {
  readonly drivenAgentId: string;
  /** What the offer says, e.g. `Claude Code`. */
  readonly name: string;
  /** The same coding agent, in the skills CLI's own vocabulary. */
  readonly skillsAgentId: string;
  /** The repository the wizard is running in, which project scope writes into. */
  readonly repository: string;
  /** The developer's home, which global scope writes into. */
  readonly home: string;
  /** Every public skill the offer installs, by name. */
  readonly skills: readonly string[];
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
 * What installing would do for this coding agent, or `null` when the skills CLI
 * does not know it.
 *
 * A coding agent the installer cannot name gets no offer at all, exactly as
 * before: an install aimed at nobody would write files nothing reads and tell
 * the developer Egma had helped.
 */
export function skillPlacesFor(
  drivenAgentId: string,
  options: PlaceOptions,
): SkillPlaces | null {
  const skillsAgentId = SKILLS_CLI_AGENTS[drivenAgentId];
  if (skillsAgentId === undefined) return null;

  return {
    drivenAgentId,
    name: DRIVEN_AGENT_NAMES[drivenAgentId] ?? drivenAgentId,
    skillsAgentId,
    repository: options.repository,
    home: options.home,
    skills: PUBLIC_SKILL_NAMES,
  };
}

/** Where the skills landed. */
export type InstalledSkills = {
  readonly kind: "installed";
  readonly scope: SkillScope;
  /** The skills that were offered and installed, by name. */
  readonly skills: readonly string[];
  /**
   * Where the installer said each one went, in its own words.
   *
   * Relayed rather than predicted. Which directory a coding agent reads is the
   * installer's knowledge now, and a path Egma guessed at would be a path Egma
   * has to keep guessing right forever.
   */
  readonly landed: readonly string[];
};

/** The install did not happen, and the developer has to be told why. */
export type SkillInstallFailed = {
  readonly kind: "failed";
  readonly reason: string;
};

export type SkillInstallOutcome = InstalledSkills | SkillInstallFailed;

export type InstallOptions = {
  readonly places: SkillPlaces;
  readonly scope: SkillScope;
  /** How long the installer is given before Egma stops waiting for it. */
  readonly timeoutMs?: number;
};

/** Long enough for a cold filesystem, short enough that nobody waits on it. */
const INSTALL_TIMEOUT_MS = 60_000;

/**
 * The installer that shipped with this package.
 *
 * Resolved rather than shelled to by name, so what runs is the pinned copy in
 * Egma's own dependency tree and never whatever a `PATH` happens to hold or
 * whatever a registry would hand back today.
 */
export function skillsCliEntry(): string | null {
  try {
    return createRequire(import.meta.url).resolve(`${SKILLS_CLI_PACKAGE}/bin/cli.mjs`);
  } catch {
    return null;
  }
}

/** The arguments the installer is given, so one place decides them. */
export function installArguments(options: InstallOptions): readonly string[] {
  return [
    "add",
    publicSkillsDirectory(),
    "--skill",
    "*",
    "--agent",
    options.places.skillsAgentId,
    ...(options.scope === "global" ? ["--global"] : []),
    "--yes",
  ];
}

/** The one thing in the installer's own output that Egma has to relay. */
const LANDED_MARK = "\u2192 ";

/** Terminal control sequences, which are not part of any line. */
const CONTROL = /\u001b?\[[0-9;?]*[A-Za-z]/gu;

/**
 * The installer's box, in either style it draws one.
 *
 * Which characters it uses depends on the terminal it thinks it is talking to:
 * ASCII pipes on a plain one, box-drawing characters on a capable one. Both are
 * decoration, so both come off and what is kept is the line inside. A reader
 * that knew only one style would relay nothing on the other, and the developer
 * would never be told where their skills went.
 */
const BOX_LEFT = /^[\s|+\u2502\u251c\u2514\u250c]+/u;
const BOX_RIGHT = /[\s|+\u2502\u256e\u256f\u2510\u2518]+$/u;

/** The lines of the installer's own output that name where a skill landed. */
export function landedLines(output: string): readonly string[] {
  const landed: string[] = [];
  for (const raw of output.split("\n")) {
    const line = raw.replaceAll(CONTROL, "").replace(BOX_LEFT, "").replace(BOX_RIGHT, "");
    if (line.startsWith(LANDED_MARK) && line.length > LANDED_MARK.length) {
      landed.push(line.slice(LANDED_MARK.length).trim());
    }
  }
  return landed;
}

/**
 * Install every public skill at the chosen scope, through the skills CLI.
 *
 * The home travels in the child's environment rather than in a flag, because
 * that is the one thing the installer reads to decide where global scope goes,
 * and a check that had to trust this code not to touch the real home would not
 * be a check.
 */
export async function installEgmaSkills(
  options: InstallOptions,
): Promise<SkillInstallOutcome> {
  const entry = skillsCliEntry();
  if (entry === null) {
    return {
      kind: "failed",
      reason:
        `Egma could not find its own copy of the ${SKILLS_CLI_PACKAGE} installer, so nothing was installed. ` +
        `The skills are in ${publicSkillsDirectory()} — copy them where ${options.places.name} reads skills, or run ${SKILLS_CLI_PACKAGE} add on that folder yourself.`,
    };
  }

  const ran = await new Promise<{
    readonly ok: boolean;
    readonly output: string;
  }>((resolve) => {
    execFile(
      process.execPath,
      [entry, ...installArguments(options)],
      {
        cwd: options.places.repository,
        env: {
          ...process.env,
          // Where global scope goes, said in the one variable every tool on the
          // machine reads it from.
          HOME: options.places.home,
          USERPROFILE: options.places.home,
          // Boxes and spinners are for a person watching a terminal, and
          // nobody is watching this one.
          NO_COLOR: "1",
          CI: "1",
        },
        encoding: "utf8",
        timeout: options.timeoutMs ?? INSTALL_TIMEOUT_MS,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        resolve({ ok: error === null, output: `${stdout}${stderr}` });
      },
    );
  });

  if (!ran.ok) {
    const said = ran.output.trim().split("\n").at(-1)?.trim() ?? "";
    return {
      kind: "failed",
      reason:
        said === ""
          ? `The ${SKILLS_CLI_PACKAGE} installer stopped without saying why, so nothing was installed.`
          : `The ${SKILLS_CLI_PACKAGE} installer stopped: ${said}`,
    };
  }

  return {
    kind: "installed",
    scope: options.scope,
    skills: options.places.skills,
    landed: landedLines(ran.output),
  };
}

/**
 * What the developer is told once the skills are written.
 *
 * Counted from what the installer said it wrote, never from what the offer said
 * it would write. The two are the same on an ordinary install and they are not
 * the same on the day one of them fails, and the line a developer keeps has to
 * be about what really happened. An installer that said nothing egma could read
 * gets a sentence with no count in it rather than a count egma invented.
 */
export function installedLine(
  scope: SkillScope,
  places: SkillPlaces,
  landed: readonly string[],
): string {
  const written = landed.length;
  const many =
    written === 0
      ? "The Egma skills are"
      : `${written} Egma ${written === 1 ? "skill is" : "skills are"}`;
  // Where they went, in the installer's own words, because it is the only
  // account of that which cannot be wrong.
  const where = written === 0 ? "" : ` ${landed.join(", ")}.`;
  return scope === "project"
    ? `${many} in this repository.${where} It also wrote ${SKILLS_LOCK_FILE} at the repository root. Commit all of it, and everybody on this repository has these skills.`
    : `${many} beside ${places.name}.${where} Every repository you open ${places.name} in has them.`;
}

/** What the developer is told when they skip, so skipping is never silent. */
export function skippedLine(drivenAgentName: string): string {
  return `Nothing was installed. ${drivenAgentName} can still drive Egma — tell it to run egma --help.`;
}
