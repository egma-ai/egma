/**
 * egma's skills as a shipped artifact.
 *
 * A skill nobody can read is not a skill, and a skill that falls out of the
 * package on the way to npm is worse than none — it works on the machine it was
 * written on and nowhere else. So this checks the two things a developer could
 * check for themselves: the files are in the package that `npm pack` would
 * build, and their content is what the wizard puts in front of a coding agent.
 */

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { SKILL_NAMES, instructionsWith, skill, skillFile } from "../src/skills/index.ts";
import { FACTS } from "../src/wizard/facts.ts";
import { pasteFallbackMessage } from "../src/wizard/no-coding-agent.ts";
import { BANNED, SCENARIO_HEADING } from "./support/glossary.ts";

const run = promisify(execFile);

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));

describe("egma's skills", () => {
  it("are markdown content, shaped the way a skill file is", () => {
    for (const name of SKILL_NAMES) {
      const content = skill(name);
      expect(content.startsWith("---\n")).toBe(true);
      expect(content).toMatch(/^name: \S+$/m);
      expect(content).toMatch(/^description: \S.+$/m);
      // Long enough to teach something, short enough to sit in a prompt.
      expect(content.length).toBeGreaterThan(1_000);
      expect(content.length).toBeLessThan(20_000);
    }
  });

  it("teach the marker lines egma reads answers from", () => {
    const finding = skill("context-finding");
    expect(finding).toContain("egma:found framework");
    expect(finding).toContain("egma:note");
    expect(finding).toContain("egma:none");
    expect(finding).toContain("egma:abort");

    // The step that writes files reports through markers of its own, and the
    // pane a developer watches is drawn from nothing else.
    const writing = skill("writing-tests");
    expect(writing).toContain("egma:plan");
    expect(writing).toContain("egma:writing");
    expect(writing).toContain("egma:wrote");
  });

  it("say what a test file is made of, in the shape egma writes one", () => {
    const writing = skill("writing-tests");
    expect(writing).toContain("egma/tests/");
    expect(writing).toContain("## Expected behaviors");
    expect(writing).toContain("personas:");
    // The two rules the platform enforces at its own door, taught before a
    // file is written rather than reported after one is refused. Prose is
    // wrapped to a width, so it is read the way a reader reads it.
    const unwrapped = writing.replace(/\s+/g, " ");
    expect(unwrapped).toContain("there is always at least one");
    expect(unwrapped).toContain("Never write a `version:` line.");
  });

  /**
   * The facts are prose in three places — this skill, the README, and the
   * message for a machine with no coding agent on it — and code in one. The
   * code is the source of truth; this is what keeps the prose from drifting
   * away from it without anybody noticing.
   */
  it("ask for the facts egma reads back, in the words egma reads them", () => {
    // Prose is wrapped to a width, and a phrase does not stop meaning what it
    // means because a line ending landed in the middle of it.
    const unwrapped = (text: string): string => text.replace(/\s+/g, " ");

    const finding = skill("context-finding");
    const readme = unwrapped(readFileSync(path.join(PACKAGE_ROOT, "README.md"), "utf8"));
    const pasted = unwrapped(pasteFallbackMessage());

    for (const fact of FACTS) {
      expect(finding, fact.name).toContain(`\`${fact.name}\``);
      expect(readme, fact.name).toContain(fact.phrase);
      expect(pasted, fact.name).toContain(fact.phrase);
    }
  });

  it("say what a Retell voice agent looks like, both ways round", () => {
    const retell = skill("retell");
    expect(retell).toContain("retell-sdk");
    expect(retell).toContain("Retell dashboard");
    expect(retell).toContain("agent_");
    expect(retell).toContain("llm_");
  });

  it("use the words egma uses, because a skill is user-facing text", () => {
    for (const name of SKILL_NAMES) {
      const content = skill(name).replaceAll(SCENARIO_HEADING, "");
      for (const banned of BANNED) {
        expect({ name, banned: String(banned), hit: banned.exec(content)?.[0] ?? null }).toEqual({
          name,
          banned: String(banned),
          hit: null,
        });
      }
      // The bare word is the voice agent; the driven one is always named.
      expect(content).toContain("voice agent");
    }
  });

  /**
   * The carve-out is a hole in a guard, and a hole nobody measured is how a
   * guard stops guarding. It takes out the heading and it takes out nothing
   * else — so the one word a skill may write stays the one word it may write.
   */
  it("carve out the heading and nothing that hides behind it", () => {
    const taken = (text: string): string => text.replaceAll(SCENARIO_HEADING, "");

    // The heading, however a skill writes it — and it goes.
    expect(taken("## Scenario")).toBe("");
    expect(taken("- **`## Scenario`** is prose.")).toBe("- **** is prose.");
    expect(taken("#### scenario")).toBe("");

    // Everything else stays, and the ban is what meets it.
    for (const hiding of [
      "the scenario the test describes",
      "## Scenarios",
      "a scenario-led suite",
      "Scenario: the person is late",
    ]) {
      expect(taken(hiding), hiding).toMatch(/scenario/i);
      expect(/\bscenarios?\b/i.test(taken(hiding)), hiding).toBe(true);
    }
  });

  it("survive npm packing, which is the only reason they are outside dist", async () => {
    const { stdout } = await run("npm", ["pack", "--dry-run", "--json"], { cwd: PACKAGE_ROOT });
    const packed = (JSON.parse(stdout) as { files: { path: string }[] }[])[0];
    const paths = (packed?.files ?? []).map((file) => file.path);

    for (const name of SKILL_NAMES) {
      expect(paths).toContain(`skills/${name}.md`);
    }
  });

  it("are read out of the package, wherever the package is", () => {
    for (const name of SKILL_NAMES) {
      const file = skillFile(name);
      expect(path.relative(PACKAGE_ROOT, file)).toBe(path.join("skills", `${name}.md`));
      expect(readFileSync(file, "utf8")).toContain(skill(name));
    }
  });

  it("go in front of the task, in the order they were asked for", () => {
    const instructions = instructionsWith(["context-finding", "retell"], "# Your task\nLook.");

    expect(instructions.indexOf(skill("context-finding"))).toBe(0);
    expect(instructions.indexOf(skill("retell"))).toBeGreaterThan(0);
    expect(instructions.indexOf(skill("retell"))).toBeLessThan(
      instructions.indexOf("# Your task"),
    );
    expect(instructions.endsWith("# Your task\nLook.")).toBe(true);
  });
});
