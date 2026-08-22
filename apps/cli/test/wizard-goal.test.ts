/**
 * The one question the wizard asks about itself, through the whole wizard.
 *
 * No model, no terminal, no human — a scripted coding-agent peer, a fixture
 * platform, and a fake Retell. What is asserted is what a developer could check
 * afterwards: which files landed, what the platform was asked to create, how
 * many times the coding agent was dispatched, and the line left behind. Never
 * the order of internal steps.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { folderPathsIn } from "../src/folder/egma-folder.ts";
import { HeadlessUI } from "../src/ui/headless-ui.ts";
import { buildExitLine } from "../src/wizard/exit-line.ts";
import { selectedPlatform } from "../src/wizard/login-step.ts";
import { runWizard } from "../src/wizard/wizard-flow.ts";
import type { FakeStep } from "./support/fake-agent.ts";
import { startFakeRetell, type FakeRetell, type FakeRetellScript } from "./support/fake-retell.ts";
import { startPlatform, type Platform } from "./support/fixture-platform/index.ts";
import { gradeEveryRun } from "./support/grading.ts";
import { makeWorkspace, MANIFEST, type Workspace } from "./support/workspace.ts";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const KEY = "key_9c3b7a1e5d2f8064a3b1";
const GENERATE_TASK = "## The words the agent is running on";
/** The fragment that names the mocked-world dispatch and nothing else. */
const MOCK_AUTHORING_TASK = "run isolated from its real";

const ONE_AGENT: FakeRetellScript = {
  keys: [KEY],
  agents: [
    {
      agent_id: "agent_0001",
      channel: "chat",
      agent_name: "order-line",
      response_engine: { type: "retell-llm", llm_id: "llm_0001" },
    },
  ],
  llms: [
    {
      llm_id: "llm_0001",
      general_prompt: "You answer the order line for a bookbinding workshop.\n",
      general_tools: [{ type: "end_call" }],
    },
  ],
};

const FOUND: FakeStep[] = [
  { kind: "say", text: "egma:found framework retell-sdk\n" },
  { kind: "say", text: "egma:found agent-name order-line\n" },
  { kind: "stop", reason: "end_turn" },
];

function testFile(name: string): string {
  return [
    "---",
    "format: 4",
    `name: ${name}`,
    "---",
    "## Scenario",
    "Somebody rings the order line about a late repair.",
    "## Expected behaviors",
    "1. The agent says when the repair will be ready.",
    "",
  ].join("\n");
}

function writesOneTest(name: string): FakeStep[] {
  return [
    { kind: "say", text: `egma:writing ${name}\n` },
    {
      kind: "write-file",
      path: `egma/tests/generated/${name}.md`,
      content: testFile(name),
    },
    { kind: "say", text: `egma:wrote ${name}\n` },
    { kind: "stop", reason: "end_turn" },
  ];
}

let platform: Platform;
let retell: FakeRetell;
let workspace: Workspace;

beforeEach(async () => {
  platform = await startPlatform();
  retell = await startFakeRetell(ONE_AGENT);
  workspace = await makeWorkspace({ "package.json": MANIFEST });
  await workspace.signIn(platform.url, platform.device.mint());
});

afterEach(async () => {
  await retell.close();
  await platform.close();
  await workspace.remove();
});

/** Every set of instructions the scripted peer was ever sent. */
async function dispatched(): Promise<readonly string[]> {
  try {
    const report = JSON.parse(
      await readFile(path.join(workspace.dir, "fake-agent-report.json"), "utf8"),
    ) as { instructions?: string[] };
    return report.instructions ?? [];
  } catch {
    return [];
  }
}

async function walk(goal: string | undefined) {
  const script = await workspace.script({
    steps: FOUND,
    stepsByTask: [
      { contains: GENERATE_TASK, steps: writesOneTest("late-repair") },
    ],
  });
  const ui = new HeadlessUI({
    answers: {
      "retell-key": KEY,
      reach: "text",
      ...(goal === undefined ? {} : { goal }),
    },
  });
  const grading = gradeEveryRun(platform, { atMost: 1 });
  try {
    const report = await runWizard({
      ui,
      launch: workspace.launch(script),
      cwd: workspace.dir,
      signal: new AbortController().signal,
      platform: selectedPlatform({
        url: platform.url,
        credentialsFile: workspace.credentialsFile,
      }),
      retell: { url: retell.url },
      home: path.join(workspace.dir, "pretend-home"),
      runPollMs: 20,
      howManyTests: 1,
    });
    return { report, ui };
  } finally {
    grading.stop();
  }
}

describe("the goal question", () => {
  /**
   * Asked after discovery, so the three answers can speak about the agent Egma
   * has just found rather than about voice agents in general.
   */
  it("names the repository's own agent and platform in the offer", async () => {
    const { ui } = await walk("testing");

    expect(ui.record.asked).toContain("goal");
    expect(ui.record.goalAsk).toMatchObject({
      platform: "retell",
      platformLabel: "Retell",
      agentName: "order-line",
    });
    // Nothing was asked before the agent was known.
    expect(ui.record.asked.indexOf("goal")).toBeLessThan(
      ui.record.asked.indexOf("retell-key"),
    );
  });

  /**
   * Today's flow, unchanged in substance — and mock authoring skipped without a
   * screen, because mock tools are not served on Retell yet. Two dispatches:
   * find the agent, write the tests.
   */
  it("runs the whole testing lane on Retell, with no mock authoring", async () => {
    const { report, ui } = await walk("testing");

    expect(report.kind).toBe("run-started");
    expect(platform.tests.tests).toHaveLength(1);
    expect(platform.running.runs).toHaveLength(1);

    const sent = await dispatched();
    expect(sent).toHaveLength(2);
    expect(sent.some((task) => task.includes(MOCK_AUTHORING_TASK))).toBe(false);

    // No mocked world exists and nothing outside egma/ was touched, so the
    // gate says nothing about either.
    expect(ui.record.gate?.mocks).toEqual([]);
    expect(ui.record.gate?.changed).toEqual([]);
    expect(ui.record.gate?.rows.map((row) => row.overrides)).toEqual([[]]);
  });

  /** A run with nobody watching takes the lane every `npx egma` has taken. */
  it("takes the testing lane when nobody answers the question", async () => {
    const { report } = await walk(undefined);

    expect(report.kind).toBe("run-started");
    expect(platform.running.runs).toHaveLength(1);
  });
});

describe("choosing monitoring, before the monitoring lane exists", () => {
  it.each(["monitoring", "both"] as const)(
    "creates nothing at all for %s, and says where to go instead",
    async (goal) => {
      const { report, ui } = await walk(goal);

      expect(report).toEqual({
        kind: "monitoring-in-the-web",
        goal,
        platformUrl: platform.url,
      });

      // Nothing was created: no connection, no suite, no tests, no run.
      expect(platform.registered.agents).toHaveLength(0);
      expect(platform.registered.connections).toHaveLength(0);
      expect(platform.registered.sealed).toHaveLength(0);
      expect(platform.tests.tests).toHaveLength(0);
      expect(platform.running.runs).toHaveLength(0);

      // And no Retell key was ever asked for, because nothing needed one.
      expect(ui.record.asked).not.toContain("retell-key");

      // The repository is exactly as the walk found it.
      await expect(
        readFile(folderPathsIn(workspace.dir).config, "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" });

      // The last line points at the one flow that can do this today.
      expect(buildExitLine(report)).toContain(platform.url);
      expect(buildExitLine(report)).toContain("Monitoring page");
    },
  );
});

describe("a repository that has already been through the wizard", () => {
  /**
   * The refusal comes before anything at all is started, so "nothing half-runs"
   * is a fact about the filesystem and the coding agent rather than an
   * intention: the peer was never dispatched, and the committed folder is
   * exactly what it was.
   */
  it("refuses politely and starts nothing", async () => {
    const paths = folderPathsIn(workspace.dir);
    await mkdir(paths.tests, { recursive: true });
    const committed = "project:\n  name: Bookbinding\n";
    await writeFile(paths.config, committed, "utf8");

    const script = await workspace.script({
      steps: FOUND,
      stepsByTask: [
        { contains: GENERATE_TASK, steps: writesOneTest("late-repair") },
      ],
    });
    const ui = new HeadlessUI({ answers: { "retell-key": KEY, reach: "text" } });

    const report = await runWizard({
      ui,
      launch: workspace.launch(script),
      cwd: workspace.dir,
      signal: new AbortController().signal,
      platform: selectedPlatform({
        url: platform.url,
        credentialsFile: workspace.credentialsFile,
      }),
      retell: { url: retell.url },
      home: path.join(workspace.dir, "pretend-home"),
      runPollMs: 20,
      howManyTests: 1,
    });

    expect(report).toEqual({ kind: "already-onboarded", folder: "egma/" });
    expect(ui.record.phase).toBe("already-onboarded");

    // The coding agent was never started, so nothing was asked of it.
    expect(await dispatched()).toEqual([]);
    expect(ui.record.asked).toEqual([]);

    // Nothing was created on the platform either.
    expect(platform.registered.agents).toHaveLength(0);
    expect(platform.tests.tests).toHaveLength(0);

    // And the developer's own committed file is byte for byte what it was.
    expect(await readFile(paths.config, "utf8")).toBe(committed);

    const line = buildExitLine(report);
    expect(line).toContain("already set up");
    expect(line).toContain("Delete or rename egma/");
  });
});
