/** The live ACP activity while tests land, with no invented waiting content. */

import process from "node:process";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { FakeStep } from "./support/fake-agent.ts";
import { startFakeRetell, type FakeRetell, type FakeRetellScript } from "./support/fake-retell.ts";
import { startPlatform, type Platform } from "./support/fixture-platform/index.ts";
import {
  chooseNoExistingTests,
  chooseTesting,
  runInTerminal,
  showing,
} from "./support/pty.ts";
import {
  CLI_ENTRY,
  FAKE_AGENT,
  RETELL_FIXTURE_REPO,
  makeWorkspace,
  type Workspace,
} from "./support/workspace.ts";

vi.setConfig({ testTimeout: 90_000, hookTimeout: 60_000 });

const KEY = "key_44a0d7c1e6b39f28510d";

const ACCOUNT: FakeRetellScript = {
  keys: [KEY],
  agents: [
    {
      agent_id: "agent_quillfeather_order_line",
      channel: "chat",
      agent_name: "order-line",
      response_engine: { type: "retell-llm", llm_id: "llm_quillfeather" },
    },
  ],
  llms: [{ llm_id: "llm_quillfeather", general_prompt: "Answer the order line.\n" }],
};

/** The fragment only the write-the-tests task has, whatever it asks for. */
const GENERATE_TASK = "## The words the agent is running on";

const NAMES = [
  "open-on-sunday",
  "lost-the-order-number",
  "wants-it-by-friday",
  "changes-an-order",
];
const RELEASE_WRITING = ".fake-agent-release-teaching";

function fileFor(name: string): string {
  return [
    "---",
    "format: 4",
    `name: ${name}`,
    "---",
    "## Scenario",
    `Somebody rings the order line about ${name.replaceAll("-", " ")}.`,
    "## Expected behaviors",
    "1. The agent says the workshop's name.",
    "",
  ].join("\n");
}

function writes(name: string): FakeStep[] {
  return [
    { kind: "say", text: `egma:writing ${name}\n` },
    { kind: "write-file", path: `egma/tests/order-line-tests/${name}.md`, content: fileFor(name) },
    { kind: "say", text: `egma:wrote ${name}\n` },
  ];
}

/**
 * The script both runs use.
 *
 * A terminal check can hold the scripted coding agent on a file barrier until
 * it has read the first card. A headless walk needs no barrier. Neither path
 * waits for a clock.
 */
function scriptFor(workspace: Workspace, releaseFile?: string): Promise<string> {
  return workspace.script({
    steps: [
      { kind: "say", text: "egma:found framework retell-sdk\n" },
      { kind: "stop", reason: "end_turn" },
    ],
    stepsByTask: [
      {
        contains: GENERATE_TASK,
        steps: [
          { kind: "say", text: `egma:plan ${NAMES.join(", ")}\n` },
          ...(releaseFile === undefined
            ? []
            : ([{ kind: "wait-for-file", path: releaseFile }] satisfies FakeStep[])),
          ...NAMES.flatMap((name) => writes(name)),
          { kind: "stop", reason: "end_turn" },
        ],
      },
    ],
  });
}

let platform: Platform;
let retell: FakeRetell;
let workspace: Workspace;

beforeEach(async () => {
  platform = await startPlatform();
  retell = await startFakeRetell(ACCOUNT);
  workspace = await makeWorkspace({}, { from: RETELL_FIXTURE_REPO });
  await workspace.signIn(platform.url, platform.device.mint());
});

afterEach(async () => {
  await retell.close();
  await platform.close();
  await workspace.remove();
});

describe("the live activity, while the files land", () => {
  it("shows the ACP session instead of invented waiting content", async () => {
    const script = await scriptFor(workspace, RELEASE_WRITING);

    const terminal = runInTerminal({
      command: process.execPath,
      args: [
        CLI_ENTRY,
        "--url",
        platform.url,
        "--cwd",
        workspace.dir,
        "--",
        process.execPath,
        FAKE_AGENT,
        script,
      ],
      cwd: workspace.dir,
      env: workspace.env({ EGMA_RETELL_URL: retell.url }),
      // Wide, because the ending under check here is lines rather than
      // sentences. A terminal wraps whatever will not fit, and a check that
      // read a wrapped line as two would be checking the terminal's width and
      // not egma's output. It is wide enough for the pane either way.
      cols: 200,
    });

    try {
      await showing(terminal, "Welcome to egma", "Press Enter to authenticate");
      terminal.write("\r");
      await showing(terminal, "Egma is about to find", "[enter] begin");
      terminal.write("\r");

      await chooseTesting(terminal);
      await showing(terminal, "Paste your Retell API key");
      terminal.write(`${KEY}\r`);

      // Text or phone. Not this check's subject, and not skippable
      // either: egma never picks one of the two for a developer.
      await showing(terminal, "How should Egma reach this agent?");
      terminal.write("\r");

      await chooseNoExistingTests(terminal);

      const pane = await showing(
        terminal,
        "Writing tests for your voice agent.",
        "Progress: 0/4",
        "This may take a couple of minutes.",
        "egma:plan",
      );
      expect(pane).not.toContain("One situation to put your agent");
      const drawn = terminal.raw();

      // No rotating lesson or invented progress was painted during the wait.
      expect(drawn).not.toContain("The synthetic person on the");
      expect(drawn).not.toContain("A persona");
    } finally {
      await terminal.kill();
    }
  });

  it("keeps the ACP activity readable in a narrow terminal", async () => {
    const script = await scriptFor(workspace, RELEASE_WRITING);

    const terminal = runInTerminal({
      command: process.execPath,
      args: [
        CLI_ENTRY,
        "--url",
        platform.url,
        "--cwd",
        workspace.dir,
        "--",
        process.execPath,
        FAKE_AGENT,
        script,
      ],
      cwd: workspace.dir,
      env: workspace.env({ EGMA_RETELL_URL: retell.url }),
      cols: 64,
    });

    try {
      await showing(terminal, "Welcome to egma", "Press Enter to authenticate");
      terminal.write("\r");
      await showing(terminal, "[enter] begin");
      terminal.write("\r");
      await chooseTesting(terminal);
      await showing(terminal, "Paste your Retell API key");
      terminal.write(`${KEY}\r`);

      // Text or phone. Not this check's subject, and not skippable
      // either: egma never picks one of the two for a developer.
      await showing(terminal, "How should Egma reach this agent?");
      terminal.write("\r");
      await chooseNoExistingTests(terminal);

      const narrow = await showing(
        terminal,
        "Writing tests for your voice agent.",
        "Progress: 0/4",
        "This may take a couple of minutes.",
        "egma:plan",
      );
      expect(narrow).not.toContain("One situation to put your agent");
    } finally {
      await terminal.kill();
    }
  });
});
