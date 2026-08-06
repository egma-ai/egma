/**
 * The walk, end to end, with a scripted agent and nobody watching.
 *
 * No model, no terminal, no human — and no assertion about the order egma does
 * things in. What is checked is what a developer could check afterwards: which
 * files landed, what they say, and the line left behind.
 */

import { readFile, rm } from "node:fs/promises";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { HeadlessUI } from "../src/ui/headless-ui.ts";
import { buildExitLine } from "../src/wizard/exit-line.ts";
import { walk } from "../src/wizard/walk.ts";
import {
  MANIFEST,
  isAlive,
  makeWorkspace,
  waitUntil,
  type Workspace,
} from "./support/workspace.ts";

type Report = {
  protocolVersion: number | null;
  clientCapabilities: { fs?: { readTextFile?: boolean; writeTextFile?: boolean } } | null;
  modeSetTo: string | null;
  observations: Record<string, unknown>;
  childPid: number | null;
};

async function reportIn(workspace: Workspace): Promise<Report> {
  return JSON.parse(
    await readFile(path.join(workspace.dir, "fake-agent-report.json"), "utf8"),
  ) as Report;
}

async function exists(file: string): Promise<boolean> {
  try {
    await readFile(file, "utf8");
    return true;
  } catch {
    return false;
  }
}

describe("one task, driven on a scripted agent", () => {
  let workspace: Workspace;

  beforeEach(async () => {
    workspace = await makeWorkspace({ "package.json": MANIFEST, ".env": "SECRET=shhh\n" });
  });

  afterEach(async () => {
    await workspace.remove();
  });

  it("negotiates, sets the mode that stops questions, works, and leaves one line", async () => {
    const script = await workspace.script({
      steps: [
        { kind: "say", text: "Let me look at that file." },
        {
          kind: "tool-call",
          id: "t1",
          title: "Read",
          toolKind: "read",
          locations: [{ path: "package.json" }],
        },
        { kind: "read-file", path: "package.json", recordAs: "manifest" },
        { kind: "tool-call-update", id: "t1", status: "completed" },
        { kind: "write-file", path: "notes.txt", content: "a package manifest\n" },
        { kind: "say", text: "It is a package manifest." },
        { kind: "stop", reason: "end_turn" },
      ],
    });

    const ui = new HeadlessUI();
    const report = await walk({
      ui,
      launch: workspace.launch(script),
      cwd: workspace.dir,
      signal: new AbortController().signal,
    });

    expect(report).toEqual({
      kind: "task-done",
      drivenAgentName: "Fake Agent",
      file: "package.json",
    });
    expect(buildExitLine(report)).toBe(
      "Fake Agent read package.json for egma. Nothing in this folder was changed.",
    );

    // The file the agent was told to write is the one that landed.
    expect(await readFile(path.join(workspace.dir, "notes.txt"), "utf8")).toBe(
      "a package manifest\n",
    );

    const observed = await reportIn(workspace);
    expect(observed.protocolVersion).toBeGreaterThan(0);
    expect(observed.modeSetTo).toBe("bypassPermissions");
    expect(observed.clientCapabilities?.fs).toEqual({ readTextFile: true, writeTextFile: true });
    expect(observed.observations["manifest"]).toEqual({ read: MANIFEST.length });

    // Every action the agent took was shown, and its own words were kept.
    expect(ui.record.statuses).toContain("◆ Read package.json");
    expect(ui.record.summary).toContain("It is a package manifest.");
  });

  it("approves what the agent asks for, so the developer is never interrupted", async () => {
    const script = await workspace.script({
      steps: [
        {
          kind: "ask-permission",
          id: "t1",
          title: "Read the manifest",
          locations: [{ path: "package.json" }],
          recordAs: "manifestPermission",
        },
        { kind: "stop", reason: "end_turn" },
      ],
    });

    await walk({
      ui: new HeadlessUI(),
      launch: workspace.launch(script),
      cwd: workspace.dir,
      signal: new AbortController().signal,
    });

    expect((await reportIn(workspace)).observations["manifestPermission"]).toBe("allow");
  });

  it("refuses a .env file both ways round, and sends the agent elsewhere", async () => {
    const script = await workspace.script({
      steps: [
        {
          kind: "ask-permission",
          id: "t1",
          title: "Read the environment file",
          locations: [{ path: ".env" }],
          recordAs: "envPermission",
        },
        { kind: "read-file", path: ".env", recordAs: "envRead" },
        { kind: "write-file", path: ".env.local", content: "SECRET=leaked\n", recordAs: "envWrite" },
        { kind: "read-file", path: "package.json", recordAs: "manifest" },
        { kind: "stop", reason: "end_turn" },
      ],
    });

    const ui = new HeadlessUI();
    await walk({
      ui,
      launch: workspace.launch(script),
      cwd: workspace.dir,
      signal: new AbortController().signal,
    });

    const observed = await reportIn(workspace);
    expect(observed.observations["envPermission"]).toBe("reject");
    expect(JSON.stringify(observed.observations["envRead"])).toContain(
      "keeps .env files away",
    );
    expect(JSON.stringify(observed.observations["envWrite"])).toContain(
      "keeps .env files away",
    );

    // The refusal is not a blanket stop: the file that is not fenced still read.
    expect(observed.observations["manifest"]).toEqual({ read: MANIFEST.length });

    // Nothing was written where the fence stands.
    expect(await exists(path.join(workspace.dir, ".env.local"))).toBe(false);
    expect(await readFile(path.join(workspace.dir, ".env"), "utf8")).toBe("SECRET=shhh\n");

    // And the developer saw it happen.
    expect(ui.record.statuses.filter((line) => line.includes("fenced off")).length).toBe(3);
  });

  it("refuses a shell command that reaches for .env, which names no path at all", async () => {
    const script = await workspace.script({
      steps: [
        {
          kind: "ask-permission",
          id: "t1",
          title: "Run a command",
          toolKind: "execute",
          rawInput: { command: "cat .env" },
          recordAs: "catEnv",
        },
        {
          kind: "ask-permission",
          id: "t2",
          title: "Run a command",
          toolKind: "execute",
          rawInput: { command: "grep KEY .env.local" },
          recordAs: "grepEnv",
        },
        {
          kind: "ask-permission",
          id: "t3",
          title: "Run a command",
          toolKind: "execute",
          rawInput: { command: "grep", args: ["-n", "KEY", ".env.production"] },
          recordAs: "argsEnv",
        },
        {
          kind: "ask-permission",
          id: "t4",
          title: "Run a command",
          toolKind: "execute",
          rawInput: { tool: { input: { terminal: { command: "head -n 1 /tmp/repo/.env" } } } },
          recordAs: "nestedEnv",
        },
        {
          kind: "ask-permission",
          id: "t5",
          title: "Run a command",
          toolKind: "execute",
          rawInput: { command: "node -e 'console.log(process.env.PORT)'" },
          recordAs: "harmless",
        },
        { kind: "stop", reason: "end_turn" },
      ],
    });

    const ui = new HeadlessUI();
    await walk({
      ui,
      launch: workspace.launch(script),
      cwd: workspace.dir,
      signal: new AbortController().signal,
    });

    const observed = await reportIn(workspace);
    expect(observed.observations["catEnv"]).toBe("reject");
    expect(observed.observations["grepEnv"]).toBe("reject");
    expect(observed.observations["argsEnv"]).toBe("reject");
    expect(observed.observations["nestedEnv"]).toBe("reject");

    // The fence stops at the fence: a command that only mentions the word runs.
    expect(observed.observations["harmless"]).toBe("allow");

    // The developer was told which file each refusal was about.
    expect(ui.record.statuses).toContain(
      "Refused: .env is fenced off from your coding agent. It was told to look elsewhere.",
    );
    expect(ui.record.statuses.filter((line) => line.includes("fenced off")).length).toBe(4);
  });

  it("keeps the agent's own output in a file, rather than dropping it", async () => {
    const script = await workspace.script({
      steps: [
        { kind: "grumble", text: "warning: the adapter is talking to itself" },
        { kind: "say", text: "It is a package manifest." },
        { kind: "grumble", text: "warning: and again on the way out" },
        { kind: "stop", reason: "end_turn" },
      ],
    });

    const ui = new HeadlessUI();
    await walk({
      ui,
      launch: workspace.launch(script),
      cwd: workspace.dir,
      signal: new AbortController().signal,
    });

    const logFile = ui.record.drivenAgentLog;
    expect(logFile).not.toBeNull();

    const kept = async (): Promise<string> => {
      try {
        return await readFile(logFile as string, "utf8");
      } catch {
        return "";
      }
    };

    try {
      // The last chunk can still be in flight when the walk returns.
      expect(await waitUntil(async () => (await kept()).includes("on the way out"))).toBe(true);
      expect(await kept()).toContain("warning: the adapter is talking to itself");
    } finally {
      await rm(logFile as string, { force: true });
    }
  });

  it("stops cleanly part way through, leaving no agent behind", async () => {
    const script = await workspace.script({
      spawnChild: true,
      steps: [
        { kind: "tool-call", id: "t1", title: "Thinking about it" },
        { kind: "wait", ms: 60_000 },
        { kind: "stop", reason: "end_turn" },
      ],
    });

    const ui = new HeadlessUI();
    const controller = new AbortController();
    const running = walk({
      ui,
      launch: workspace.launch(script),
      cwd: workspace.dir,
      signal: controller.signal,
    });

    // Wait until the agent is really working before changing our mind.
    expect(
      await waitUntil(() => ui.record.statuses.some((line) => line.includes("Thinking about it"))),
    ).toBe(true);

    const childPid = (await reportIn(workspace)).childPid;
    expect(childPid).not.toBeNull();
    expect(isAlive(childPid as number)).toBe(true);

    controller.abort("interrupt");
    const report = await running;

    expect(report).toEqual({ kind: "interrupted", drivenAgentName: "Fake Agent" });
    expect(buildExitLine(report)).toBe(
      "egma stopped before the task finished, and shut Fake Agent down.",
    );

    // The agent started a process of its own; ending the agent ended that too.
    expect(await waitUntil(() => !isAlive(childPid as number))).toBe(true);
  });
});
