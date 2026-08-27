/**
 * The instruction content that ships with the CLI.
 *
 * Public Agent Skills are usable on their own. The integration skill routes
 * each phase to one short reference. The wizard adds its marker protocol and
 * the projected reference root at dispatch time. These
 * checks keep those layers separate while proving the npm package carries
 * everything the public skill can read.
 */

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import {
  PUBLIC_SKILL_NAMES,
  drivingSkill,
  integrateEgmaReference,
  instructionsWith,
  publicSkill,
  publicSkillDirectory,
  publicSkillFile,
} from "../src/skills/index.ts";
import { discoveryInstructions } from "../src/wizard/discovery.ts";
import { FACTS } from "../src/wizard/facts.ts";
import { pasteFallbackMessage } from "../src/wizard/no-coding-agent.ts";
import { generateInstructions } from "../src/wizard/test-generation.ts";
import { mockAuthoringInstructions } from "../src/wizard/mock-authoring-step.ts";
import { workerIntegrationInstructions } from "../src/wizard/worker-integration-step.ts";
import { BANNED, LIVEKIT_SESSION_OBJECT, SCENARIO_HEADING } from "./support/glossary.ts";

const run = promisify(execFile);
const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI_MARKER = /\begma:(?:found|note|none|abort|plan|writing|wrote)\b/u;

describe("Egma's instruction content", () => {
  it("keeps every public skill in the standard standalone shape", () => {
    for (const name of PUBLIC_SKILL_NAMES) {
      const content = publicSkill(name);
      expect(content.startsWith("---\n")).toBe(true);
      expect(content).toMatch(new RegExp(`^name: ${name}$`, "mu"));
      expect(content).toMatch(/^description: \S.+$/mu);
      expect(content.length).toBeGreaterThan(500);
      expect(content.length).toBeLessThan(20_000);
    }
  });

  it("keeps marker protocols in assembled CLI tasks, not public skills", () => {
    const discovery = discoveryInstructions("/repo");
    expect(discovery.startsWith(publicSkill("integrate-egma"))).toBe(true);
    expect(discovery).toContain(publicSkillDirectory("integrate-egma"));
    expect(discovery).not.toContain("# Connect a Retell agent");
    for (const marker of ["egma:found", "egma:note", "egma:none", "egma:abort"]) {
      expect(discovery).toContain(marker);
    }

    const writing = generateInstructions(
      {
        cwd: "/repo",
        suiteDirectory: "release-contract",
        facts: new Map(),
        prompt: "Help the person with an appointment.",
        toolCount: 1,
        agentName: "reception",
        taken: [],
        personas: [],
      },
      2,
    );
    for (const marker of ["egma:plan", "egma:writing", "egma:wrote", "egma:abort"]) {
      expect(writing).toContain(marker);
    }

    for (const name of PUBLIC_SKILL_NAMES) {
      expect(publicSkill(name)).not.toMatch(CLI_MARKER);
    }
  });

  it("teaches the test-writing work before the run-specific task", () => {
    const writing = publicSkill("write-egma-tests");
    expect(writing).toContain("egma/tests/");
    expect(writing).toContain("## Expected behaviors");
    expect(writing).toContain("## Mock tools");
    expect(writing.replace(/\s+/gu, " ")).toContain(
      "Preserve every machine-owned field already in the frontmatter",
    );

    const instructions = generateInstructions(
      {
        cwd: "/repo",
        suiteDirectory: "release-contract",
        facts: new Map(),
        prompt: null,
        toolCount: 0,
        agentName: "agent",
        taken: [],
        personas: [],
      },
      1,
    );
    expect(instructions.indexOf(writing)).toBe(0);
    expect(instructions.indexOf(writing)).toBeLessThan(instructions.indexOf("# Your task"));
  });

  /** Code owns the field names; all prose that asks for them must agree. */
  it("asks for the facts Egma reads back, in the words Egma reads them", () => {
    const unwrapped = (text: string): string => text.replace(/\s+/gu, " ");
    const finding = discoveryInstructions("/repo");
    const readme = unwrapped(readFileSync(path.join(PACKAGE_ROOT, "README.md"), "utf8"));
    const pasted = unwrapped(pasteFallbackMessage());

    for (const fact of FACTS) {
      expect(finding, fact.name).toContain(`\`${fact.name}\``);
      expect(readme, fact.name).toContain(fact.phrase);
      expect(pasted, fact.name).toContain(fact.phrase);
    }
  });

  it("agrees with the README about the repository folder", () => {
    const layout = [
      "egma/",
      "  config.yaml     format 2 platform, project, agents, and connections",
      "  mock-tools.md   what Egma answers for the agent's tools with",
      "  tests/",
      "    release/      one local directory per suite",
      "      suite.yaml  stable suite id and mutable display name",
      "      *.md        zero or more tests in this suite",
      "    regression/   another suite in the same project",
      "      suite.yaml",
      "      *.md",
    ].join("\n");

    expect(drivingSkill()).toContain(layout);
    expect(readFileSync(path.join(PACKAGE_ROOT, "README.md"), "utf8")).toContain(layout);
  });

  it("still reads as prose after examples that contain code fences", () => {
    const insideAFence = (content: string): ReadonlySet<string> => {
      const shown = new Set<string>();
      let open: number | null = null;
      for (const raw of content.split("\n")) {
        const fence = /^\s*(`{3,})\s*(\S*)\s*$/u.exec(raw);
        if (fence !== null) {
          const ticks = (fence[1] as string).length;
          if (open === null) open = ticks;
          else if (fence[2] === "" && ticks >= open) open = null;
          continue;
        }
        if (open !== null) shown.add(raw.trim());
      }
      return shown;
    };

    const held: readonly (readonly [string, string, string])[] = [
      ["skills/egma/SKILL.md", drivingSkill(), "## Keep the folder and Egma in step"],
      [
        "skills/integrate-egma/SKILL.md",
        publicSkill("integrate-egma"),
        "# Integrate Egma",
      ],
      [
        "skills/write-egma-tests/SKILL.md",
        publicSkill("write-egma-tests"),
        "## Handle personas carefully",
      ],
      [
        "README.md",
        readFileSync(path.join(PACKAGE_ROOT, "README.md"), "utf8"),
        "## Your first suite of tests",
      ],
    ];

    for (const [where, content, heading] of held) {
      expect(content, where).toContain(heading);
      expect({ where, shownAsCode: insideAFence(content).has(heading) }).toEqual({
        where,
        shownAsCode: false,
      });
    }
  });

  it("says where each kind of mock-tool answer belongs", () => {
    const driving = drivingSkill().replace(/\s+/gu, " ");
    expect(driving).toContain("Project-wide answers live in `egma/mock-tools.md`");
    expect(driving).toContain("inside that test file under `## Mock tools`");

    const writing = publicSkill("write-egma-tests").replace(/\s+/gu, " ");
    expect(writing).toContain("Put either `answer` or `error` in its JSON block");
  });

  /**
   * The rule has to stand on its own where the project's mocked world is
   * empty, which is every Retell repository: mock tools are not served there
   * yet, so "different from the project-wide mocked world" pointed at nothing
   * and a coding agent reading it had no rule at all.
   */
  it("decides a test's mock tools from the test, not from a world that may be empty", () => {
    const writing = publicSkill("write-egma-tests").replace(/\s+/gu, " ");

    expect(writing).toContain(
      "Add `## Mock tools` when this test depends on a specific backend state",
    );
    expect(writing).toContain("Otherwise leave the section out.");
    expect(writing).toContain(
      "Where the project has no mocked world, a block here is the only answer Egma will serve",
    );
    expect(writing).not.toContain("only when this test needs an answer different");
  });

  /** The router owns common safety; the selected reference adds SDK-specific bounds. */
  it("teaches both SDK entries, named credential custody, and the printed fallback", () => {
    const integration = publicSkill("integrate-egma");
    const sdk = readFileSync(
      path.join(
        publicSkillDirectory("integrate-egma"),
        "references",
        "integrate-egma-sdk.md",
      ),
      "utf8",
    );

    // The testing entry, where it goes and why the wait is structural.
    expect(sdk).toContain("await mockable(agent, ctx, session)");
    expect(sdk).toContain("AgentSession.start");
    // The monitoring entry, which ticket 02 reuses and this lane never adds.
    expect(sdk).toContain("monitor_livekit(ctx)");
    expect(sdk).toContain("ctx.connect()");
    expect(sdk).toContain("EGMA_URL");
    expect(sdk).toContain("EGMA_API_KEY");
    expect(integration).toContain("Leave every `.env` file unread and unchanged");
    expect(sdk).toContain("Keep both values out of changed files and command output");
    expect(sdk).not.toContain(".env");
    expect(sdk).toContain("When the entrypoint is unknown");
    expect(sdk.replace(/\s+/gu, " ")).toContain("Do not guess a worker file");
  });

  /** The mock-world task owns no worker file or SDK instructions. */
  it("keeps mock authoring on mock files and test overrides", () => {
    const authoring = mockAuthoringInstructions({
      cwd: "/repo",
      suiteDirectory: "generated",
      facts: new Map(),
      agentName: "front-desk",
      tests: ["greets-a-new-customer"],
    });

    expect(authoring.startsWith("# Your task")).toBe(true);
    expect(authoring).not.toContain(publicSkill("integrate-egma"));
    expect(authoring).not.toContain(publicSkill("write-egma-tests"));
    expect(authoring).toContain("egma/mock-tools.md");
    expect(authoring).not.toContain("worker file where");
    expect(authoring).not.toContain("dependency manifest");
    expect(authoring).not.toContain("egma:found worker-entry");
    for (const marker of [
      "egma:plan",
      "egma:writing",
      "egma:wrote",
      "egma:note",
      "egma:abort",
    ]) {
      expect(authoring).toContain(marker);
    }
  });

  it("gives one worker owner the selected SDK reference and final mode", () => {
    const router = publicSkill("integrate-egma");
    const sdk = integrateEgmaReference("integrate-egma-sdk");
    const integration = workerIntegrationInstructions(
      "/repo",
      new Map([["framework", "livekit-agents"]]),
      "both",
    );

    expect(integration.indexOf(router)).toBe(0);
    expect(integration).toContain(sdk);
    expect(integration.split(sdk)).toHaveLength(2);
    expect(integration).toContain("final mode is **both**");
    expect(integration).toContain("egma:found worker-entry");
    expect(integration).toContain("worker file where");
    expect(integration).toContain("dependency manifest");
  });

  it("recognizes both repository-managed and dashboard-managed Retell agents", () => {
    const retell = readFileSync(
      path.join(publicSkillDirectory("integrate-egma"), "references", "connect-retell.md"),
      "utf8",
    );
    expect(retell).toContain("retell-sdk");
    expect(retell).toContain("managed response engine");
    expect(retell).toContain("agent_");
    expect(retell).toContain("llm_");
  });

  it("recognizes LiveKit workers without assuming one SDK shape", () => {
    const livekit = readFileSync(
      path.join(
        publicSkillDirectory("integrate-egma"),
        "references",
        "find-voice-agent.md",
      ),
      "utf8",
    );
    expect(livekit).toContain("livekit-agents");
    expect(livekit).toContain("@livekit/agents");
    expect(livekit).toContain("AgentSession");
    expect(livekit).toContain("WorkerOptions");
    expect(livekit).toContain("dispatch name");
  });

  it("uses Egma's product words in public and dispatched content", () => {
    const retell = readFileSync(
      path.join(publicSkillDirectory("integrate-egma"), "references", "connect-retell.md"),
      "utf8",
    );
    const livekit = readFileSync(
      path.join(
        publicSkillDirectory("integrate-egma"),
        "references",
        "find-voice-agent.md",
      ),
      "utf8",
    );
    const all = [
      ...PUBLIC_SKILL_NAMES.map((name) => [name, publicSkill(name)] as const),
      ["integrate-egma/references/connect-retell.md", retell] as const,
      ["integrate-egma/references/find-voice-agent.md", livekit] as const,
    ];

    for (const [name, source] of all) {
      const content = source
        .replaceAll(SCENARIO_HEADING, "")
        .replaceAll(LIVEKIT_SESSION_OBJECT, "")
        // `call` is an ordinary verb here, not the banned noun for a simulation.
        .replace("Do not call it skipped.", "");
      for (const banned of BANNED) {
        expect({ name, banned: String(banned), hit: banned.exec(content)?.[0] ?? null }).toEqual({
          name,
          banned: String(banned),
          hit: null,
        });
      }
      expect(content).toContain("voice agent");
    }
  });

  it("carves out only the file-format heading from the vocabulary guard", () => {
    const taken = (text: string): string => text.replaceAll(SCENARIO_HEADING, "");

    expect(taken("## Scenario")).toBe("");
    expect(taken("- **`## Scenario`** is prose.")).toBe("- **** is prose.");
    expect(taken("#### scenario")).toBe("");

    for (const hiding of [
      "the scenario the test describes",
      "## Scenarios",
      "a scenario-led suite",
      "Scenario: the person is late",
    ]) {
      expect(taken(hiding), hiding).toMatch(/scenario/iu);
      expect(/\bscenarios?\b/iu.test(taken(hiding)), hiding).toBe(true);
    }
  });

  it("survives npm packing with every public skill and its references", async () => {
    const { stdout } = await run("npm", ["pack", "--dry-run", "--json"], {
      cwd: PACKAGE_ROOT,
    });
    const packed = (JSON.parse(stdout) as { files: { path: string }[] }[])[0];
    const paths = (packed?.files ?? []).map((file) => file.path);

    for (const name of PUBLIC_SKILL_NAMES) {
      expect(paths).toContain(`skills/${name}/SKILL.md`);
    }
    expect(paths).toContain("skills/integrate-egma/references/connect-retell.md");
    expect(paths).toContain("skills/integrate-egma/references/find-voice-agent.md");
    expect(paths).toContain("skills/integrate-egma/scripts/livekit-local.mjs");
    expect(paths.some((file) => file.startsWith("context/"))).toBe(false);
    for (const removed of [
      "dist/acp/drive.js",
      "dist/acp/registry.js",
      "dist/acp/registry-snapshot.json",
      "dist/ui/tui/screens/PromptsPointerScreen.js",
      "dist/wizard/walk.js",
    ]) {
      expect(paths).not.toContain(removed);
    }
  });

  it("reads every instruction from its package path", () => {
    for (const name of PUBLIC_SKILL_NAMES) {
      const file = publicSkillFile(name);
      expect(path.relative(PACKAGE_ROOT, file)).toBe(path.join("skills", name, "SKILL.md"));
      expect(readFileSync(file, "utf8")).toContain(publicSkill(name));
    }
    for (const [referenceName, heading] of [
      ["connect-retell", "# Connect a Retell agent"],
      ["find-voice-agent", "# Find the voice agent"],
      ["integrate-egma-sdk", "# Add the Egma SDK to a LiveKit worker"],
      ["run-livekit-agent-locally", "# Run a LiveKit agent locally"],
    ] as const) {
      const reference = path.join(
        publicSkillDirectory("integrate-egma"),
        "references",
        `${referenceName}.md`,
      );
      expect(path.relative(PACKAGE_ROOT, reference)).toBe(
        path.join("skills", "integrate-egma", "references", `${referenceName}.md`),
      );
      expect(readFileSync(reference, "utf8")).toContain(heading);
    }
  });

  it("keeps the integration router before the task and leaves phase details in references", () => {
    const integration = publicSkill("integrate-egma");
    const instructions = instructionsWith([integration], "# Your task\nLook.");

    expect(instructions.indexOf(integration)).toBe(0);
    expect(instructions).not.toContain("# Connect a Retell agent");
    expect(instructions).not.toContain("# Run a LiveKit agent locally");
    expect(instructions.endsWith("# Your task\nLook.")).toBe(true);
  });
});
