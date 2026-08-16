/**
 * The one skill Egma installs, and the three answers it can be given.
 *
 * This is the only thing in the whole walk that writes outside the developer's
 * repository, so what is checked is the filesystem itself: which file landed,
 * where, with what in it — and, for the answer that installs nothing, that
 * every file on both trees is exactly where it was.
 *
 * The home is passed in throughout. A check that wrote a global skill would
 * otherwise write into the home of whoever ran the suite, and a check that had
 * to be trusted not to is not a check.
 */

import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { installableSkill, installableSkillFile } from "../src/skills/index.ts";
import {
  homeIn,
  installEgmaSkill,
  installedLine,
  skillPlacesFor,
  skippedLine,
} from "../src/skills/install.ts";
import { BANNED, SCENARIO_HEADING } from "./support/glossary.ts";
import { CLI_ENTRY, filesUnder, makeWorkspace, type Workspace } from "./support/workspace.ts";

const run = promisify(execFile);

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

describe("where the skill goes", () => {
  it("puts Claude Code's where Claude Code keeps skills, at both scopes", () => {
    const places = placesFor("claude-acp");

    expect(places?.name).toBe("Claude Code");
    expect(places?.project).toBe(
      path.join(repository.dir, ".claude", "skills", "egma", "SKILL.md"),
    );
    expect(places?.global).toBe(path.join(home.dir, ".claude", "skills", "egma", "SKILL.md"));
  });

  it("puts Codex's where Codex keeps skills, at both scopes", () => {
    const places = placesFor("codex-acp");

    expect(places?.name).toBe("Codex");
    expect(places?.project).toBe(
      path.join(repository.dir, ".codex", "skills", "egma", "SKILL.md"),
    );
    expect(places?.global).toBe(path.join(home.dir, ".codex", "skills", "egma", "SKILL.md"));
  });

  /**
   * A coding agent whose skill convention Egma does not know gets no offer at
   * all. Guessing at a directory would put a file somewhere nothing reads, and
   * tell the developer Egma had done something for them.
   */
  it("offers nothing for a coding agent whose convention Egma does not know", () => {
    expect(placesFor("gemini")).toBeNull();
    expect(placesFor("some-agent-nobody-has-heard-of")).toBeNull();
  });

  it("reads the home from the environment the way every other tool does", () => {
    expect(homeIn({ HOME: "/home/somebody" })).toBe("/home/somebody");
    expect(homeIn({ USERPROFILE: "C:\\Users\\somebody" })).toBe("C:\\Users\\somebody");
    // And never Egma's own folder: moving where the key lives is not moving
    // where a coding agent keeps its configuration.
    expect(homeIn({ HOME: "/home/somebody", EGMA_HOME: "/elsewhere/.egma" })).toBe(
      "/home/somebody",
    );
  });
});

describe("installing it", () => {
  it("writes one file into the repository at project scope, and nothing else", async () => {
    const before = await everything();
    const places = placesFor("claude-acp");
    if (places === null) throw new Error("Claude Code has a skill convention");

    const installed = await installEgmaSkill({ places, scope: "project" });

    expect(installed.file).toBe(places.project);
    expect(await readFile(installed.file, "utf8")).toBe(`${installableSkill()}\n`);

    const after = await everything();
    expect(after.repository).toEqual(
      [...before.repository, ".claude/skills/egma/SKILL.md"].sort(),
    );
    // The developer's home was not touched at all.
    expect(after.home).toEqual(before.home);
  });

  it("writes one file into the home at global scope, and nothing into the repository", async () => {
    const before = await everything();
    const places = placesFor("claude-acp");
    if (places === null) throw new Error("Claude Code has a skill convention");

    const installed = await installEgmaSkill({ places, scope: "global" });

    expect(installed.file).toBe(places.global);
    expect(await readFile(installed.file, "utf8")).toBe(`${installableSkill()}\n`);

    const after = await everything();
    expect(after.home).toEqual([...before.home, ".claude/skills/egma/SKILL.md"].sort());
    expect(after.repository).toEqual(before.repository);
  });

  it("writes Codex's into Codex's own tree", async () => {
    const places = placesFor("codex-acp");
    if (places === null) throw new Error("Codex has a skill convention");

    await installEgmaSkill({ places, scope: "project" });

    expect(await filesUnder(repository.dir)).toContain(".codex/skills/egma/SKILL.md");
    expect(await filesUnder(repository.dir)).not.toContain(".claude/skills/egma/SKILL.md");
  });

  /**
   * Accepting the offer a second time means this package's copy is the current
   * one. Half an old skill beside half a new one would be worse than either.
   *
   * And it says so. A developer who had edited that file has just lost the
   * edit, and the line they keep is the only place they will ever hear about
   * it — a tool that overwrites quietly is a tool that loses somebody's work
   * and lets them find out weeks later.
   */
  it("replaces a file that is already there, and says that it did", async () => {
    const places = placesFor("claude-acp");
    if (places === null) throw new Error("Claude Code has a skill convention");

    const first = await installEgmaSkill({ places, scope: "project" });
    expect(first.replaced).toBe(false);
    expect(installedLine("project", first.file, places.name, first.replaced)).not.toContain(
      "replaced",
    );

    await writeFile(places.project, "# my own notes, written over the top\n", "utf8");
    const second = await installEgmaSkill({ places, scope: "project" });

    expect(second.replaced).toBe(true);
    expect(installedLine("project", second.file, places.name, second.replaced)).toBe(
      `The Egma skill in ${places.project} was replaced with this version's. Commit it, and everybody on this repository has it.`,
    );

    expect(await filesUnder(repository.dir)).toEqual(
      ["package.json", ".claude/skills/egma/SKILL.md"].sort(),
    );
    expect(await readFile(places.project, "utf8")).toBe(`${installableSkill()}\n`);
  });

  /**
   * Skip is a first-class answer, and this is what makes that a fact rather
   * than an intention: nothing is installed by *not calling the installer*, so
   * both trees are byte for byte what they were.
   */
  it("leaves the machine untouched when nothing is installed", async () => {
    const before = await everything();

    // Reading where the skill would go is not writing anything there.
    const places = placesFor("claude-acp");
    expect(places).not.toBeNull();

    expect(await everything()).toEqual(before);
  });

  it("says what it did, both ways round, so neither answer is silent", () => {
    const places = placesFor("claude-acp");
    if (places === null) throw new Error("Claude Code has a skill convention");

    expect(installedLine("project", places.project, places.name)).toContain(places.project);
    expect(installedLine("project", places.project, places.name)).toContain("Commit it");
    expect(installedLine("global", places.global, places.name)).toContain(places.global);
    expect(installedLine("global", places.global, places.name)).toContain("Claude Code");

    expect(skippedLine(places.name)).toContain("Nothing was installed");
    expect(skippedLine(places.name)).toContain("egma --help");
  });
});

describe("the skill that gets installed", () => {
  it("is a skill file, in the shape a coding agent reads one", () => {
    const content = installableSkill();

    expect(content.startsWith("---\n")).toBe(true);
    expect(content).toMatch(/^name: egma$/mu);
    expect(content).toMatch(/^description: \S.+$/mu);
    expect(path.basename(installableSkillFile())).toBe("SKILL.md");
  });

  it("teaches the four things a coding agent needs to drive Egma", () => {
    const content = installableSkill();

    expect(content).toContain("egma/config.yaml");
    expect(content).toContain("egma --help");
    expect(content).toContain("egma pull");
    expect(content).toContain("egma push");
    expect(content).toContain("egma run");
  });

  /**
   * The rule that matters most in a file a model reads unsupervised: a test
   * that could not run is not a test that failed, and an agent that reported
   * one as the other would send the developer hunting a bug that is not there.
   */
  it("names all four verdicts and forbids folding them into three", () => {
    const content = installableSkill();

    for (const verdict of ["passed", "failed", "skipped", "errored"]) {
      expect(content).toContain(verdict);
    }
    expect(content.replace(/\s+/gu, " ")).toContain(
      "Never report `skipped` or `errored` as `failed`.",
    );
  });

  /**
   * The same ban list the sent skills are held to, and for a harder reason.
   *
   * This is the only text Egma leaves on the machine, and a coding agent reads
   * it in every future task in that repository. A near synonym in here does not
   * teach one developer the wrong word once — it teaches their agent the wrong
   * word for good, and the agent will then use it back at them.
   */
  it("uses the words Egma uses, because this is the text that stays behind", () => {
    const content = installableSkill().replaceAll(SCENARIO_HEADING, "");

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
    const content = installableSkill();
    // Asked of the built command rather than of a list in the source, because
    // the skill sends a reader to `egma --help` and that is the answer they
    // get. A verb renamed there and left here is a loop nobody is watching.
    const { stdout: help } = await run(process.execPath, [CLI_ENTRY, "--help"]);

    // Only what it tells a reader to type: what is inside a fence, and what is
    // inside backticks. Prose about Egma is prose, and "Egma from this
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
      expect(help, verb).toContain(`egma ${verb} [options]`);
    }
    // And the one flag it names, spelt the way the command spells it.
    expect(content).toContain("--no-follow");
    expect(help).toContain("--no-follow");
  });
});

describe("the skill in the package", () => {
  it("survives npm packing, which is the only reason it is outside dist", async () => {
    const root = fileURLToPath(new URL("..", import.meta.url));

    const { stdout } = await run("npm", ["pack", "--dry-run", "--json"], { cwd: root });
    const packed = (JSON.parse(stdout) as { files: { path: string }[] }[])[0];

    expect((packed?.files ?? []).map((file) => file.path)).toContain("skills/egma/SKILL.md");
  });
});
