/**
 * The public Agent Skills surface, from the files people edit to every place
 * those exact bytes travel.
 *
 * The repository-root tree is the source. The CLI package holds a generated
 * projection because npm cannot pack files above a package root. `npx skills`
 * reads the source tree directly. Both paths have to name the same skills and
 * carry the same bytes, or there is more than one truth again.
 */

import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { promisify, stripVTControlCharacters } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { parseTestFile } from "../src/folder/test-file.ts";

const run = promisify(execFile);
const require = createRequire(import.meta.url);

const CODE_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SOURCE_ROOT = path.join(CODE_ROOT, "skills");
const PACKAGE_SKILLS = path.join(PACKAGE_ROOT, "skills");
const SKILLS_CLI = require.resolve("skills/bin/cli.mjs");

const PUBLIC_SKILLS = [
  "egma",
  "integrate-egma",
  "write-egma-tests",
] as const;
const CLI_MARKER = /\begma:(?:found|note|none|abort|plan|writing|wrote)\b/u;

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true })));
});

async function filesUnder(root: string, below = ""): Promise<string[]> {
  const directory = path.join(root, below);
  const entries = await readdir(directory, { withFileTypes: true });
  const found = await Promise.all(
    entries.map(async (entry): Promise<string[]> => {
      const relative = path.join(below, entry.name);
      return entry.isDirectory() ? filesUnder(root, relative) : [relative];
    }),
  );
  return found.flat().sort();
}

function markdownExamples(skill: string): readonly string[] {
  return [...skill.matchAll(/^(?<fence>`{3,})markdown\n(?<body>[\s\S]*?)^\k<fence>$/gmu)].map(
    (match) => match.groups?.body ?? "",
  );
}

describe("the public skill source", () => {
  it("has only the intentional public skills, in standard folders", async () => {
    expect((await readdir(SOURCE_ROOT)).sort()).toEqual([...PUBLIC_SKILLS]);

    for (const name of PUBLIC_SKILLS) {
      const content = await readFile(path.join(SOURCE_ROOT, name, "SKILL.md"), "utf8");
      expect(content).toMatch(new RegExp(`^name: ${name}$`, "mu"));
      expect(content).toMatch(/^description: \S.+$/mu);
      expect(content).not.toMatch(CLI_MARKER);
    }
  });

  it("is projected into the CLI package with the same files and bytes", async () => {
    const sourceFiles = await filesUnder(SOURCE_ROOT);
    const packageFiles = await filesUnder(PACKAGE_SKILLS);

    expect(packageFiles).toEqual(sourceFiles);
    for (const relative of sourceFiles) {
      expect(await readFile(path.join(PACKAGE_SKILLS, relative))).toEqual(
        await readFile(path.join(SOURCE_ROOT, relative)),
      );
    }
  });

  it("shows a new test in a shape the real parser reads", async () => {
    const skill = await readFile(
      path.join(SOURCE_ROOT, "write-egma-tests", "SKILL.md"),
      "utf8",
    );
    const examples = markdownExamples(skill);
    expect(examples).not.toHaveLength(0);

    const test = parseTestFile(examples[0] ?? "", "shown-in-skill.md", "fallback");
    expect(test.name).toBe("missed-appointment-reschedule");
    expect(test.scenario).not.toBe("");
    expect(test.expectedBehaviors.length).toBeGreaterThan(0);
    expect(test.mockTools.map((tool) => tool.tool)).toEqual(["check_availability"]);
  });

  it("keeps integration phases in short, selected references", async () => {
    const root = path.join(SOURCE_ROOT, "integrate-egma");
    const skill = await readFile(path.join(root, "SKILL.md"), "utf8");
    const finding = await readFile(
      path.join(root, "references", "find-voice-agent.md"),
      "utf8",
    );
    const retell = await readFile(
      path.join(root, "references", "connect-retell.md"),
      "utf8",
    );
    const integrating = await readFile(
      path.join(root, "references", "integrate-livekit.md"),
      "utf8",
    );
    const livekit = await readFile(
      path.join(root, "references", "run-livekit-agent-locally.md"),
      "utf8",
    );
    const helper = await readFile(
      path.join(root, "scripts", "livekit-local.mjs"),
      "utf8",
    );

    expect(skill).toContain("Complete only the phase the task requests");
    expect(skill).toContain("[references/find-voice-agent.md](references/find-voice-agent.md)");
    expect(skill).toContain("[references/connect-retell.md](references/connect-retell.md)");
    expect(skill).toContain(
      "[references/integrate-livekit.md](references/integrate-livekit.md)",
    );
    expect(skill).toContain(
      "[references/run-livekit-agent-locally.md](references/run-livekit-agent-locally.md)",
    );
    expect(skill).toContain("Do not read or edit");
    expect(skill).toContain("CLI's documented safe write");
    expect([finding, retell, integrating, livekit].join("\n")).not.toContain("`.env");
    expect(skill).not.toMatch(CLI_MARKER);
    expect(finding).toContain("Pipecat");
    expect(finding).toContain("Vapi");
    expect(finding).toContain("Dispatch name");
    expect(finding).toContain("Entrypoint");
    expect(retell).toContain("retell-sdk");
    expect(livekit).toContain("LiveKit CLI 2.18.2 or newer");
    expect(livekit).toContain("egma:livekit-worker ready");
    expect(helper).toContain("const MINIMUM_VERSION = [2, 18, 2]");
    expect(finding).not.toMatch(CLI_MARKER);
    expect(retell).not.toMatch(CLI_MARKER);
  });

  it("keeps the documented complete test in the shape the real parser reads", async () => {
    const docs = await readFile(path.join(CODE_ROOT, "docs", "cli", "test-files.mdx"), "utf8");
    const example = markdownExamples(docs).find(
      (shown) => shown.includes("identity_revision:"),
    );
    expect(example).toBeDefined();

    const test = parseTestFile(example ?? "", "docs/cli/test-files.mdx", "fallback");
    expect(test.format).toBe(4);
    expect(test.expectedBehaviors).toHaveLength(2);
    expect(test.mockTools).toEqual([]);
  });
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

    expect(output).toContain(`Found ${PUBLIC_SKILLS.length} skills`);
    for (const name of PUBLIC_SKILLS) expect(output).toContain(`  ${name}\n`);
    expect(output).not.toContain("coordinate-implementation");
    expect(output).not.toContain("finding-the-voice-agent");
    expect(output).not.toContain("retell-voice-agents");
  });

  it("uses the same bytes that the repository publishes", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "egma-public-skill-use-"));
    temporary.push(home);

    for (const name of PUBLIC_SKILLS) {
      const { stdout } = await run(
        process.execPath,
        [SKILLS_CLI, "use", CODE_ROOT, "--skill", name],
        {
          cwd: home,
          env: { ...process.env, CI: "1", HOME: home, NO_COLOR: "1", TERM: "dumb" },
        },
      );
      const shown = /<SKILL\.md>\n(?<body>[\s\S]*?)\n<\/SKILL\.md>/u.exec(stdout)?.groups?.body;
      const source = await readFile(path.join(SOURCE_ROOT, name, "SKILL.md"), "utf8");

      expect(shown?.trimEnd()).toBe(source.trimEnd());
    }
  });

  it("installs every integration reference and helper", async () => {
    const project = await mkdtemp(path.join(tmpdir(), "egma-public-skill-install-"));
    temporary.push(project);

    await run(
      process.execPath,
      [
        SKILLS_CLI,
        "add",
        CODE_ROOT,
        "--skill",
        "integrate-egma",
        "--agent",
        "codex",
        "--copy",
        "--yes",
      ],
      {
        cwd: project,
        env: {
          ...process.env,
          CI: "1",
          CODEX_HOME: path.join(project, ".codex"),
          HOME: project,
          NO_COLOR: "1",
          TERM: "dumb",
        },
      },
    );

    for (const file of [
      path.join("references", "find-voice-agent.md"),
      path.join("references", "connect-retell.md"),
      path.join("references", "integrate-livekit.md"),
      path.join("references", "run-livekit-agent-locally.md"),
      path.join("scripts", "livekit-local.mjs"),
    ]) {
      const relative = path.join("integrate-egma", file);
      expect(
        await readFile(path.join(project, ".agents", "skills", relative)),
      ).toEqual(await readFile(path.join(SOURCE_ROOT, relative)));
    }
  });
});
