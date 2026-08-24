/**
 * The connect step as a developer meets it, on a real terminal.
 *
 * A pseudo-terminal runs the built command and a headless terminal emulator
 * reads its screen and everything it wrote. That is the only way to check the
 * promises this step makes to a person rather than to a machine: that the key
 * is drawn as dots while it is typed, that one agent on the account costs no
 * keystrokes while several get a list to choose from, and that the choice
 * between text and phone is really put to the person at the keyboard.
 *
 * The key typed here is invented and reaches a fake Retell on this machine.
 */

import process from "node:process";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { startFakeRetell, type FakeRetell, type FakeRetellScript } from "./support/fake-retell.ts";
import { startPlatform, type Platform } from "./support/fixture-platform/index.ts";
import { gradeEveryRun } from "./support/grading.ts";
import { chooseTesting, runInTerminal, showing, type TerminalRun } from "./support/pty.ts";
import {
  CLI_ENTRY,
  FAKE_AGENT,
  MANIFEST,
  NO_RETELL,
  makeWorkspace,
  type Workspace,
} from "./support/workspace.ts";

// A real subprocess, a real terminal and a test run using every core: the
// budget is generous so that only a broken wizard can reach it.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const KEY = "key_h4j7d2s9f5g8k1l3m6n0";

const DIALLED = "+14155550111";
const ALSO_DIALLED = "+14155550999";

const ONE_AGENT: FakeRetellScript = {
  keys: [KEY],
  agents: [
    {
      agent_id: "agent_0001",
      agent_name: "order-line",
      channel: "chat",
      response_engine: { type: "retell-llm", llm_id: "llm_0001" },
    },
  ],
  llms: [{ llm_id: "llm_0001", general_prompt: "You answer the order line.\n" }],
  numbers: [
    {
      phone_number: DIALLED,
      nickname: "order line",
      inbound_agents: [{ agent_id: "agent_0001" }],
    },
  ],
};

const VOICE_AGENT: FakeRetellScript = {
  ...ONE_AGENT,
  agents: ONE_AGENT.agents.map((agent) => ({ ...agent, channel: "voice" as const })),
};

const TWO_AGENTS: FakeRetellScript = {
  keys: [KEY],
  agents: [
    { agent_id: "agent_0001", agent_name: "order-line", channel: "chat", response_engine: { type: "retell-llm", llm_id: "llm_0001" } },
    { agent_id: "agent_0002", agent_name: "after-hours", channel: "chat", response_engine: { type: "retell-llm", llm_id: "llm_0001" } },
  ],
  llms: [{ llm_id: "llm_0001", general_prompt: "You answer the order line.\n" }],
};

let platform: Platform;
let workspace: Workspace;
let retell: FakeRetell | undefined;
let terminal: TerminalRun | undefined;

beforeEach(async () => {
  platform = await startPlatform();
  workspace = await makeWorkspace({ "package.json": MANIFEST });
  await workspace.signIn(platform.url, platform.device.mint());
});

afterEach(async () => {
  // Waited for: the command is still writing its log into the folder that is
  // about to be removed, and a folder gaining an entry while it is walked is a
  // folder that will not go away.
  await terminal?.kill();
  terminal = undefined;
  await retell?.close();
  retell = undefined;
  await platform.close();
  await workspace.remove();
});

/** This screen's own hints, and the last line it draws. */
const KEY_HINTS = ["[enter] connect", "[esc] skip"] as const;

/** The wizard, past the intro, with a scripted coding agent that finds one fact. */
async function wizard(): Promise<TerminalRun> {
  const script = await workspace.script({
    steps: [
      { kind: "say", text: "egma:found framework retell-sdk\n" },
      { kind: "stop", reason: "end_turn" },
    ],
    // These checks are about the key screen, and the walk carries on past it
    // into writing tests. One file is enough for the run to reach its ending.
    stepsByTask: [
      {
        contains: "Write 12 tests",
        steps: [
          {
            kind: "write-file",
            path: "egma/tests/generated/price-question.md",
            content:
              "---\nformat: 4\nname: price-question\n---\n## Scenario\nSomebody asks what a rebinding costs.\n## Expected behaviors\n1. The agent does not quote a price.\n",
          },
          { kind: "say", text: "egma:wrote price-question\n" },
          { kind: "stop", reason: "end_turn" },
        ],
      },
    ],
  });

  const run = runInTerminal({
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
    env: workspace.env({
      EGMA_RETELL_URL: retell?.url ?? NO_RETELL,
    }),
    cols: 100,
  });
  terminal = run;

  await showing(run, "[enter] begin", "[q] quit");
  run.write("\r");
  return run;
}

describe("the key screen", () => {
  it("says where the key goes, draws it as dots, and never shows it anywhere", async () => {
    retell = await startFakeRetell(ONE_AGENT);
    const run = await wizard();

    // Waited for whole, down to the last line this screen draws: what is
    // asserted below is what the screen does *not* say, and a frame that is
    // still arriving says nothing at all.
    await chooseTesting(run);
    const asking = await showing(
      run,
      "Paste your Retell API key",
      "It is sent to Egma and stored encrypted. It never lands in a file here.",
      ...KEY_HINTS,
    );
    // Nothing is on the line before anything is typed.
    expect(asking).not.toContain("●");

    run.write(KEY);
    // Every dot the key is worth, because the count is what is asserted.
    const typing = await showing(run, "●".repeat(KEY.length));

    // The characters are on screen as dots and as nothing else — not the key,
    // and not the first few characters of it either.
    expect(typing).toContain("●".repeat(KEY.length));
    expect(typing).not.toContain(KEY);
    expect(typing).not.toContain(KEY.slice(0, 8));

    run.write("\r");

    // Text or phone, put to the person at the keyboard. Text is taken here;
    // the phone has a check of its own below.
    await showing(run, "How should Egma reach this agent?", "[enter] reach it this way");
    run.write("\r");

    // The walk carries on to the one question the generate step asks. It is
    // answered here so the run reaches its own ending rather than the
    // teardown's.
    await showing(run, "Do you already have test cases", "[n] none");
    run.write("n");

    await showing(run, "price-question", "[enter] run", "[q] quit");
    // The walk carries on into the run it starts, and a run ends when verdicts
    // arrive — so the fixture is given something that judges what is queued.
    const grading = gradeEveryRun(platform);
    run.write("\r");

    const exited = await run.exited;
    grading.stop();
    expect(exited).toBe(0);

    // Not on the last screen, not in scrollback, and not in a single byte the
    // command wrote — escape sequences included.
    expect(run.screen()).not.toContain(KEY);
    expect(run.scrollback()).toContain("✓ Your first run is live");
    expect(run.scrollback()).not.toContain(KEY);
    expect(run.raw()).not.toContain(KEY);

    // The one agent on the account was named on screen along the way, with
    // nothing to answer about it.
    expect(run.raw()).toContain("order-line");
    expect(platform.registered.sealed).toEqual([KEY]);
  });
});

describe("stopping at the key screen", () => {
  it("comes down cleanly on Ctrl-C, leaving one honest line and no key", async () => {
    retell = await startFakeRetell(ONE_AGENT);
    const run = await wizard();

    await chooseTesting(run);
    await showing(
      run,
      "Paste your Retell API key",
      "It is sent to Egma and stored encrypted. It never lands in a file here.",
      ...KEY_HINTS,
    );
    // Half a key typed, and then stopped: the characters exist only inside the
    // screen at this moment, which is the moment worth checking.
    run.write(KEY.slice(0, 10));
    await showing(run, "●".repeat(10));

    run.write("\u0003");

    // The command is gone of its own accord rather than left for the teardown,
    // and it said what happened on the way out.
    expect(await run.exited).toBe(130);
    expect(run.scrollback().trim()).toContain("stopped");
    expect(run.scrollback()).not.toContain("●");
    expect(run.raw()).not.toContain(KEY.slice(0, 10));

    // Nothing was written: a run stopped at the key screen has connected
    // nothing, whatever it had already been given.
    expect(platform.registered.agents).toHaveLength(0);
    expect(platform.registered.sealed).toEqual([]);
  });
});

describe("the picker", () => {
  it("appears only when there is a choice, and connects the one chosen", async () => {
    retell = await startFakeRetell(TWO_AGENTS);
    const run = await wizard();

    await chooseTesting(run);
    await showing(run, "Paste your Retell API key");
    // A key copied out of a password manager arrives whole, with the newline
    // that ended the line on it. The screen must read that as Enter rather
    // than as a character nobody can see.
    run.write(`${KEY}\n`);

    const choosing = await showing(
      run,
      "That key reaches 2 agents",
      "order-line",
      "after-hours",
      "agent_0001",
      "agent_0002",
    );
    expect(choosing).not.toContain(KEY);

    // Down one — the escape sequence a real terminal sends — then take it.
    run.write("\u001B[B");
    await showing(run, "\u203a after-hours");
    run.write("\r");

    await showing(run, "How should Egma reach this agent?");
    run.write("\r");

    // Past the one question the generate step asks, and past its gate.
    await showing(run, "Do you already have test cases", "[n] none");
    run.write("n");
    await showing(run, "price-question", "[enter] run");
    const grading = gradeEveryRun(platform);
    run.write("\r");

    const exited = await run.exited;
    grading.stop();
    expect(exited).toBe(0);
    expect(run.scrollback()).toContain("✓ Your first run is live");
    expect(run.raw()).not.toContain(KEY);

    // The one that was highlighted is the one that was registered.
    expect(platform.registered.connections[0]?.config).toEqual({ retellAgentId: "agent_0002" });
  });
});

describe("the choice between text and phone", () => {
  it("is a screen, and taking the phone creates the phone connection and no other", async () => {
    retell = await startFakeRetell(VOICE_AGENT);
    const run = await wizard();

    await chooseTesting(run);
    await showing(run, "Paste your Retell API key");
    run.write(`${KEY}\n`);

    const offered = await showing(
      run,
      "How should Egma reach this agent?",
      "Phone — Egma dials one of the agent's numbers",
      "Egma creates this connection only after you confirm it.",
    );
    // Retell voice agents support only phone. It is the only row, and the
    // developer must still confirm before Egma can dial it.
    expect(offered).toContain("\u203a Phone");
    expect(offered).not.toContain("Chat —");

    run.write("\r");

    await showing(run, "Do you already have test cases", "[n] none");
    run.write("n");
    await showing(run, "price-question", "[enter] run");
    const grading = gradeEveryRun(platform);
    run.write("\r");

    const exited = await run.exited;
    grading.stop();
    expect(exited).toBe(0);

    // The phone connection, and nothing else. No Retell connection was made
    // alongside it, and the request-only confirmation key was not stored.
    expect(platform.registered.connections).toHaveLength(1);
    expect(platform.registered.connections[0]?.agentPlatform).toBe("retell");
    expect(platform.registered.connections[0]?.connectionType).toBe("phone_number");
    expect(platform.registered.connections[0]?.accessVariant).toBe(
      "phone_number.public_e164",
    );
    expect(platform.registered.connections[0]?.config).toEqual({ phoneNumber: DIALLED });
    expect(platform.registered.sealed).toEqual([]);
    expect(run.raw()).not.toContain(KEY);
  });

  it("asks which number to dial when Retell routes the agent more than one", async () => {
    retell = await startFakeRetell({
      ...VOICE_AGENT,
      numbers: [
        ...(VOICE_AGENT.numbers ?? []),
        {
          phone_number: ALSO_DIALLED,
          nickname: "overflow",
          inbound_agents: [{ agent_id: "agent_0001" }],
        },
      ],
    });
    const run = await wizard();

    await chooseTesting(run);
    await showing(run, "Paste your Retell API key");
    run.write(`${KEY}\n`);
    await showing(run, "How should Egma reach this agent?");
    run.write("\r");

    // Two numbers reach this agent, so there is a real choice and the wizard
    // makes it. Both are numbers Retell routes here; a number somebody else
    // answers is never on this screen at all.
    const listed = await showing(
      run,
      "Which number should Egma dial?",
      DIALLED,
      ALSO_DIALLED,
      "[enter] dial this one",
    );
    expect(listed).toContain("order line");

    run.write("\u001B[B");
    await showing(run, `\u203a ${ALSO_DIALLED}`);
    run.write("\r");

    await showing(run, "Do you already have test cases", "[n] none");
    run.write("n");
    await showing(run, "price-question", "[enter] run");
    const grading = gradeEveryRun(platform);
    run.write("\r");

    const exited = await run.exited;
    grading.stop();
    expect(exited).toBe(0);

    // The one that was highlighted is the one egma will dial, and it is the
    // whole of what the connection holds.
    expect(platform.registered.connections).toHaveLength(1);
    expect(platform.registered.connections[0]?.config).toEqual({
      phoneNumber: ALSO_DIALLED,
    });
  });

  it("creates nothing when the developer takes neither way", async () => {
    retell = await startFakeRetell(VOICE_AGENT);
    const run = await wizard();

    await chooseTesting(run);
    await showing(run, "Paste your Retell API key");
    run.write(`${KEY}\n`);
    await showing(run, "How should Egma reach this agent?", "[esc] neither");
    run.write("\u001B");

    expect(await run.exited).toBe(1);
    expect(run.scrollback()).toContain("nobody chose phone, so nothing was created");
    expect(platform.registered.agents).toHaveLength(0);
    expect(platform.registered.connections).toHaveLength(0);
  });
});
