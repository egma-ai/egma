/**
 * The skills egma installs, and the three answers the offer can be given.
 *
 * This is the only thing in the whole walk that writes outside the developer's
 * repository, so what is checked is the filesystem itself: which files landed,
 * where — and, for the answer that installs nothing, that every file on both
 * trees is exactly where it was.
 *
 * What writes them is no longer egma. It is the standard skills installer,
 * pinned as a dependency of this package, so what these checks prove is that
 * egma points it at the right tree, at the right agent, with the right scope,
 * and that the copy it runs is the vendored one rather than anything a network
 * would hand back.
 *
 * The home is passed in throughout. A check that wrote a global skill would
 * otherwise write into the home of whoever ran the suite, and a check that had
 * to be trusted not to is not a check.
 */

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  drivingSkill,
  drivingSkillFile,
  PUBLIC_SKILL_NAMES,
  publicSkillsDirectory,
} from "../src/skills/index.ts";
import {
  homeIn,
  installArguments,
  installEgmaSkills,
  installedLine,
  landedLines,
  skillPlacesFor,
  skillsCliEntry,
  skippedLine,
  SKILLS_CLI_PACKAGE,
  SKILLS_LOCK_FILE,
} from "../src/skills/install.ts";
import { BANNED, LIVEKIT_SESSION_OBJECT, SCENARIO_HEADING } from "./support/glossary.ts";
import { CLI_ENTRY, filesUnder, makeWorkspace, type Workspace } from "./support/workspace.ts";

const run = promisify(execFile);

// The installer is a real subprocess reading and writing a real tree.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let repository: Workspace;
let home: Workspace;

beforeEach(async () => {
  repository = await makeWorkspace({ "package.json": "{}\n" });
  home = await makeWorkspace();
});

afterEach(async () => {
  await repository.remove();
  await home.remove();
});

function placesFor(drivenAgentId: string) {
  return skillPlacesFor(drivenAgentId, { repository: repository.dir, home: home.dir });
}

/** Every file on both trees, so "nothing was touched" is a real assertion. */
async function everything(): Promise<{ repository: string[]; home: string[] }> {
  return {
    repository: await filesUnder(repository.dir),
    home: await filesUnder(home.dir),
  };
}

describe("who the offer is aimed at", () => {
  it.each([
    ["claude", "claude-code", "Claude Code"],
    ["claude-acp", "claude-code", "Claude Code"],
    ["codex", "codex", "Codex"],
    ["codex-acp", "codex", "Codex"],
    ["cursor", "cursor", "Cursor"],
    ["opencode", "opencode", "OpenCode"],
  ])("names %s to the installer as %s", (id, skillsAgentId, name) => {
    const places = placesFor(id);

    expect(places?.skillsAgentId).toBe(skillsAgentId);
    expect(places?.name).toBe(name);
    expect(places?.repository).toBe(repository.dir);
    expect(places?.home).toBe(home.dir);
  });

  /**
   * A coding agent the installer cannot name gets no offer at all. Aiming an
   * install at nobody would write files nothing reads and tell the developer
   * egma had done something useful.
   */
  it("offers nothing for a coding agent egma cannot name to the installer", () => {
    expect(placesFor("gemini")).toBeNull();
    expect(placesFor("some-agent-nobody-has-heard-of")).toBeNull();
  });

  it("offers every public skill, not just the one that drives egma", () => {
    expect(placesFor("claude")?.skills).toEqual(PUBLIC_SKILL_NAMES);
    expect(placesFor("claude")?.skills).toContain("egma");
    expect(placesFor("claude")?.skills).toContain("write-egma-tests");
    expect(placesFor("claude")?.skills).toContain("integrate-egma-sdk");
  });

  it("reads the home from the environment the way every other tool does", () => {
    expect(homeIn({ HOME: "/home/somebody" })).toBe("/home/somebody");
    expect(homeIn({ USERPROFILE: "C:\\Users\\somebody" })).toBe("C:\\Users\\somebody");
    // And never egma's own folder: moving where the key lives is not moving
    // where a coding agent keeps its configuration.
    expect(homeIn({ HOME: "/home/somebody", EGMA_HOME: "/elsewhere/.egma" })).toBe(
      "/home/somebody",
    );
  });
});

describe("the installer egma runs", () => {
  /**
   * The pinned copy that arrived with egma, and never a name on a `PATH` or a
   * version a registry would resolve today. An unpinned fetch at the moment a
   * developer says yes is the supply chain the old hand-rolled writer existed
   * to avoid, and vendoring is how that stays true.
   */
  it("is the copy inside this package", () => {
    const entry = skillsCliEntry();

    expect(entry).not.toBeNull();
    expect(entry as string).toContain(`${path.sep}${SKILLS_CLI_PACKAGE}${path.sep}bin${path.sep}`);
    expect(path.basename(entry as string)).toBe("cli.mjs");
  });

  it("is a real dependency of this package, pinned exactly", async () => {
    const manifest = JSON.parse(
      await readFile(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
    ) as { dependencies: Record<string, string> };

    expect(manifest.dependencies[SKILLS_CLI_PACKAGE]).toMatch(/^\d+\.\d+\.\d+$/u);
  });

  it("points at the skills this package carries, for the chosen agent and scope", () => {
    const places = placesFor("claude");
    if (places === null) throw new Error("Claude Code has an installer name");

    expect(installArguments({ places, scope: "project" })).toEqual([
      "add",
      publicSkillsDirectory(),
      "--skill",
      "*",
      "--agent",
      "claude-code",
      "--yes",
    ]);
    expect(installArguments({ places, scope: "global" })).toContain("--global");
  });

  /**
   * The installer draws its box in ASCII on a plain terminal and in
   * box-drawing characters on a capable one, and the wizard runs it under both.
   * A reader that only knew one of them would relay nothing on the other and
   * the developer would never be told where their skills went.
   */
  it.each([
    {
      terminal: "a plain one",
      output: [
        "|  o  Installed 2 skills ---------+",
        "|  ✓ egma (copied)                |",
        "|    → ./.claude/skills/egma      |",
        "|  ✓ write-egma-tests (copied)    |",
        "|    → ./.claude/skills/write     |",
        "+--------------------------------+",
      ],
    },
    {
      terminal: "a capable one",
      output: [
        "│  ◇  Installed 2 skills ────────╮",
        "│  ✓ egma (copied)               │",
        "│    → ./.claude/skills/egma     │",
        "│  ✓ write-egma-tests (copied)   │",
        "│    → ./.claude/skills/write    │",
        "├───────────────────────────────╯",
      ],
    },
  ])("keeps the installer's own account of where each skill went, on $terminal", ({ output }) => {
    expect(landedLines(output.join("\n"))).toEqual([
      "./.claude/skills/egma",
      "./.claude/skills/write",
    ]);
  });
});

describe("installing them", () => {
  it("writes into the repository at project scope, and nothing into the home", async () => {
    const before = await everything();
    const places = placesFor("claude");
    if (places === null) throw new Error("Claude Code has an installer name");

    const installed = await installEgmaSkills({ places, scope: "project" });

    expect(installed.kind).toBe("installed");
    if (installed.kind !== "installed") throw new Error(installed.reason);
    expect(installed.scope).toBe("project");
    expect(installed.skills).toEqual(PUBLIC_SKILL_NAMES);

    const after = await everything();
    const written = after.repository.filter((file) => !before.repository.includes(file));
    for (const skill of PUBLIC_SKILL_NAMES) {
      expect(written).toContain(`.claude/skills/${skill}/SKILL.md`);
    }
    expect(
      await readFile(
        path.join(repository.dir, ".claude", "skills", "egma", "SKILL.md"),
        "utf8",
      ),
    ).toContain(drivingSkill());
    // The developer's home was not touched at all.
    expect(after.home).toEqual(before.home);
  });

  it("writes into the passed-in home at global scope, and not into the repository", async () => {
    const before = await everything();
    const places = placesFor("codex");
    if (places === null) throw new Error("Codex has an installer name");

    const installed = await installEgmaSkills({ places, scope: "global" });

    expect(installed.kind).toBe("installed");
    if (installed.kind !== "installed") throw new Error(installed.reason);

    const after = await everything();
    const written = after.home.filter((file) => !before.home.includes(file));
    expect(written.length).toBeGreaterThan(0);
    for (const skill of PUBLIC_SKILL_NAMES) {
      expect(written.some((file) => file.includes(`skills/${skill}/SKILL.md`))).toBe(true);
    }
    expect(after.repository).toEqual(before.repository);
  });

  /**
   * Skip is a first-class answer, and this is what makes that a fact rather
   * than an intention: nothing is installed by *not calling the installer*, so
   * both trees are byte for byte what they were.
   */
  it("leaves the machine untouched when nothing is installed", async () => {
    const before = await everything();

    // Reading where the skills would go is not writing anything there.
    expect(placesFor("claude")).not.toBeNull();

    expect(await everything()).toEqual(before);
  });

  it("says what it did, both ways round, so neither answer is silent", () => {
    const places = placesFor("claude");
    if (places === null) throw new Error("Claude Code has an installer name");

    const said = installedLine("project", places, ["./.claude/skills/egma"]);
    expect(said).toContain("./.claude/skills/egma");
    expect(said).toContain("Commit all of it");
    // The lock file is the one thing a project install writes that is not a
    // skill, and a developer who finds it in their diff was told about it.
    expect(said).toContain(SKILLS_LOCK_FILE);
    expect(installedLine("global", places, [])).toContain("Claude Code");
    // Global scope writes no lock file into the repository, so it names none.
    expect(installedLine("global", places, [])).not.toContain(SKILLS_LOCK_FILE);

    // Counted from what the installer said it wrote, never from what the offer
    // said it would: on the day one of them fails those are different numbers,
    // and the line a developer keeps has to be about what really happened.
    expect(installedLine("project", places, ["a", "b"])).toContain("2 Egma skills are");
    expect(installedLine("project", places, ["a"])).toContain("1 Egma skill is");
    expect(installedLine("project", places, [])).toContain("The Egma skills are");

    expect(skippedLine(places.name)).toContain("Nothing was installed");
    expect(skippedLine(places.name)).toContain("egma --help");
  });

  /**
   * A project install writes a lock file at the repository root beside the
   * skills. It is committed with everything else, so it is disclosed with
   * everything else.
   */
  it("really does write the lock file it says it writes", async () => {
    const places = placesFor("claude");
    if (places === null) throw new Error("Claude Code has an installer name");

    const installed = await installEgmaSkills({ places, scope: "project" });
    expect(installed.kind).toBe("installed");
    if (installed.kind !== "installed") throw new Error(installed.reason);

    expect(await filesUnder(repository.dir)).toContain(SKILLS_LOCK_FILE);
    expect(installedLine("project", places, installed.landed)).toContain(SKILLS_LOCK_FILE);
  });
});

describe("the skill that teaches a coding agent to drive egma", () => {
  it("is a skill file, in the shape a coding agent reads one", () => {
    const content = drivingSkill();

    expect(content.startsWith("---\n")).toBe(true);
    expect(content).toMatch(/^name: egma$/mu);
    expect(content).toMatch(/^description: \S.+$/mu);
    expect(path.basename(drivingSkillFile())).toBe("SKILL.md");
  });

  it("teaches the four things a coding agent needs to drive egma", () => {
    const content = drivingSkill();

    expect(content).toContain("egma/config.yaml");
    expect(content).toContain("egma --help");
    expect(content).toContain("egma pull");
    expect(content).toContain("egma push");
    expect(content).toContain("egma run");
  });

  /**
   * The rule that matters most in a file a model reads unsupervised: a state
   * that could not be graded is not a low score, and an agent that reported
   * one as the other would send the developer hunting a bug that is not there.
   */
  it("keeps grade results, combined scores, and operational state separate", () => {
    const content = drivingSkill();

    for (const state of ["not_requested", "pending", "running", "complete", "error"]) {
      expect(content).toContain(state);
    }
    expect(content).toContain("normalized score");
    expect(content).toContain("pass threshold");
    expect(content).toContain("combined score");
    expect(content).toContain("A low score does not make `egma run` fail");
    expect(content).toContain("Do not call it skipped");
  });

  /**
   * The same ban list the sent skills are held to, and for a harder reason.
   *
   * This is text egma leaves on the machine, and a coding agent reads it in
   * every future task in that repository. A near synonym in here does not teach
   * one developer the wrong word once — it teaches their agent the wrong word
   * for good, and the agent will then use it back at them.
   */
  it("uses the words egma uses, because this is the text that stays behind", () => {
    const content = drivingSkill()
      .replaceAll(SCENARIO_HEADING, "")
      .replaceAll(LIVEKIT_SESSION_OBJECT, "")
      // `call` is an ordinary verb here, not the banned noun for a simulation.
      .replace("Do not call it skipped.", "");

    for (const banned of BANNED) {
      expect({ banned: String(banned), hit: banned.exec(content)?.[0] ?? null }).toEqual({
        banned: String(banned),
        hit: null,
      });
    }
    // The bare word is the voice agent; a coding agent is always named as one.
    expect(content).toContain("voice agent");
  });

  /**
   * Every verb this file tells a coding agent to type has to be a verb the
   * command really has. A skill that teaches one that was renamed sends an
   * agent into a loop nobody is watching.
   */
  it("names only verbs and flags the command really has", async () => {
    const content = drivingSkill();
    // Asked of the built command rather than of a list in the source, because
    // the skill sends a reader to `egma --help` and that is the answer they
    // get. A verb renamed there and left here is a loop nobody is watching.
    const { stdout: help } = await run(process.execPath, [CLI_ENTRY, "--help"]);

    // Only what it tells a reader to type: what is inside a fence, and what is
    // inside backticks. Prose about egma is prose, and "egma from this
    // repository" is a sentence rather than a verb.
    const fenced = [...content.matchAll(/```[a-z]*\n(?<body>[\s\S]*?)```/gu)].flatMap((found) =>
      (found.groups?.body ?? "").split("\n"),
    );
    const inline = [...content.matchAll(/`(?<code>[^`\n]+)`/gu)].map(
      (found) => found.groups?.code ?? "",
    );
    const typed = [...fenced, ...inline].flatMap((one) => {
      const verb = /^egma (?<verb>[a-z][a-z-]*)/u.exec(one.trim())?.groups?.verb;
      return verb === undefined ? [] : [verb];
    });

    // A guard that matched nothing would pass forever.
    expect(new Set(typed).size).toBeGreaterThan(2);
    for (const verb of new Set(typed)) {
      const usage = verb === "run"
        ? "egma run <suite-directory> [options]"
        : verb === "suite"
          ? "egma suite create <directory> --name <name>"
          : `egma ${verb} [options]`;
      expect(help, verb).toContain(usage);
    }
    // And the one flag it names, spelt the way the command spells it.
    expect(content).toContain("--no-follow");
    expect(help).toContain("--no-follow");
  });
});

describe("the skills in the package", () => {
  it("survive npm packing, which is the only reason they are outside dist", async () => {
    const root = fileURLToPath(new URL("..", import.meta.url));

    const { stdout } = await run("npm", ["pack", "--dry-run", "--json"], { cwd: root });
    const packed = (JSON.parse(stdout) as { files: { path: string }[] }[])[0];
    const paths = (packed?.files ?? []).map((file) => file.path);

    for (const skill of PUBLIC_SKILL_NAMES) {
      expect(paths).toContain(`skills/${skill}/SKILL.md`);
    }
  });
});
