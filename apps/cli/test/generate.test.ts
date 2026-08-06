/**
 * From what egma has learned to tests on egma, with a scripted agent and
 * nobody watching.
 *
 * No model, no terminal, no human, and no assertion about the order egma does
 * things in. What is checked is what a developer could check afterwards: which
 * files are in their repository, what those files say, which tests are on the
 * platform and pinned, and the line the wizard left behind.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseTestFile } from "../src/folder/test-file.ts";
import { HeadlessUI } from "../src/ui/headless-ui.ts";
import { NO_BEHAVIORS_REASON } from "../src/wizard/gate.ts";
import { readExistingTests } from "../src/wizard/existing-tests.ts";
import { walk } from "../src/wizard/walk.ts";
import { startFakeRetell, type FakeRetell, type FakeRetellScript } from "./support/fake-retell.ts";
import type { FakeStep } from "./support/fake-agent.ts";
import { startPlatform, type Platform } from "./support/fixture-platform/index.ts";
import { gradeEveryRun } from "./support/grading.ts";
import {
  CLI_ENTRY,
  EXISTING_TESTS_FIXTURES,
  FAKE_AGENT,
  MANIFEST,
  makeWorkspace,
  type Workspace,
} from "./support/workspace.ts";

// Three real subprocesses and two servers per walk, inside a run using every
// core: the budget is generous so that only a broken walk can reach it.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const KEY = "key_9c3b7a1e5d2f8064a3b1";
const PROMPT = "You answer the order line for a bookbinding workshop.\nNever quote a price.\n";

const ONE_AGENT: FakeRetellScript = {
  keys: [KEY],
  agents: [
    {
      agent_id: "agent_0001",
      agent_name: "order-line",
      response_engine: { type: "retell-llm", llm_id: "llm_0001" },
    },
  ],
  llms: [{ llm_id: "llm_0001", general_prompt: PROMPT, general_tools: [{ type: "end_call" }] }],
};

/** The fragment that names the convert task, whatever material it carries. */
const CONVERT_TASK = "----- begin ";

/** The fragment only the generate task has, whatever it is asked for. */
const GENERATE_TASK = "## The words the agent is running on";

/** The fragment that names the generate task, for a suite of this size. */
function generateTask(howMany: number): string {
  return `Write ${howMany} ${howMany === 1 ? "test" : "tests"}`;
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

/** One test file, as a coding agent that had read the notes would write it. */
function fileFor(input: {
  readonly name: string;
  readonly personas?: readonly string[];
  readonly behaviors: readonly string[];
}): string {
  return [
    "---",
    `name: ${input.name}`,
    ...(input.personas === undefined ? [] : [`personas: [${input.personas.join(", ")}]`]),
    "---",
    "## Scenario",
    `Somebody rings the order line about ${input.name.replaceAll("-", " ")}.`,
    "## Expected behaviors",
    ...input.behaviors.map((behavior, index) => `${index + 1}. ${behavior}`),
    "",
  ].join("\n");
}

/** Writing one file, announced the way the notes tell a coding agent to. */
function writes(input: {
  readonly name: string;
  readonly personas?: readonly string[];
  readonly behaviors: readonly string[];
}): FakeStep[] {
  return [
    { kind: "say", text: `egma:writing ${input.name}\n` },
    {
      kind: "write-file",
      path: `egma/tests/${input.name}.md`,
      content: fileFor(input),
    },
    { kind: "say", text: `egma:wrote ${input.name}\n` },
  ];
}

/** The names of a suite of this size, so a script can be written by counting. */
function names(howMany: number, from = 1): string[] {
  return Array.from({ length: howMany }, (_, index) => `situation-${index + from}`);
}

type WalkOutcome = {
  readonly ui: HeadlessUI;
  readonly report: Awaited<ReturnType<typeof walk>>;
};

/** One whole walk, with the answers written in advance. */
async function runWalk(options: {
  readonly script: string;
  readonly existingTests?: string;
  readonly howManyTests?: number;
}): Promise<WalkOutcome> {
  const ui = new HeadlessUI({
    answers: {
      "retell-key": KEY,
      ...(options.existingTests === undefined
        ? {}
        : { "existing-tests": options.existingTests }),
    },
  });

  // The walk ends in a run, and a run ends when verdicts arrive. Nothing here
  // conducts a simulation, so the fixture is given the one thing a platform
  // with a simulator attached has: something that judges what is queued.
  const grading = gradeEveryRun(platform);
  let report;
  try {
    report = await walk({
      ui,
      launch: workspace.launch(options.script),
      cwd: workspace.dir,
      signal: new AbortController().signal,
      platform: { url: platform.url, credentialsFile: workspace.credentialsFile },
      retell: { url: retell.url },
      home: path.join(workspace.dir, "pretend-home"),
      runPollMs: 20,
      ...(options.howManyTests === undefined ? {} : { howManyTests: options.howManyTests }),
    });
  } finally {
    grading.stop();
  }

  return { ui, report };
}

/**
 * How many tests the walk put on egma, read from the run it went on to start.
 *
 * A run pins the version of every test it executes, and this walk's run is over
 * exactly what the push uploaded — so the run is the record of the push, and
 * reading it there is reading the fact rather than a report of it.
 */
function pushedToEgma(): number {
  return platform.running.runs[0]?.testVersionIds.length ?? 0;
}

/** The step that finds the voice agent, answered the same way every time. */
const FOUND: FakeStep[] = [
  { kind: "say", text: "egma:found framework retell-sdk\n" },
  { kind: "say", text: "egma:found prompts prompts/order-line.md\n" },
  { kind: "stop", reason: "end_turn" },
];

const testsFolder = (): string => path.join(workspace.dir, "egma", "tests");

async function filesInFolder(): Promise<string[]> {
  return (await readdir(testsFolder())).sort();
}

async function readTest(name: string): Promise<ReturnType<typeof parseTestFile>> {
  const file = path.join(testsFolder(), name);
  return parseTestFile(await readFile(file, "utf8"), name, name.replace(/\.md$/u, ""));
}

/** Every set of instructions egma sent the coding agent, in order. */
async function tasksSent(): Promise<string[]> {
  const report = JSON.parse(
    await readFile(path.join(workspace.dir, "fake-agent-report.json"), "utf8"),
  ) as { instructions: string[] };
  return report.instructions;
}

describe("the whole generate step", () => {
  it("converts what the developer had, tops the suite up, and pushes what it may", async () => {
    const material = "order-line-tests.csv";
    await copyFile(
      path.join(EXISTING_TESTS_FIXTURES, material),
      path.join(workspace.dir, material),
    );

    // Two out of the developer's own material, ten written to reach twelve —
    // and one of the ten with nothing to check, which is the whole point.
    // A persona the developer's own material names, and that egma holds — the
    // one shape of file that may carry a personas line.
    platform.tests.addPersona("somebody-in-a-hurry");

    const converted = ["quoted-a-price", "lost-the-order-number"];
    const generated = names(9, 1);

    const script = await workspace.script({
      steps: FOUND,
      stepsByTask: [
        {
          contains: CONVERT_TASK,
          steps: [
            { kind: "say", text: `egma:plan ${converted.join(", ")}\n` },
            ...writes({
              name: "quoted-a-price",
              personas: ["somebody-in-a-hurry"],
              behaviors: ["The agent does not quote a price."],
            }),
            ...writes({
              name: "lost-the-order-number",
              behaviors: ["The agent repeats the order number back once."],
            }),
            { kind: "stop", reason: "end_turn" },
          ],
        },
        {
          contains: generateTask(10),
          steps: [
            { kind: "say", text: `egma:plan ${[...generated, "nothing-to-check"].join(", ")}\n` },
            ...generated.flatMap((name) =>
              writes({ name, behaviors: ["The agent says the workshop's name."] }),
            ),
            // A file with no expected behaviors: it can never fail, so it can
            // never be a test.
            ...writes({ name: "nothing-to-check", behaviors: [] }),
            { kind: "stop", reason: "end_turn" },
          ],
        },
      ],
    });

    const { ui, report } = await runWalk({ script, existingTests: material });

    // Twelve files are in the repository, including the one egma will not push.
    expect(await filesInFolder()).toHaveLength(12);
    expect(await filesInFolder()).toContain("nothing-to-check.md");

    // Eleven are on egma, each as a pinned version, and the twelfth is not.
    expect(report.kind).toBe("run-started");
    expect(pushedToEgma()).toBe(11);
    expect(platform.tests.tests).toHaveLength(11);
    expect(platform.tests.tests.map((test) => test.name)).not.toContain("nothing-to-check");

    for (const name of [...converted, ...generated]) {
      const held = await readTest(`${name}.md`);
      expect(held.version, name).toMatch(/^tstv_/u);
      expect(held.expectedBehaviors.length, name).toBeGreaterThan(0);
    }

    // The file egma would not push is exactly as the coding agent left it: no
    // pin, and nobody tidied it away.
    const refused = await readTest("nothing-to-check.md");
    expect(refused.version).toBeNull();
    expect(refused.expectedBehaviors).toEqual([]);

    // And the developer was told, in words that say what to do about it.
    expect(ui.record.gate?.heldBack).toEqual([
      { shown: "egma/tests/nothing-to-check.md", reason: NO_BEHAVIORS_REASON },
    ]);
    expect(ui.record.statuses.join("\n")).toContain(NO_BEHAVIORS_REASON);
  });

  it("hands the developer's own material to the task, and never a path to go and fetch", async () => {
    const material = "order-line-tests.md";
    await copyFile(
      path.join(EXISTING_TESTS_FIXTURES, material),
      path.join(workspace.dir, material),
    );

    const script = await workspace.script({
      steps: FOUND,
      stepsByTask: [
        {
          contains: CONVERT_TASK,
          steps: [
            ...writes({
              name: "quoted-a-price",
              behaviors: ["The agent does not quote a price."],
            }),
            { kind: "stop", reason: "end_turn" },
          ],
        },
        {
          contains: generateTask(1),
          steps: [
            ...writes({ name: "open-on-sunday", behaviors: ["The agent says which days."] }),
            { kind: "stop", reason: "end_turn" },
          ],
        },
      ],
    });

    const { report } = await runWalk({ script, existingTests: material, howManyTests: 2 });

    const tasks = await tasksSent();
    const convert = tasks.find((task) => task.includes(CONVERT_TASK)) ?? "";
    const held = await readFile(path.join(EXISTING_TESTS_FIXTURES, material), "utf8");

    // Every word of the file is in the task egma sent, so the agent has no
    // reason to open anything, and is told so.
    expect(convert).toContain(held.trimEnd());
    expect(convert).toContain("Do not open the file");
    expect(convert).toContain("Convert, do not invent.");

    expect(report.kind).toBe("run-started");
    expect(pushedToEgma()).toBe(2);
  });

  it("grounds what it generates in the words the provider is running", async () => {
    const script = await workspace.script({
      steps: FOUND,
      stepsByTask: [
        {
          contains: generateTask(2),
          steps: [
            ...writes({ name: "price-question", behaviors: ["The agent does not quote."] }),
            ...writes({ name: "sunday-drop-off", behaviors: ["The agent says which days."] }),
            { kind: "stop", reason: "end_turn" },
          ],
        },
      ],
    });

    const { ui, report } = await runWalk({ script, howManyTests: 2 });

    const tasks = await tasksSent();
    const generate = tasks.find((task) => task.includes(generateTask(2))) ?? "";

    // What Retell actually runs, and what the coding agent found in the
    // repository, are both in the task.
    expect(generate).toContain(PROMPT.trimEnd());
    expect(generate).toContain("retell-sdk");
    expect(generate).toContain("prompts/order-line.md");
    expect(generate).toContain("order-line");

    // And what egma does not have is said as plainly: a file may not name a
    // persona egma would turn the whole test away over.
    expect(generate).toContain("leave the `personas` line out of every file");

    // Nobody was asked to convert anything, because nobody had anything.
    expect(tasks.some((task) => task.includes(CONVERT_TASK))).toBe(false);
    expect(ui.record.asked).toContain("existing-tests");

    expect(report.kind).toBe("run-started");
    expect(pushedToEgma()).toBe(2);
  });

  it("generates nothing when the developer's own material already fills the suite", async () => {
    const material = "order-line-tests.csv";
    await copyFile(
      path.join(EXISTING_TESTS_FIXTURES, material),
      path.join(workspace.dir, material),
    );

    const script = await workspace.script({
      steps: FOUND,
      stepsByTask: [
        {
          contains: CONVERT_TASK,
          steps: [
            ...writes({ name: "quoted-a-price", behaviors: ["The agent does not quote."] }),
            ...writes({ name: "open-on-sunday", behaviors: ["The agent says which days."] }),
            { kind: "stop", reason: "end_turn" },
          ],
        },
      ],
    });

    const { report } = await runWalk({ script, existingTests: material, howManyTests: 2 });

    const tasks = await tasksSent();
    expect(tasks.some((task) => task.includes(GENERATE_TASK))).toBe(false);
    expect(report.kind).toBe("run-started");
    expect(pushedToEgma()).toBe(2);
  });

  it("says plainly what it will not read, and carries on without it", async () => {
    await writeFile(path.join(workspace.dir, ".env"), "SECRET=shhh\n", "utf8");

    const script = await workspace.script({
      steps: FOUND,
      stepsByTask: [
        {
          contains: generateTask(1),
          steps: [
            ...writes({ name: "price-question", behaviors: ["The agent does not quote."] }),
            { kind: "stop", reason: "end_turn" },
          ],
        },
      ],
    });

    const { ui, report } = await runWalk({
      script,
      existingTests: ".env",
      howManyTests: 1,
    });

    expect(ui.record.statuses.join("\n")).toContain("egma never reads .env files");
    // The task that ran carried nothing of the file, and nothing was converted.
    const tasks = await tasksSent();
    expect(tasks.join("\n")).not.toContain("SECRET=shhh");
    expect(tasks.some((task) => task.includes(CONVERT_TASK))).toBe(false);

    // Turning down one file is not turning down the walk.
    expect(report.kind).toBe("run-started");
    expect(pushedToEgma()).toBe(1);
  });

  it("says so rather than pushing nothing when the coding agent wrote nothing usable", async () => {
    const script = await workspace.script({
      steps: FOUND,
      stepsByTask: [
        {
          contains: generateTask(2),
          steps: [
            ...writes({ name: "nothing-to-check", behaviors: [] }),
            { kind: "stop", reason: "end_turn" },
          ],
        },
      ],
    });

    const { report } = await runWalk({ script, howManyTests: 2 });

    expect(report.kind).toBe("failed");
    expect(platform.tests.tests).toHaveLength(0);
    // The file is still there for the developer to look at.
    expect(await filesInFolder()).toEqual(["nothing-to-check.md"]);
  });

  it("writes the folder's config from what it registered, and names the suite", async () => {
    const script = await workspace.script({
      steps: FOUND,
      stepsByTask: [
        {
          contains: generateTask(1),
          steps: [
            ...writes({
              name: "price-question",
              personas: ["somebody-in-a-hurry"],
              behaviors: ["The agent does not quote."],
            }),
            { kind: "stop", reason: "end_turn" },
          ],
        },
      ],
    });

    platform.tests.addPersona("somebody-in-a-hurry");
    const { ui } = await runWalk({ script, howManyTests: 1 });

    const config = await readFile(path.join(workspace.dir, "egma", "config.yaml"), "utf8");
    expect(config).toContain("name: order-line");
    expect(config).toContain("name: retell-1");
    expect(config).toContain("name: first-suite");

    // The list a developer scans says the two things worth scanning.
    expect(ui.record.gate?.suite).toBe("first-suite");
    expect(ui.record.gate?.rows).toEqual([
      {
        name: "price-question",
        persona: "somebody-in-a-hurry",
        shown: "egma/tests/price-question.md",
        file: path.join(testsFolder(), "price-question.md"),
      },
    ]);
  });

  it("names the default persona for a test that names nobody", async () => {
    const script = await workspace.script({
      steps: FOUND,
      stepsByTask: [
        {
          contains: generateTask(1),
          steps: [
            ...writes({ name: "price-question", behaviors: ["The agent does not quote."] }),
            { kind: "stop", reason: "end_turn" },
          ],
        },
      ],
    });

    const { ui } = await runWalk({ script, howManyTests: 1 });

    expect(ui.record.gate?.rows[0]?.persona).toBe("default persona");
    // And the platform gave it the one every project is seeded with.
    expect(await readTest("price-question.md")).toMatchObject({
      personas: ["default-persona"],
    });
  });
});

describe("with nobody watching", () => {
  it("takes the one answer it cannot ask for from the command, and opens its own gate", async () => {
    const material = "order-line-tests.csv";
    await copyFile(
      path.join(EXISTING_TESTS_FIXTURES, material),
      path.join(workspace.dir, material),
    );

    const script = await workspace.script({
      steps: FOUND,
      stepsByTask: [
        {
          contains: CONVERT_TASK,
          steps: [
            ...writes({ name: "quoted-a-price", behaviors: ["The agent does not quote."] }),
            { kind: "stop", reason: "end_turn" },
          ],
        },
        {
          contains: GENERATE_TASK,
          steps: [
            ...writes({ name: "open-on-sunday", behaviors: ["The agent says which days."] }),
            { kind: "stop", reason: "end_turn" },
          ],
        },
      ],
    });

    // The walk ends in a run, and the fixture is given something that judges
    // what the run queues — the least a platform with a simulator looks like.
    const grading = gradeEveryRun(platform);
    const result = await new Promise<{ stdout: string; code: number }>((resolve) => {
      const child = spawn(
        process.execPath,
        [
          CLI_ENTRY,
          "--headless",
          "--cwd",
          workspace.dir,
          "--existing-tests",
          material,
          // Named as well as commanded, so the skill offer is reached at all:
          // egma will not offer to write a skill for an agent it has no
          // convention for.
          "--coding-agent",
          "claude-acp",
          "--",
          process.execPath,
          FAKE_AGENT,
          script,
        ],
        {
          cwd: workspace.dir,
          env: workspace.env({
            EGMA_URL: platform.url,
            EGMA_RETELL_URL: retell.url,
            EGMA_RETELL_API_KEY: KEY,
            // Nowhere near the home of whoever is running this.
            HOME: path.join(workspace.dir, "pretend-home"),
          }),
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stdout = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.on("close", (code) => resolve({ stdout, code: code ?? 1 }));
    });
    grading.stop();

    // No terminal, no keystroke, and the whole walk happened anyway.
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("written: quoted-a-price");
    expect(result.stdout).toContain("test: open-on-sunday default persona");
    expect(platform.tests.tests.map((test) => test.name).sort()).toEqual([
      "open-on-sunday",
      "quoted-a-price",
    ]);

    // Including the run, followed to a verdict — and the skill offer, which a
    // run with nobody watching answers by installing nothing at all.
    expect(result.stdout).toMatch(/^first-verdict: /mu);
    expect(result.stdout).toContain("Nothing was installed.");
    expect(existsSync(path.join(workspace.dir, "pretend-home", ".claude"))).toBe(false);
  });
});

/**
 * The one path a person types, and what egma will open with it.
 *
 * It is the same discipline the drift check works under, and it is checked on
 * its own because every one of these answers is a thing egma must refuse
 * whatever else is happening around it.
 */
describe("the file a developer points at", () => {
  it("reads a file inside the folder, and says what it read", async () => {
    await mkdir(path.join(workspace.dir, "docs"), { recursive: true });
    await writeFile(path.join(workspace.dir, "docs", "cases.csv"), "a,b\n1,2\n", "utf8");

    expect(await readExistingTests(workspace.dir, "docs/cases.csv")).toEqual({
      kind: "read",
      shown: path.join("docs", "cases.csv"),
      content: "a,b\n1,2\n",
    });
  });

  it("takes n, no, and nothing at all as the answer most people give", async () => {
    for (const said of ["n", "N", "no", "none", "", "   ", null]) {
      expect(await readExistingTests(workspace.dir, said), String(said)).toEqual({ kind: "none" });
    }
  });

  it("will not climb out of the folder it was invited into", async () => {
    const outside = await makeWorkspace({ "secrets.csv": "a,b\n" });
    try {
      const climbing = await readExistingTests(
        workspace.dir,
        path.relative(workspace.dir, path.join(outside.dir, "secrets.csv")),
      );
      expect(climbing.kind).toBe("unusable");

      const absolute = await readExistingTests(
        workspace.dir,
        path.join(outside.dir, "secrets.csv"),
      );
      expect(absolute.kind).toBe("unusable");
    } finally {
      await outside.remove();
    }
  });

  it("will not read a .env file, whoever asked it to", async () => {
    await writeFile(path.join(workspace.dir, ".env.local"), "SECRET=shhh\n", "utf8");

    const refused = await readExistingTests(workspace.dir, ".env.local");
    expect(refused).toEqual({
      kind: "unusable",
      reason: "egma never reads .env files, and never hands one on.",
    });
  });

  it("says which of the ordinary things went wrong", async () => {
    const missing = await readExistingTests(workspace.dir, "cases.csv");
    expect(missing.kind === "unusable" && missing.reason).toContain("There is nothing at");

    await writeFile(path.join(workspace.dir, "empty.csv"), "\n", "utf8");
    const empty = await readExistingTests(workspace.dir, "empty.csv");
    expect(empty.kind === "unusable" && empty.reason).toContain("is empty");

    // A spreadsheet saved as a spreadsheet is bytes nobody here can read.
    await writeFile(
      path.join(workspace.dir, "cases.xlsx"),
      Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x08]),
    );
    const binary = await readExistingTests(workspace.dir, "cases.xlsx");
    expect(binary.kind === "unusable" && binary.reason).toContain("Export it as CSV");
  });
});
