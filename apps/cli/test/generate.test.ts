/** Whole-wizard proof for one platform-backed generated suite. */

import { mkdirSync, writeFileSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
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
const SUITE_DIRECTORY = "order-line-tests";

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
    // What the generate task asks for: every file names at least one persona,
    // because a test says who calls and Egma refuses one that does not.
    "personas:",
    "  - Everyday caller",
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
      path: `egma/tests/${SUITE_DIRECTORY}/${name}.md`,
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
    expect(suite.directory).toBe(SUITE_DIRECTORY);
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
        instruction.includes(`egma/tests/${SUITE_DIRECTORY}`),
      ),
    ).toBe(true);

    /*
     * **The task names the personas the project really holds.** The wizard used
     * to tell the coding agent to leave the line out and let the project's
     * default apply — which stopped being true on 2026-08-24, when a test
     * naming no persona became a refusal. The task now reads the project's
     * personas and requires one, so a generated folder is one that pushes.
     */
    const task = agentReport.instructions.find((instruction) =>
      instruction.includes("## Personas"),
    );
    expect(task, "the generate task teaches the personas block").toBeDefined();
    expect(task).toContain("Every file must name at least one persona");
    expect(task).toContain("- Everyday caller");
    expect(task).not.toContain("leave the `personas` line out");

    // And the push itself names the caller, rather than leaving the platform
    // to choose one — which it no longer would.
    const pushed = platform.records.find(
      (record) =>
        record.method === "POST" && record.path === "/v1/repository/change-set",
    );
    expect(pushed?.body).toMatchObject({
      tests: [{ personas: ["Everyday caller"] }],
    });
    expect(
      platform.records.filter(
        (record) => record.method === "GET" && record.path === "/v1/personas",
      ).length,
      "the wizard reads who can call before writing a single file",
    ).toBeGreaterThan(0);
  });

  it("pulls existing project state before it creates and pushes the generated suite", async () => {
    const existing = platform.suites.add("Earlier browser suite");

    const result = await walk(
      writes("never-quotes-a-price", ["The agent does not quote a price."]),
      1,
    );

    expect(result.report.kind).toBe("run-started");
    expect(result.ui.record.statuses).toContain(
      "◆ Pulled the project's current suites, tests, and mock tools into this repository",
    );

    const repository = await readRepository(folderPathsIn(workspace.dir));
    expect(repository.suites.map((suite) => suite.manifest.id)).toContain(existing.id);
    expect(repository.suites).toHaveLength(2);
    const generated = repository.suites.find(
      (suite) => suite.manifest.name === "order-line tests",
    );
    expect(generated?.directory).toBe(SUITE_DIRECTORY);
    expect(
      await readdir(path.join(folderPathsIn(workspace.dir).tests, SUITE_DIRECTORY)),
    ).toEqual(["never-quotes-a-price.md", "suite.yaml"]);

    const pushed = platform.records.find(
      (record) =>
        record.method === "POST" && record.path === "/v1/repository/change-set",
    );
    expect(pushed?.body).toMatchObject({
      suites: expect.arrayContaining([
        { id: existing.id, name: "Earlier browser suite" },
      ]),
    });
    expect(platform.suites.suites).toHaveLength(2);
    expect(platform.tests.tests).toEqual([
      expect.objectContaining({ name: "never-quotes-a-price" }),
    ]);
  });

  it("stops before writing when Egma lists no persona for the project", async () => {
    // A project holding none is a project the platform cannot make — the
    // pointer is set at creation and the column cannot be null. The wizard
    // still refuses to write a folder that could only be refused at push.
    platform.personas.clear();

    const result = await walk(
      writes("never-quotes-a-price", ["The agent does not quote a price."]),
      1,
    );

    expect(result.report).toMatchObject({
      kind: "failed",
      reason: expect.stringContaining("Every test names at least one persona"),
    });
    expect(platform.tests.tests).toHaveLength(0);
    expect(platform.running.runs).toHaveLength(0);
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
      `egma/tests/${SUITE_DIRECTORY}/missing-behavior.md`,
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

  it.each([
    ["too few", writes("only-one", ["The agent says the workshop name."]), 2, 1],
    [
      "too many",
      [
        ...writes("first", ["The agent says the workshop name."]),
        ...writes("second", ["The agent says when the workshop opens."]),
      ],
      1,
      2,
    ],
  ] as const)("does not push when the coding agent writes %s tests", async (_case, steps, wanted, written) => {
    const result = await walk(steps, wanted);

    expect(result.report).toEqual({
      kind: "failed",
      reason:
        `Fake Agent left ${String(written)} ${written === 1 ? "test" : "tests"} in the first suite, ` +
        `but this setup requires exactly ${String(wanted)}. Keep exactly ${String(wanted)} test files there, then run the wizard again.`,
    });
    expect(platform.tests.tests).toHaveLength(0);
    expect(platform.running.runs).toHaveLength(0);
  });

  it("does not remove a suite directory another process created after the remote write", async () => {
    await platform.close();
    const root = path.join(folderPathsIn(workspace.dir).tests, SUITE_DIRECTORY);
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
