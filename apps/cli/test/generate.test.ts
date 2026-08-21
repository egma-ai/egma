/** Whole-wizard proof for one platform-backed generated suite. */

import { mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  folderPathsIn,
  readRepository,
  serializeSuiteManifest,
} from "../src/folder/egma-folder.ts";
import { HeadlessUI } from "../src/ui/headless-ui.ts";
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
const PROMPT = "You answer the order line for a bookbinding workshop.\nNever quote a price.\n";

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
      general_prompt: PROMPT,
      general_tools: [{ type: "end_call" }],
    },
  ],
};

const FOUND: FakeStep[] = [
  { kind: "say", text: "egma:found framework retell-sdk\n" },
  { kind: "say", text: "egma:found prompts prompts/order-line.md\n" },
  { kind: "stop", reason: "end_turn" },
];

function testFile(name: string, behaviors: readonly string[]): string {
  return [
    "---",
    "format: 4",
    `name: ${name}`,
    "---",
    "## Scenario",
    `Somebody rings the order line about ${name.replaceAll("-", " ")}.`,
    "## Expected behaviors",
    ...behaviors.map((behavior, index) => `${index + 1}. ${behavior}`),
    "",
  ].join("\n");
}

function writes(name: string, behaviors: readonly string[]): FakeStep[] {
  return [
    { kind: "say", text: `egma:writing ${name}\n` },
    {
      kind: "write-file",
      path: `egma/tests/generated/${name}.md`,
      content: testFile(name, behaviors),
    },
    { kind: "say", text: `egma:wrote ${name}\n` },
  ];
}

let platform: Platform;
let workspace: Workspace;
let retell: FakeRetell;

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

async function walk(generated: readonly FakeStep[], howManyTests: number) {
  const script = await workspace.script({
    steps: FOUND,
    stepsByTask: [
      {
        contains: GENERATE_TASK,
        steps: [...generated, { kind: "stop", reason: "end_turn" }],
      },
    ],
  });
  const ui = new HeadlessUI({
    answers: { "retell-key": KEY, reach: "text" },
  });
  const grading = gradeEveryRun(platform);
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
      howManyTests,
    });
    return { report, ui };
  } finally {
    grading.stop();
  }
}

describe("generated suite", () => {
  it("creates the suite first, writes its full folder, pushes it once, and runs it", async () => {
    const result = await walk(
      writes("never-quotes-a-price", ["The agent does not quote a price."]),
      1,
    );

    expect(result.report.kind).toBe("run-started");
    const repository = await readRepository(folderPathsIn(workspace.dir));
    expect(repository.suites).toHaveLength(1);
    const suite = repository.suites[0]!;
    expect(suite.directory).toBe("generated");
    expect(suite.manifest.name).toBe("order-line tests");
    expect(suite.tests.map((test) => test.test.name)).toEqual(["never-quotes-a-price"]);
    expect(await readFile(suite.manifestFile, "utf8")).toBe(
      serializeSuiteManifest(suite.manifest),
    );

    const config = await readFile(folderPathsIn(workspace.dir).config, "utf8");
    expect(config).toContain("project:");
    expect(config).not.toContain("suite:");
    expect(platform.suites.suites).toEqual([
      expect.objectContaining({ id: suite.manifest.id, name: "order-line tests" }),
    ]);
    expect(platform.tests.tests).toEqual([
      expect.objectContaining({ suiteId: suite.manifest.id, name: "never-quotes-a-price" }),
    ]);
    expect(platform.running.runs).toEqual([
      expect.objectContaining({ suiteId: suite.manifest.id, expectedSimulationCount: 1 }),
    ]);
    expect(
      platform.records.filter(
        (record) => record.method === "POST" && record.path === "/v1/repository/change-set",
      ),
    ).toHaveLength(1);
    expect(
      platform.records.filter(
        (record) => record.method === "POST" && record.path === "/v1/tests",
      ),
    ).toHaveLength(0);

    const agentReport = JSON.parse(
      await readFile(path.join(workspace.dir, "fake-agent-report.json"), "utf8"),
    ) as { instructions: string[] };
    expect(
      agentReport.instructions.some((instruction) =>
        instruction.includes("egma/tests/generated"),
      ),
    ).toBe(true);
  });

  it("does not push or run a subset when one generated file is invalid", async () => {
    const result = await walk(
      [
        ...writes("valid-test", ["The agent says the workshop name."]),
        ...writes("missing-behavior", []),
      ],
      2,
    );

    expect(result.report).toMatchObject({ kind: "failed" });
    expect(result.ui.record.gate?.heldBack.map((held) => held.shown)).toContain(
      "egma/tests/generated/missing-behavior.md",
    );
    expect(platform.suites.suites).toHaveLength(1);
    expect(platform.tests.tests).toHaveLength(0);
    expect(platform.running.runs).toHaveLength(0);
    expect(
      platform.records.some(
        (record) => record.method === "POST" && record.path === "/v1/repository/change-set",
      ),
    ).toBe(false);
  });

  it("does not remove a suite directory another process created after the remote write", async () => {
    await platform.close();
    const root = path.join(folderPathsIn(workspace.dir).tests, "generated");
    const marker = path.join(root, "owned-by-another-process.txt");
    platform = await startPlatform({
      afterSuiteCreate: () => {
        mkdirSync(root);
        writeFileSync(marker, "keep\n", "utf8");
      },
    });
    await workspace.signIn(platform.url, platform.device.mint());

    await expect(walk([], 1)).rejects.toThrow(/Pull to recover it/u);

    await expect(readFile(marker, "utf8")).resolves.toBe("keep\n");
    expect(platform.suites.suites).toHaveLength(1);
  });
});
