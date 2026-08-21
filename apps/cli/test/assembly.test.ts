/**
 * The whole walk, offline, with nobody at the keyboard.
 *
 * Intro, login, finding the voice agent, connecting it, the folder, generation,
 * the gate, the push, the run, the skill offer and the exit block — one walk,
 * start to finish, against the fixture platform, the committed fixture
 * repository, a scripted coding agent and a UI with no screen. No model, no
 * browser, no terminal, no network beyond this machine, and nothing typed by a
 * person.
 *
 * The one thing the fixture cannot do for itself is conduct a simulation, so it
 * is given the least a platform with a simulator attached has: something that
 * judges what a run queues. Exactly one verdict is delivered, because the
 * wizard leaves at the first one and the count in the exit line has to be a
 * number this check can name.
 *
 * **What is asserted is what a developer could check afterwards** — which agent
 * and which connection are on egma, which tests are there and at which frozen
 * versions, which files are in the repository and what they pin, which run is
 * going and over what, what the offer wrote (nothing), and the block left in
 * the terminal. Nothing here asserts the order egma did any of it in: that is
 * egma's business, and a check that pinned it would have to be rewritten every
 * time a step moved.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readConfig } from "../src/folder/egma-folder.ts";
import { parseTestFile } from "../src/folder/test-file.ts";
import { readCredentials } from "../src/platform/credentials.ts";
import { HeadlessUI } from "../src/ui/headless-ui.ts";
import { buildExitNotice, exitLines } from "../src/wizard/exit-line.ts";
import { selectedPlatform } from "../src/wizard/login-step.ts";
import { runWizard } from "../src/wizard/wizard-flow.ts";
import type { FakeStep } from "./support/fake-agent.ts";
import { startFakeRetell, type FakeRetell, type FakeRetellScript } from "./support/fake-retell.ts";
import { startPlatform, type Platform } from "./support/fixture-platform/index.ts";
import { gradeEveryRun } from "./support/grading.ts";
import {
  RETELL_FIXTURE_REPO,
  filesUnder,
  makeWorkspace,
  type Workspace,
} from "./support/workspace.ts";

// One coding-agent subprocess and two servers per wizard run, inside a run using every core:
// the budget is generous so that only a broken walk can reach it.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const KEY = "key_5f1a9c73e28b46d0a7c4";

/** Which agent the account holds, which is what the connection will point at. */
const RETELL_AGENT_ID = "agent_quillfeather_order_line";

/**
 * One agent on the account, running the fixture repository's own prompt.
 *
 * The repository's words and the provider's words are the same here on purpose:
 * drift has checks of its own, and a walk that is about everything else should
 * not have a drift line in the middle of it.
 */
function account(prompt: string): FakeRetellScript {
  return {
    keys: [KEY],
    agents: [
      {
        agent_id: RETELL_AGENT_ID,
        channel: "chat",
        agent_name: "order-line",
        response_engine: { type: "retell-llm", llm_id: "llm_quillfeather" },
      },
    ],
    llms: [
      {
        llm_id: "llm_quillfeather",
        general_prompt: prompt,
        general_tools: [{ type: "end_call" }, { type: "custom", name: "look_up_order" }],
      },
    ],
  };
}

/** How many tests this walk asks for. The suite the gate lists. */
const SUITE_SIZE = 12;

/** The fragment that names the find-the-agent task, whatever folder it is for. */
const DISCOVERY_TASK = "Find the voice agent in";

/** The fragment that names the write-the-tests task, for a suite of this size. */
const GENERATE_TASK = `Write ${SUITE_SIZE} tests`;

let platform: Platform;
let retell: FakeRetell;
let workspace: Workspace;
let prompt: string;
/** The home this walk's coding agent keeps its configuration in. Throwaway. */
let home: string;

beforeEach(async () => {
  platform = await startPlatform();
  // The committed fixture repository: an invented workshop with invented
  // prompts and invented tools, so there is a real repository to be found.
  workspace = await makeWorkspace({}, { from: RETELL_FIXTURE_REPO });
  home = path.join(workspace.dir, "pretend-home");
  await mkdir(home, { recursive: true });
  prompt = await readFile(path.join(workspace.dir, "prompts", "order-line.md"), "utf8");
  retell = await startFakeRetell(account(prompt));
});

afterEach(async () => {
  await retell.close();
  await platform.close();
  await workspace.remove();
});

/** The names of the suite the scripted agent writes. */
function suiteNames(): string[] {
  return [
    "price-question-on-a-rebind",
    "sunday-drop-off",
    "lost-the-order-number",
    "wants-it-by-friday",
    "asks-for-a-human",
    "changes-the-address",
    "cancels-halfway-through",
    "asks-what-leather-costs",
    "two-books-one-order",
    "collection-instead-of-delivery",
    "damaged-on-arrival",
    "will-not-say-their-name",
  ];
}

/** One test file, as a coding agent that had read the notes would write it. */
function fileFor(name: string): string {
  return [
    "---",
    `name: ${name}`,
    "---",
    "## Scenario",
    `Somebody rings the order line about ${name.replaceAll("-", " ")}.`,
    "## Expected behaviors",
    "1. The agent says the workshop's name.",
    "2. The agent does not quote a price.",
    "",
  ].join("\n");
}

/** Writing one file, announced the way the notes tell a coding agent to. */
function writes(name: string): FakeStep[] {
  return [
    { kind: "say", text: `egma:writing ${name}\n` },
    { kind: "write-file", path: `egma/tests/${name}.md`, content: fileFor(name) },
    { kind: "say", text: `egma:wrote ${name}\n` },
  ];
}

describe("the whole walk, offline", () => {
  it("signs in, finds the agent, connects it, writes the suite, runs it and leaves", async () => {
    const names = suiteNames();

    const script = await workspace.script({
      steps: [{ kind: "stop", reason: "end_turn" }],
      stepsByTask: [
        {
          contains: DISCOVERY_TASK,
          steps: [
            {
              kind: "tool-call",
              id: "t1",
              title: "Read",
              toolKind: "read",
              locations: [{ path: "package.json" }],
            },
            { kind: "read-file", path: "package.json", recordAs: "manifest" },
            { kind: "tool-call-update", id: "t1", status: "completed" },
            { kind: "say", text: "egma:found framework retell-sdk\n" },
            { kind: "say", text: "egma:found prompts prompts/order-line.md\n" },
            { kind: "say", text: "egma:found tools src/tools/*.ts (2 definitions)\n" },
            { kind: "stop", reason: "end_turn" },
          ],
        },
        {
          contains: GENERATE_TASK,
          steps: [
            { kind: "say", text: `egma:plan ${names.join(", ")}\n` },
            ...names.flatMap((name) => writes(name)),
            { kind: "stop", reason: "end_turn" },
          ],
        },
      ],
    });

    // Everything a person would have done, done by the check: the keystroke at
    // the intro and the gate open themselves, the browser approves the code,
    // and the one thing nobody can answer in advance is answered here. The
    // skill offer is left unanswered, which is skip — the answer that has to
    // leave the machine exactly as it was.
    const ui = new HeadlessUI({ answers: { "retell-key": KEY, reach: "text" } });

    // One verdict, and one only: the wizard leaves at the first, and a sweep
    // that judged the whole suite would put a number in the exit line that
    // depended on which poll landed first.
    const grading = gradeEveryRun(platform, { atMost: 1 });
    let report;
    try {
      report = await runWizard({
        ui,
        // Named as well as commanded, because which coding agent this is
        // decides whether there is a skill offer at all and where it points.
        launch: { ...workspace.launch(script), id: "claude-acp" },
        cwd: workspace.dir,
        signal: new AbortController().signal,
        platform: selectedPlatform({
          url: platform.url,
          credentialsFile: workspace.credentialsFile,
          openBrowser: async (url: string) => {
            const code = new URL(url).searchParams.get("user_code") ?? "";
            return platform.device.approve(code);
          },
        }),
        retell: { url: retell.url },
        howManyTests: SUITE_SIZE,
        home,
        runPollMs: 20,
      });
    } finally {
      grading.stop();
    }

    /* what the developer is left holding */

    const startedRun = platform.running.runs[0];
    const address = `${platform.url}/runs/${startedRun?.id ?? ""}`;
    expect(report).toEqual({
      kind: "run-started",
      resultsUrl: address,
      graded: 1,
      total: SUITE_SIZE,
      skill: { kind: "skipped", drivenAgentName: "Claude Code" },
    });

    // The block, exactly: a headline, the address alone on its line, and the
    // two sentences a developer takes with them.
    expect(exitLines(report)).toEqual([
      `✓ Your first run is live — 1 of ${SUITE_SIZE} graded so far.`,
      "",
      address,
      "",
      "Tests are code now: egma/tests/ (committed). Edit them, then egma push.",
      'Hand your coding agent this: "Read egma/config.yaml, then egma --help — you can pull, push, and trigger runs from here."',
    ]);
    // Nothing rides the address: the browser that approved this machine
    // earlier in this same walk is already signed in.
    expect(new URL(address).search).toBe("");
    expect(exitLines(report).join("\n")).not.toContain(KEY);

    // And skipping is never silent.
    expect(buildExitNotice(report)).toBe(
      "Nothing was installed. Claude Code can still drive Egma — tell it to run egma --help.",
    );

    // Discovery and test writing are two turns in one ACP context. The coding
    // agent is started, initialized and given a session exactly once.
    const driven = JSON.parse(
      await readFile(path.join(workspace.dir, "fake-agent-report.json"), "utf8"),
    ) as {
      processIds: number[];
      initializeCount: number;
      sessionIds: string[];
      promptSessionIds: string[];
    };
    expect(new Set(driven.processIds).size).toBe(1);
    expect(driven.initializeCount).toBe(1);
    expect(driven.sessionIds).toHaveLength(1);
    expect(driven.promptSessionIds).toEqual([
      driven.sessionIds[0],
      driven.sessionIds[0],
    ]);

    /* this machine is signed in, and to this egma */

    const held = await readCredentials(workspace.credentialsFile, platform.url);
    expect(held?.url).toBe(platform.url);
    expect(platform.device.keys).toContain(held?.key ?? "");

    /* the agent and the way to reach it are on egma */

    expect(platform.registered.agents.map((agent) => agent.name)).toEqual(["order-line"]);
    const connection = platform.registered.connections[0];
    expect(platform.registered.connections).toHaveLength(1);
    // One connection, and it is the one the walk chose: text, which is a chat
    // connection over the selected voice agent. Creating both is the bug the
    // choice exists to kill.
    expect(connection).toMatchObject({
      agentId: platform.registered.agents[0]?.id,
      agentPlatform: "retell",
      connectionKind: "retell_chat_api",
      accessVariant: "retell_chat_api.api_key",
      modality: "chat",
      name: "retell_chat_api-1",
      config: { retellAgentId: RETELL_AGENT_ID },
    });
    // The key reached egma, and only its last characters ever came back.
    expect(connection?.credentialsHint).toBe(KEY.slice(-4));
    expect(platform.registered.sealed).toContain(KEY);
    // And what Retell is running stayed at Retell: nothing egma wrote holds a
    // copy of it, because a copy would go stale from the moment it landed.
    expect(platform.registered.agents[0]).not.toHaveProperty("pulled");

    /* the tests are on egma, every one of them a frozen version */

    expect(platform.tests.tests).toHaveLength(SUITE_SIZE);
    expect(platform.tests.tests.map((test) => test.name).sort()).toEqual([...names].sort());
    for (const test of platform.tests.tests) {
      expect(test.versionId, test.name).toMatch(/^tstv_/u);
      expect(platform.tests.versionsOf(test.name), test.name).toBe(1);
    }

    /* one run is going, over exactly the versions that were just pushed */

    expect(platform.running.runs).toHaveLength(1);
    expect([...(startedRun?.testVersionIds ?? [])].sort()).toEqual(
      platform.tests.tests.map((test) => test.versionId).sort(),
    );
    const simulations = platform.running.simulationsOf();
    expect(simulations).toHaveLength(SUITE_SIZE);
    expect(simulations.map((one) => one.testName).sort()).toEqual([...names].sort());

    // One verdict landed, and it is the one the screen marked. The other
    // eleven are exactly where they were: the wizard left, the suite did not.
    expect(simulations.filter((one) => one.verdict !== null)).toHaveLength(1);
    expect(simulations.filter((one) => one.status === "queued")).toHaveLength(SUITE_SIZE - 1);

    const watched = ui.record.run;
    expect(watched?.runId).toBe(startedRun?.id);
    expect(watched?.rows).toHaveLength(SUITE_SIZE);
    expect(watched?.firstVerdict?.verdict).toBe("passed");
    expect(watched?.firstVerdict?.first).toBe(true);
    expect(watched?.rows.filter((row) => row.first)).toHaveLength(1);
    expect(watched?.tally).toMatchObject({
      passed: 1,
      failed: 0,
      skipped: 0,
      errored: 0,
      graded: 1,
      pending: SUITE_SIZE - 1,
      total: SUITE_SIZE,
    });

    /* the offer was made, and skipping wrote nothing anywhere */

    expect(ui.record.asked).toContain("skills-offer");
    expect(ui.record.skillPlaces).toMatchObject({
      drivenAgentId: "claude-acp",
      name: "Claude Code",
      project: path.join(workspace.dir, ".claude", "skills", "egma", "SKILL.md"),
      global: path.join(home, ".claude", "skills", "egma", "SKILL.md"),
    });
    expect(await filesUnder(home)).toEqual([]);
    expect(existsSync(path.join(home, ".claude"))).toBe(false);
    expect(existsSync(path.join(workspace.dir, ".claude"))).toBe(false);

    /* the files are in the repository, pinned to those versions */

    const inFolder = await filesUnder(path.join(workspace.dir, "egma"));
    expect(inFolder).toContain("config.yaml");
    expect(inFolder.filter((name) => name.startsWith("tests/"))).toHaveLength(SUITE_SIZE);

    const pinned = new Map(platform.tests.tests.map((test) => [test.name, test.versionId]));
    for (const name of names) {
      const file = path.join(workspace.dir, "egma", "tests", `${name}.md`);
      const test = parseTestFile(await readFile(file, "utf8"), `${name}.md`, name);
      expect(test.version, name).toBe(pinned.get(name));
      expect(test.expectedBehaviors.length, name).toBeGreaterThan(0);
    }

    // The folder's config names what egma registered, so a second developer
    // cloning this repository lands on the same agent.
    const config = await readConfig(path.join(workspace.dir, "egma", "config.yaml"));
    expect(config.platform).toEqual({
      origin: platform.url,
    });
    expect(config.agent).toMatchObject({
      name: "order-line",
      id: platform.registered.agents[0]?.id,
    });
    expect(config.connection).toMatchObject({
      name: "retell_chat_api-1",
      id: connection?.id,
    });
    expect(config.suite?.name).toBe("first-suite");

    /* nobody was asked anything they had not already answered */

    // What egma worked out for itself before it asked anything, which is what
    // fills the screen while the developer is away in a browser.
    expect(ui.record.detection).toEqual({
      drivenAgentName: "Fake Agent",
      gitRepository: false,
      egmaFolder: false,
      testsAlreadyHere: 0,
    });

    expect(ui.record.gatesOpened).toEqual(["begin", "run-tests"]);
    expect(ui.record.gate?.rows).toHaveLength(SUITE_SIZE);
    // One agent on the account is not a choice, so the choice never opened.
    expect(ui.record.agentChoices).toEqual([]);
    // And the repository is otherwise exactly as it was: egma wrote its own
    // folder and touched nothing else the fixture repository ships.
    expect(await filesUnder(path.join(workspace.dir, "src"))).toEqual([
      "config.ts",
      "server.ts",
      "tools/book-drop-off.ts",
      "tools/look-up-order.ts",
    ]);
  });
});
