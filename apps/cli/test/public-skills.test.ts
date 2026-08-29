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
  it("cleans retired compiled surfaces before a package is built", async () => {
    const manifest = JSON.parse(
      await readFile(path.join(PACKAGE_ROOT, "package.json"), "utf8"),
    ) as { readonly scripts?: Record<string, string> };

    expect(manifest.scripts?.build).toContain("tools/clean-dist.mjs");
    expect(manifest.scripts?.prepack).toBe("pnpm build");
  });

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

  it("keeps one complete integration state map behind two selected references", async () => {
    const root = path.join(SOURCE_ROOT, "integrate-egma");
    const skill = await readFile(path.join(root, "SKILL.md"), "utf8");
    const onboarding = await readFile(
      path.join(root, "references", "onboard.md"),
      "utf8",
    );
    const liveKitWorker = await readFile(
      path.join(root, "references", "livekit-worker.md"),
      "utf8",
    );

    expect(await filesUnder(path.join(root, "references"))).toEqual([
      "livekit-worker.md",
      "onboard.md",
    ]);
    expect(skill).toContain("[references/onboard.md](references/onboard.md)");
    expect(skill).toContain(
      "[references/livekit-worker.md](references/livekit-worker.md)",
    );

    expect(skill).toMatch(
      /An end-to-end setup prompt authorizes[\s\S]*Do\s+not stop for repeated approval/u,
    );
    expect(onboarding).toMatch(
      /The original end-to-end prompt already authorizes[\s\S]*continue without another approval request/u,
    );

    expect(skill).toMatch(
      /Those outputs own changing command syntax and\s+platform choices/u,
    );
    expect(skill).toMatch(
      /Let the CLI create and update `egma\/config\.yaml`, suite manifests, and other\s+Egma-owned scaffold/u,
    );
    expect(onboarding).toContain("stable IDs and receipts define identity");
    expect(onboarding).toMatch(
      /The CLI owns the repository binding, agent and connection records, suite\s+manifest, and all stable IDs/u,
    );

    expect(onboarding).toMatch(
      /For both outcomes, create the simulation connection first, then enable\s+monitoring on that recorded agent/u,
    );
    expect(onboarding).toMatch(
      /both to `monitoring-setup` after execution and grading are terminal/u,
    );

    const stateLines = onboarding
      .split("\n")
      .filter((line) => /^- `[^`]+` — /u.test(line));
    expect(
      stateLines.map((line) => /^- `(?<state>[^`]+)`/u.exec(line)?.groups?.state),
    ).toEqual([
      "login",
      "discovery",
      "connection-setup",
      "test-writing",
      "publish",
      "run",
      "monitoring-setup",
      "complete",
      "no-agent",
      "unsupported-platform",
    ]);
    for (const line of stateLines) {
      expect(line.match(/[.!?](?=\s|$)/gu) ?? [], line).toHaveLength(1);
    }

    const operating = await readFile(path.join(SOURCE_ROOT, "egma", "SKILL.md"), "utf8");
    const authoring = await readFile(
      path.join(SOURCE_ROOT, "write-egma-tests", "SKILL.md"),
      "utf8",
    );
    expect(operating).not.toContain("The folder has this shape");
    expect(operating).not.toContain("```yaml");
    expect(operating).toMatch(
      /Do not invent a\s+folder shape, manifest field, version, or stable ID/u,
    );
    expect([operating, authoring].join("\n")).not.toMatch(
      /egma (?:pull|push|validate|run|suite create|personas)(?:\s|$)/u,
    );
    expect(authoring).not.toContain("egma/config.yaml");
    expect(authoring).not.toContain("suite.yaml");

    expect(liveKitWorker).toMatch(
      /Run the read-only LiveKit source-contract command listed by the current\s+`egma --help`/u,
    );
    expect(liveKitWorker).not.toMatch(
      /egma-sim-chat-|ctx\.job\.room\.name|AgentSession\.start|ctx\.connect\(\)/u,
    );
    expect(liveKitWorker).toContain(
      "egma @ git+https://github.com/egma-ai/egma.git#subdirectory=sdks/python",
    );
    expect(liveKitWorker).toMatch(/Do not add an SDK version, tag, or commit/u);
    expect([skill, onboarding, liveKitWorker].join("\n")).not.toMatch(
      /https:\/\/github\.com\/egma-ai\/egma\/archive\//u,
    );
    expect(liveKitWorker).not.toMatch(/[a-f0-9]{40}/u);

    expect(onboarding).toMatch(/Retell or LiveKit/u);
    expect(onboarding).toMatch(
      /Report\s+Pipecat or Vapi accurately even though the CLI cannot connect them yet/u,
    );
    expect(liveKitWorker).toContain("`@livekit/agents`");
    expect(liveKitWorker).toMatch(/Egma SDK hooks are not supported there yet/u);

    expect(skill).toMatch(
      /Pause only when the developer must approve browser login, supply a credential/u,
    );
    expect(skill).toMatch(
      /Immediately before\s+a phone run[\s\S]*wait for explicit approval/u,
    );
    expect(skill).toMatch(
      /Keep credentials[\s\S]*Never place them in arguments, source, diffs, or reports[\s\S]*do not read or\s+edit environment files/u,
    );

    expect(liveKitWorker).toContain("`BackgroundAudioPlayer`");
    expect(liveKitWorker).toMatch(/Start\s+each publisher only outside the chat branch/u);
    expect(liveKitWorker).toMatch(
      /Disabling session audio does not\s+silence an independent publisher/u,
    );

    expect([skill, onboarding, liveKitWorker].join("\n")).not.toMatch(CLI_MARKER);
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
      path.join("references", "livekit-worker.md"),
      path.join("references", "onboard.md"),
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
