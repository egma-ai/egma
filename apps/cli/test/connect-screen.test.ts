/**
 * The connect step as a developer meets it, on a real terminal.
 *
 * A pseudo-terminal runs the built command and a headless terminal emulator
 * reads its screen and everything it wrote. That is the only way to check the
 * two promises this step makes to a person rather than to a machine: that the
 * key is drawn as dots while it is typed, and that one agent on the account
 * costs no keystrokes while several get a list to choose from.
 *
 * The key typed here is invented and reaches a fake Retell on this machine.
 */

import process from "node:process";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { startFakeRetell, type FakeRetell, type FakeRetellScript } from "./support/fake-retell.ts";
import { startPlatform, type Platform } from "./support/fixture-platform/index.ts";
import { runInTerminal, type TerminalRun } from "./support/pty.ts";
import { CLI_ENTRY, FAKE_AGENT, MANIFEST, makeWorkspace, type Workspace } from "./support/workspace.ts";

// A real subprocess, a real terminal and a test run using every core: the
// budget is generous so that only a broken wizard can reach it.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const KEY = "key_h4j7d2s9f5g8k1l3m6n0";

const ONE_AGENT: FakeRetellScript = {
  keys: [KEY],
  agents: [
    {
      agent_id: "agent_0001",
      agent_name: "order-line",
      response_engine: { type: "retell-llm", llm_id: "llm_0001" },
    },
  ],
  llms: [{ llm_id: "llm_0001", general_prompt: "You answer the order line.\n" }],
};

const TWO_AGENTS: FakeRetellScript = {
  keys: [KEY],
  agents: [
    { agent_id: "agent_0001", agent_name: "order-line", response_engine: { type: "retell-llm", llm_id: "llm_0001" } },
    { agent_id: "agent_0002", agent_name: "after-hours", response_engine: { type: "retell-llm", llm_id: "llm_0001" } },
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
  terminal?.kill();
  terminal = undefined;
  await retell?.close();
  retell = undefined;
  await platform.close();
  await workspace.remove();
});

/** Waits until the screen holds every one of these, and answers that screen. */
async function showing(run: TerminalRun, ...parts: readonly string[]): Promise<string> {
  let held = "";
  const shown = await run.waitFor(() => {
    const screen = run.screen();
    if (!parts.every((part) => screen.includes(part))) return false;
    held = screen;
    return true;
  });
  if (!shown) {
    throw new Error(
      `the terminal never showed all of: ${parts.join(" | ")}\n\nlast screen:\n${run.screen()}`,
    );
  }
  return held;
}

/** The wizard, past the intro, with a scripted coding agent that finds one fact. */
async function wizard(): Promise<TerminalRun> {
  const script = await workspace.script({
    steps: [
      { kind: "say", text: "egma:found framework retell-sdk\n" },
      { kind: "stop", reason: "end_turn" },
    ],
  });

  const run = runInTerminal({
    command: process.execPath,
    args: [
      CLI_ENTRY,
      "--cwd",
      workspace.dir,
      "--",
      process.execPath,
      FAKE_AGENT,
      script,
    ],
    cwd: workspace.dir,
    env: workspace.env({
      EGMA_URL: platform.url,
      EGMA_RETELL_URL: retell?.url ?? "http://127.0.0.1:1",
    }),
    cols: 100,
  });
  terminal = run;

  await showing(run, "[enter] begin");
  run.write("\r");
  return run;
}

describe("the key screen", () => {
  it("says where the key goes, draws it as dots, and never shows it anywhere", async () => {
    retell = await startFakeRetell(ONE_AGENT);
    const run = await wizard();

    const asking = await showing(
      run,
      "Paste your Retell API key",
      "It is sent to egma and stored encrypted. It never lands in a file here.",
    );
    // Nothing is on the line before anything is typed.
    expect(asking).not.toContain("●");

    run.write(KEY);
    const typing = await showing(run, "●●●●●●●●●●");

    // The characters are on screen as dots and as nothing else — not the key,
    // and not the first few characters of it either.
    expect(typing).toContain("●".repeat(KEY.length));
    expect(typing).not.toContain(KEY);
    expect(typing).not.toContain(KEY.slice(0, 8));

    run.write("\r");
    await showing(run, "order-line");

    const exited = await run.exited;
    expect(exited).toBe(0);

    // Not on the last screen, not in scrollback, and not in a single byte the
    // command wrote — escape sequences included.
    expect(run.screen()).not.toContain(KEY);
    expect(run.scrollback()).toContain("egma connected your voice agent: order-line, over retell-1.");
    expect(run.scrollback()).not.toContain(KEY);
    expect(run.raw()).not.toContain(KEY);

    expect(platform.registered.sealed).toEqual([KEY]);
  });
});

describe("the picker", () => {
  it("appears only when there is a choice, and connects the one chosen", async () => {
    retell = await startFakeRetell(TWO_AGENTS);
    const run = await wizard();

    await showing(run, "Paste your Retell API key");
    // A key copied out of a password manager arrives whole, with the newline
    // that ended the line on it. The screen must read that as Enter rather
    // than as a character nobody can see.
    run.write(`${KEY}\n`);

    const choosing = await showing(run, "That key reaches 2 agents", "order-line", "after-hours");
    expect(choosing).toContain("agent_0001");
    expect(choosing).toContain("agent_0002");
    expect(choosing).not.toContain(KEY);

    // Down one — the escape sequence a real terminal sends — then take it.
    run.write("\u001B[B");
    await showing(run, "\u203a after-hours");
    run.write("\r");

    const exited = await run.exited;
    expect(exited).toBe(0);
    expect(run.scrollback()).toContain(
      "egma connected your voice agent: after-hours, over retell-1.",
    );
    expect(run.raw()).not.toContain(KEY);

    // The one that was highlighted is the one that was registered.
    expect(platform.registered.connections[0]?.config).toEqual({ retellAgentId: "agent_0002" });
  });
});
