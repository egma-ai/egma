/**
 * The public Agent Skills surface from the files people edit to the external
 * installer that reads them.
 *
 * The repository-root tree is the only source. `npx skills` reads that tree
 * directly; the Egma CLI package does not carry a second copy.
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
const SKILLS_CLI = require.resolve("skills/bin/cli.mjs");

const PUBLIC_SKILLS = [
  { directory: "integrate-egma", name: "integrate-egma" },
  { directory: "write-voice-agent-tests", name: "write-egma-tests" },
] as const;
const PUBLIC_SKILL_NAMES = PUBLIC_SKILLS.map(({ name }) => name);
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
  it("cleans retired compiled surfaces before a package is built", async () => {
    const manifest = JSON.parse(
      await readFile(path.join(PACKAGE_ROOT, "package.json"), "utf8"),
    ) as { readonly scripts?: Record<string, string> };

    expect(manifest.scripts?.build).toContain("tools/clean-dist.mjs");
    expect(manifest.scripts?.prepack).toBe("pnpm build");
  });

  it("has only the intentional public skills, in standard folders", async () => {
    expect((await readdir(SOURCE_ROOT)).sort()).toEqual(
      PUBLIC_SKILLS.map(({ directory }) => directory).sort(),
    );

    for (const { directory, name } of PUBLIC_SKILLS) {
      const content = await readFile(
        path.join(SOURCE_ROOT, directory, "SKILL.md"),
        "utf8",
      );
      expect(content).toMatch(new RegExp(`^name: ${name}$`, "mu"));
      expect(content).toMatch(/^description: \S.+$/mu);
      expect(content).not.toMatch(CLI_MARKER);
    }
  });

  it("shows a new test in a shape the real parser reads", async () => {
    const skill = await readFile(
      path.join(SOURCE_ROOT, "write-voice-agent-tests", "SKILL.md"),
      "utf8",
    );
    const examples = markdownExamples(skill);
    expect(examples).not.toHaveLength(0);

    const test = parseTestFile(examples[0] ?? "", "shown-in-skill.md", "fallback");
    expect(test.format).toBe(5);
    expect(test.name).toBe("missed-appointment-reschedule");
    expect(test.scenario).not.toBe("");
    expect(test.expectedBehaviors.length).toBeGreaterThan(0);
    expect(test.mockTools.map((tool) => tool.tool)).toEqual(["check_availability"]);
    expect(test.env).toEqual({ retell_dynamic_variables: { caller_name: "Margaret" } });
  });

  it("routes integration work through the selected public references", async () => {
    const root = path.join(SOURCE_ROOT, "integrate-egma");
    const skill = await readFile(path.join(root, "SKILL.md"), "utf8");
    const simulation = await readFile(
      path.join(root, "references", "setup-simulation-testing.md"),
      "utf8",
    );

    expect(await filesUnder(path.join(root, "references"))).toEqual([
      "livekit-agent-connection-guide.md",
      "retell-agent-connection-guide.md",
      "setup-monitoring.md",
      "setup-simulation-testing.md",
    ]);
    expect(skill).toContain(
      "[simulation testing setup guide](references/setup-simulation-testing.md)",
    );
    expect(skill).toContain(
      "[monitoring setup guide](references/setup-monitoring.md)",
    );
    expect(simulation).toContain(
      "[guide to connect a livekit agent](references/livekit-agent-connection-guide.md)",
    );
    expect(simulation).toContain(
      "[guide to connect a retell agent](references/retell-agent-connection-guide.md)",
    );
    expect([skill, simulation].join("\n")).not.toMatch(CLI_MARKER);
  });

  it("keeps the documented complete test in the shape the real parser reads", async () => {
    const docs = await readFile(path.join(CODE_ROOT, "docs", "cli", "test-files.mdx"), "utf8");
    const example = markdownExamples(docs).find(
      (shown) => shown.includes("identity_revision:"),
    );
    expect(example).toBeDefined();

    const test = parseTestFile(example ?? "", "docs/cli/test-files.mdx", "fallback");
    expect(test.format).toBe(5);
    expect(test.expectedBehaviors).toHaveLength(2);
    expect(test.mockTools).toEqual([{ tool: "check_availability", answer: { slots: [] } }]);
    expect(test.env).toEqual({
      retell_dynamic_variables: { caller_name: "Margaret" },
      job_dispatch_metadata: { tenant: "acme" },
    });
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

    expect(output).toContain(`Found ${PUBLIC_SKILL_NAMES.length} skills`);
    for (const name of PUBLIC_SKILL_NAMES) expect(output).toContain(`  ${name}\n`);
    expect(output).not.toContain("coordinate-implementation");
    expect(output).not.toContain("finding-the-voice-agent");
    expect(output).not.toContain("retell-voice-agents");
  });

  it("uses the same bytes that the repository publishes", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "egma-public-skill-use-"));
    temporary.push(home);

    for (const { directory, name } of PUBLIC_SKILLS) {
      const { stdout } = await run(
        process.execPath,
        [SKILLS_CLI, "use", CODE_ROOT, "--skill", name],
        {
          cwd: home,
          env: { ...process.env, CI: "1", HOME: home, NO_COLOR: "1", TERM: "dumb" },
        },
      );
      const shown = /<SKILL\.md>\n(?<body>[\s\S]*?)\n<\/SKILL\.md>/u.exec(stdout)?.groups?.body;
      const source = await readFile(
        path.join(SOURCE_ROOT, directory, "SKILL.md"),
        "utf8",
      );

      expect(shown?.trimEnd()).toBe(source.trimEnd());
    }
  });

  it("installs the complete minimal integration skill", async () => {
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

    const installed = path.join(project, ".agents", "skills", "integrate-egma");
    const files = [
      "SKILL.md",
      path.join("agents", "openai.yaml"),
      path.join("references", "livekit-agent-connection-guide.md"),
      path.join("references", "retell-agent-connection-guide.md"),
      path.join("references", "setup-monitoring.md"),
      path.join("references", "setup-simulation-testing.md"),
    ];
    expect(await filesUnder(installed)).toEqual(files);

    for (const file of files) {
      const relative = path.join("integrate-egma", file);
      expect(await readFile(path.join(project, ".agents", "skills", relative))).toEqual(
        await readFile(path.join(SOURCE_ROOT, relative)),
      );
    }
  });
});
