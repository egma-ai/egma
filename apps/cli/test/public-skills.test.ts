/**
 * The public Agent Skills surface from the files people edit to the external
 * installer that reads them.
 *
 * The repository-root tree is the only source. `npx skills` reads that tree
 * directly; the Egma CLI package does not carry a second copy.
 */

import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { promisify, stripVTControlCharacters } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

const run = promisify(execFile);
const require = createRequire(import.meta.url);

const CODE_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const SKILLS_CLI = require.resolve("skills/bin/cli.mjs");

const PUBLIC_SKILLS = [
  { directory: "integrate-egma", name: "integrate-egma" },
  { directory: "write-voice-agent-tests", name: "write-egma-tests" },
] as const;
const PUBLIC_SKILL_NAMES = PUBLIC_SKILLS.map(({ name }) => name);

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("npx skills compatibility", () => {
  it("discovers only the customer skills from the repository root", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "egma-public-skills-"));
    temporary.push(home);

    const { stdout, stderr } = await run(
      process.execPath,
      [SKILLS_CLI, "add", CODE_ROOT, "--list"],
      {
        cwd: home,
        env: { ...process.env, CI: "1", HOME: home, NO_COLOR: "1", TERM: "dumb" },
      },
    );
    const output = stripVTControlCharacters(`${stdout}\n${stderr}`);

    expect(output).toContain(`Found ${PUBLIC_SKILL_NAMES.length} skills`);
    for (const name of PUBLIC_SKILL_NAMES) expect(output).toContain(`  ${name}\n`);
    expect(output).not.toContain("coordinate-implementation");
    expect(output).not.toContain("finding-the-voice-agent");
    expect(output).not.toContain("retell-voice-agents");
  });
});
