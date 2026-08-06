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

const run = promisify(execFile);

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** The words the glossary bans, in the shapes that would slip past a reader. */
const BANNED = [
  /\beval\b/i,
  /\bevaluations?\b/i,
  /\bevaluators?\b/i,
  /\bcalls?\b/i,
  /\bcallers?\b/i,
  /\bconversations?\b/i,
  /\bdigital humans?\b/i,
  /\bscenarios?\b/i,
  /\bsessions?\b/i,
  /\btrials?\b/i,
  /\bexperiments?\b/i,
];

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
      const content = skill(name);
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
