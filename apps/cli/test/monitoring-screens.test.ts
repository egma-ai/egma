/**
 * The monitoring lane on a real terminal.
 *
 * Everything else about this lane is checked with nobody watching, which is the
 * right place for what it creates and where the key goes. What that cannot
 * check is the half a developer actually meets: that the screens are reachable,
 * that the keys on them do what the hint bar says, and that the line the wizard
 * leaves behind survives the alternate screen it drew on.
 *
 * So a pseudo-terminal runs the built command and a headless terminal emulator
 * reads its screen. There is no fake Retell here: Egma opens the account on the
 * server side, and the fixture platform is where that account lives.
 */

import process from "node:process";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MONITORING_CUSTODY_LINE } from "../src/monitoring/retell-lane.ts";
import { startPlatform, type Platform } from "./support/fixture-platform/index.ts";
import { runInTerminal, showing, showingIn, type TerminalRun } from "./support/pty.ts";
import { GOAL_ASK_LINE } from "../src/ui/wizard-ui.ts";
import {
  CLI_ENTRY,
  FAKE_AGENT,
  MANIFEST,
  makeWorkspace,
  type Workspace,
} from "./support/workspace.ts";

// A real subprocess, a real terminal and a fixture platform, inside a run using
// every core: the budget is generous so that only a broken wizard reaches it.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const KEY = "key_5d1f8b3c6a2e9074f1d5";

let platform: Platform;
let workspace: Workspace;
let terminal: TerminalRun | undefined;

beforeEach(async () => {
  platform = await startPlatform();
  workspace = await makeWorkspace({ "package.json": MANIFEST });
  await workspace.signIn(platform.url, platform.device.mint());
  // Two agents, so the picker is a real choice and the screen is reached.
  platform.monitoring.account(KEY, [
    { id: "agent_0001", name: "after-hours" },
    { id: "agent_0002", name: "order-line" },
  ]);
});

afterEach(async () => {
  // Waited for: the command is still writing its log into the folder that is
  // about to be removed.
  await terminal?.kill();
  terminal = undefined;
  await platform.close();
  await workspace.remove();
});

async function walkToTheGoal(): Promise<TerminalRun> {
  const script = await workspace.script({
    steps: [
      { kind: "say", text: "egma:found framework retell-sdk\n" },
      { kind: "say", text: "egma:found agent-name order-line\n" },
      { kind: "stop", reason: "end_turn" },
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
    env: workspace.env(),
    cols: 100,
  });
  terminal = run;

  await showing(run, "Welcome to Egma", "[enter] continue", "[q] quit");
  run.write("\r");
  await showing(run, "[enter] begin", "[q] quit");
  run.write("\r");
  return run;
}

function asOneLine(screen: string): string {
  return screen
    .split("\n")
    .map((line) => line.replaceAll("│", "").trim())
    .join(" ")
    .replaceAll(/\s+/gu, " ");
}

describe("watching production traffic, on a real terminal", () => {
  /**
   * The whole lane as a person meets it: the question, the key box, the picker
   * that says what Egma already knows about each agent, and the line left in
   * scrollback afterwards.
   */
  it("asks the question, takes the key, offers the account, and leaves one line", async () => {
    const run = await walkToTheGoal();

    const defaultGoal = await showing(run, GOAL_ASK_LINE, "› Test it");
    expect(defaultGoal).not.toContain("[m]");
    run.write("\u001b[B");
    await showing(run, "› Watch its production traffic");
    run.write("\u001b[B");
    await showing(run, "› Both");
    run.write("\u001b[A");
    await showing(run, "› Watch its production traffic");
    run.write("\r");

    // The key box is drawn in this phase too, with the custody line under it —
    // said at the moment the developer decides whether to hand the key over.
    await showingIn(
      run,
      asOneLine,
      "Paste your Retell API key",
      MONITORING_CUSTODY_LINE,
    );
    run.write(`${KEY}\r`);

    // The picker, and what makes it a picker: what Egma already knows about
    // each of the account's agents.
    await showing(
      run,
      "Which one should Egma watch?",
      "after-hours",
      "order-line",
      "new to Egma",
      "[enter] watch this one",
    );
    run.write("[B");
    await showing(run, "› order-line");

    /*
     * A production conversation, arriving while Egma waits.
     *
     * The poller is not part of this fixture, so what stands in for one is
     * this: the moment the agent row exists, it has received. It is also what
     * ends the wait — which is the whole reason the wizard waits at all, and
     * the reason this walk finishes in a second rather than in the twenty the
     * honest empty case is given.
     */
    const arriving = setInterval(() => {
      const agent = platform.registered.agents[0];
      if (agent === undefined) return;
      platform.registered.received(agent.id);
      clearInterval(arriving);
    }, 5);

    run.write("\r");

    try {
      expect(await run.exited).toBe(0);
    } finally {
      clearInterval(arriving);
    }

    // What survives the alternate screen: one line, saying what is now true and
    // where to read it.
    const kept = run.scrollback();
    expect(kept).toContain("Egma is watching order-line's production calls");
    expect(kept).toContain("first conversation has already arrived");
    expect(kept).toContain("Monitoring page");

    // And the agent it picked is the one now watching, registered by the same
    // commit that started it.
    expect(platform.registered.agents).toHaveLength(1);
    expect(platform.registered.agents[0]).toMatchObject({
      name: "order-line",
      agentPlatform: "retell",
      platformAgentId: "agent_0002",
      pullProductionCalls: true,
    });

    // Nothing that belongs to the testing lane, and no committed folder.
    expect(platform.registered.connections).toHaveLength(0);
    expect(platform.running.runs).toHaveLength(0);
    // The key was typed on this screen and is nowhere on what was drawn on it.
    expect(run.raw()).not.toContain(KEY);
  });
});
