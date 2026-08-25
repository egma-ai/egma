/**
 * The monitoring and both lanes, through the real wizard flow.
 *
 * No model, no terminal, no human — a scripted coding-agent peer and a fixture
 * platform. There is no fake Retell here on purpose: Egma discovers the Retell
 * account on the server side, so the terminal never speaks to Retell on this
 * path and a check that stood one in would be checking a wire nothing uses.
 *
 * What is asserted is what a developer could check afterwards: which rows the
 * platform holds, where the secret is and everywhere it is not, what `.env`
 * says, what the last line said, and what a shell would see. Never the order of
 * internal steps.
 */

import { execFile } from "node:child_process";
import { readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { walkExitCode } from "../src/wizard/exit-code.ts";
import { ENV_FILE_NAME, writeEnvFile } from "../src/monitoring/env-file.ts";
import { MintedSecret } from "../src/platform/api-keys.ts";
import { HeadlessUI } from "../src/ui/headless-ui.ts";
import { buildExitLine, exitLines } from "../src/wizard/exit-line.ts";
import { selectedPlatform } from "../src/wizard/login-step.ts";
import { runWizard } from "../src/wizard/wizard-flow.ts";
import type { FakeStep } from "./support/fake-agent.ts";
import type { StartRefusalReason } from "./support/fixture-platform/index.ts";
import { startPlatform, type Platform } from "./support/fixture-platform/index.ts";
import { gradeEveryRun } from "./support/grading.ts";
import { startFakeRetell, type FakeRetell, type FakeRetellScript } from "./support/fake-retell.ts";
import { filesUnder, makeWorkspace, MANIFEST, type Workspace } from "./support/workspace.ts";

const run = promisify(execFile);

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

/** Distinctive enough that finding it anywhere is unambiguous. */
const KEY = "key_7f2c9a4e1b6d3058c7e2";
const PLATFORM_AGENT = "agent_0001";
const AGENT_NAME = "order-line";

const LIVEKIT_API_KEY = "APIhx4bmvHnLcWXYZ";
const LIVEKIT_API_SECRET = "livekit-secret-E5F6G7H8QRST";

/** The one fragment that names the monitoring dispatch and nothing else. */
const MONITORING_EDIT_TASK = "send its production evidence to Egma";
/** The one fragment that names the mocked-world dispatch and nothing else. */
const MOCK_AUTHORING_TASK = "run isolated from its real";
const GENERATE_TASK = "## The words the agent is running on";

/**
 * The Retell account behind the wizard's own discovery, for the both lane.
 *
 * The monitoring half never asks Retell anything — Egma does that server-side —
 * but the testing half's connection setup still opens the account directly, so
 * a walk that does both needs one standing there.
 */
const RETELL_ACCOUNT: FakeRetellScript = {
  keys: [KEY],
  agents: [
    {
      agent_id: PLATFORM_AGENT,
      channel: "chat",
      agent_name: AGENT_NAME,
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

/** The worker before Egma touches it: an ordinary LiveKit job entrypoint. */
const WORKER_BEFORE = [
  "from livekit import agents",
  "from livekit.agents import Agent, AgentSession",
  "",
  "",
  "class FrontDesk(Agent):",
  "    pass",
  "",
  "",
  "async def entrypoint(ctx: agents.JobContext) -> None:",
  "    await ctx.connect()",
  "    agent = FrontDesk()",
  "    session = AgentSession()",
  "    await session.start(agent=agent, room=ctx.room)",
  "",
].join("\n");

/** The same file once the coding agent has added the monitoring entry. */
const WORKER_MONITORED = WORKER_BEFORE.replace(
  "async def entrypoint(ctx: agents.JobContext) -> None:\n    await ctx.connect()",
  "async def entrypoint(ctx: agents.JobContext) -> None:\n    monitor_livekit(ctx)\n    await ctx.connect()",
).replace(
  "from livekit import agents",
  "from egma import monitor_livekit\nfrom livekit import agents",
);

let platform: Platform;
let workspace: Workspace;

async function gitRepository(dir: string, ignoring: readonly string[]): Promise<void> {
  await run("git", ["init", "--quiet"], { cwd: dir });
  await writeFile(path.join(dir, ".gitignore"), `${ignoring.join("\n")}\n`, "utf8");
}

beforeEach(async () => {
  platform = await startPlatform();
  workspace = await makeWorkspace({ "package.json": MANIFEST });
  await workspace.signIn(platform.url, platform.device.mint());
  platform.monitoring.account(KEY, [{ id: PLATFORM_AGENT, name: AGENT_NAME }]);
});

afterEach(async () => {
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

function retellDiscovery(): FakeStep[] {
  return [
    { kind: "say", text: "egma:found framework retell-sdk\n" },
    { kind: "say", text: `egma:found agent-name ${AGENT_NAME}\n` },
    { kind: "stop", reason: "end_turn" },
  ];
}

function liveKitDiscovery(): FakeStep[] {
  return [
    { kind: "say", text: "egma:found framework livekit-agents\n" },
    { kind: "say", text: "egma:found agent-name front-desk\n" },
    { kind: "stop", reason: "end_turn" },
  ];
}

/** The coding agent applying the monitoring entry, and naming the agent. */
function appliesMonitorEntry(): FakeStep[] {
  return [
    { kind: "write-file", path: "agent.py", content: WORKER_MONITORED },
    { kind: "say", text: "egma:note Added monitor_livekit(ctx) to agent.py\n" },
    { kind: "say", text: "egma:found monitor-entry agent.py\n" },
    { kind: "say", text: "egma:found agent-name front-desk\n" },
    { kind: "stop", reason: "end_turn" },
  ];
}

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

/**
 * The mocked-world dispatch, answering that it found no worker to wire.
 *
 * This lane is about monitoring and the row it leaves behind; what the testing
 * half's own seam does with a repository it cannot wire has its own checks, and
 * the honest fallback is the shape that keeps this one about one thing.
 */
function writesNoMockedWorld(): FakeStep[] {
  return [
    { kind: "say", text: "egma:none nothing to mock in this worker\n" },
    { kind: "stop", reason: "end_turn" },
  ];
}

/** The LiveKit connection catalog, which the fixture platform does not serve. */
function connectionFetch(): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith("/v1/connection-options")) {
      return new Response(
        JSON.stringify({
          items: [
            {
              agentPlatform: "livekit",
              agentPlatformLabel: "LiveKit Agents",
              connectionType: "livekit_room",
              accessVariant: "livekit_room.project_credentials",
              accessVariantLabel: "Project credentials",
              modality: "voice",
              productLabel: "LiveKit room",
              topology: "hosted-broker",
              simulatorAdapter: true,
              fields: [
                {
                  key: "url",
                  label: "LiveKit server URL",
                  kind: "url",
                  required: true,
                  help: "Your LiveKit Cloud project or self-hosted server.",
                  afterCredentials: false,
                },
              ],
              credentialRule: "required",
              credentialHelp: "Egma seals these and never answers them back.",
              credentialFields: [
                {
                  field: "apiKey",
                  label: "API key",
                  kind: "secret",
                  required: true,
                  help: "The project API key.",
                },
                {
                  field: "apiSecret",
                  label: "API secret",
                  kind: "secret",
                  required: true,
                  help: "The project API secret.",
                },
              ],
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return fetch(input, init);
  }) as typeof fetch;
}

/**
 * Stamp the first agent this project gains as having received a call.
 *
 * The poller is not part of this fixture, so what stands in for a production
 * conversation landing is this: the moment the row exists, it has received.
 */
function productionArrives(): { stop: () => void } {
  const timer = setInterval(() => {
    const agent = platform.registered.agents[0];
    if (agent === undefined) return;
    platform.registered.received(agent.id);
    clearInterval(timer);
  }, 5);
  return { stop: () => clearInterval(timer) };
}

type WalkOptions = {
  readonly goal: "monitoring" | "both";
  readonly steps: readonly FakeStep[];
  readonly stepsByTask?: readonly { contains: string; steps: FakeStep[] }[];
  readonly answers?: Readonly<Record<string, string>>;
  readonly retell?: FakeRetell;
};

async function walk(options: WalkOptions) {
  const script = await workspace.script({
    steps: [...options.steps],
    stepsByTask: [...(options.stepsByTask ?? [])],
  });
  const ui = new HeadlessUI({
    answers: { goal: options.goal, ...options.answers },
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
      ...(options.retell === undefined ? {} : { retell: { url: options.retell.url } }),
      connectionFetchImpl: connectionFetch(),
      home: path.join(workspace.dir, "pretend-home"),
      runPollMs: 20,
      howManyTests: 1,
      // Short enough that a check does not sit in the wait, long enough that a
      // conversation landing during it is really seen.
      monitoringWaitMs: 2_000,
      monitoringPollMs: 10,
    });
    return { report, ui };
  } finally {
    grading.stop();
  }
}

describe("choosing monitoring on Retell", () => {
  /**
   * The whole lane, and the whole of what it must not do. Watching an
   * unregistered platform agent means registering it, so one row appears — and
   * nothing else does, because monitoring is not testing.
   */
  it("registers the agent, seals the key on it, and creates nothing else", async () => {
    const arriving = productionArrives();
    let walked;
    try {
      walked = await walk({
        goal: "monitoring",
        steps: retellDiscovery(),
        answers: { "retell-key": KEY },
      });
    } finally {
      arriving.stop();
    }
    const { report, ui } = walked;

    expect(report).toMatchObject({
      kind: "monitoring-started",
      agentName: AGENT_NAME,
      registered: true,
      arrived: true,
    });
    expect(walkExitCode(report)).toBe(0);

    // One agent row, bound, switched on, holding the key.
    expect(platform.registered.agents).toHaveLength(1);
    expect(platform.registered.agents[0]).toMatchObject({
      name: AGENT_NAME,
      agentPlatform: "retell",
      platformAgentId: PLATFORM_AGENT,
      pullProductionCalls: true,
      monitoringApiKeyHint: KEY.slice(-4),
    });
    expect(platform.monitoring.monitoringKeys).toEqual([KEY]);

    // And nothing that belongs to the testing lane.
    expect(platform.registered.connections).toHaveLength(0);
    expect(platform.registered.sealed).toHaveLength(0);
    expect(platform.suites.suites).toHaveLength(0);
    expect(platform.tests.tests).toHaveLength(0);
    expect(platform.running.runs).toHaveLength(0);

    // One dispatch, and it is the one that finds the agent. The monitoring
    // entry is LiveKit's, and a Retell repository is never asked for it.
    const sent = await dispatched();
    expect(sent).toHaveLength(1);
    expect(sent.some((task) => task.includes(MONITORING_EDIT_TASK))).toBe(false);

    // The committed folder records nothing about monitoring — it records
    // nothing at all, because monitoring writes no folder.
    await expect(
      readFile(path.join(workspace.dir, "egma", "config.yaml"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });

    expect(buildExitLine(report)).toContain("Monitoring page");
    expect(ui.record.asked).not.toContain("reach");
  });

  /**
   * An account with nothing to import is not a failure and must not read as
   * one. Watching is really on; the sentence says what happens next.
   */
  it("ends well with the honest sentence when nothing has arrived", async () => {
    const { report } = await walk({
      goal: "monitoring",
      steps: retellDiscovery(),
      answers: { "retell-key": KEY },
    });

    expect(report).toMatchObject({ kind: "monitoring-started", arrived: false });
    expect(walkExitCode(report)).toBe(0);
    expect(buildExitLine(report)).toContain("Nothing has arrived yet");
    expect(platform.registered.agents[0]?.pullProductionCalls).toBe(true);
  });

  /**
   * Every refusal gets a sentence of Egma's own — what happened and what to do
   * — and the platform's own beside it for whatever is reading. The exit is
   * nonzero: this lane's deliverable is that watching is really on.
   */
  it.each([
    { reason: "contested" as StartRefusalReason, says: "One Egma agent watches one platform agent" },
    { reason: "name_taken" as StartRefusalReason, says: "already has an Egma agent with the name" },
    { reason: "not_found" as StartRefusalReason, says: "no such agent in this project" },
    { reason: "archived" as StartRefusalReason, says: "archived agent watches nothing" },
  ])("explains a $reason refusal in plain words and exits nonzero", async ({ reason, says }) => {
    platform.monitoring.refuseStart(PLATFORM_AGENT, reason);

    const { report } = await walk({
      goal: "monitoring",
      steps: retellDiscovery(),
      answers: { "retell-key": KEY },
    });

    expect(report.kind).toBe("monitoring-refused");
    expect(walkExitCode(report)).toBe(1);
    if (report.kind !== "monitoring-refused") throw new Error("expected a refusal");
    expect(report.lines[0]).toContain(says);
    // The platform's own sentence rides along, whole, for anything scripted.
    expect(report.lines).toHaveLength(2);
    expect(exitLines(report).join("\n")).toContain(report.lines[1] as string);

    // Nothing was left half-done.
    expect(platform.registered.agents).toHaveLength(0);
    expect(platform.running.runs).toHaveLength(0);
  });
});

describe("choosing monitoring on LiveKit", () => {
  beforeEach(async () => {
    await writeFile(path.join(workspace.dir, "agent.py"), WORKER_BEFORE, "utf8");
  });

  /**
   * The gated edit, the minted key, the written file — and no wait, because a
   * pushing worker has nothing to prove until it runs.
   */
  it("wires the worker, mints a project key, and writes exactly two lines", async () => {
    await gitRepository(workspace.dir, [ENV_FILE_NAME]);

    const { report } = await walk({
      goal: "monitoring",
      steps: liveKitDiscovery(),
      stepsByTask: [{ contains: MONITORING_EDIT_TASK, steps: appliesMonitorEntry() }],
    });

    expect(report).toMatchObject({
      kind: "monitoring-wired",
      agentName: "front-desk",
      envFile: ENV_FILE_NAME,
      envRefusal: null,
      wired: true,
    });
    expect(walkExitCode(report)).toBe(0);

    // The agent's row: platform-bound, named by the coding agent, and holding
    // nothing about the key — push is observed, never declared.
    expect(platform.registered.agents).toHaveLength(1);
    expect(platform.registered.agents[0]).toMatchObject({
      name: "front-desk",
      agentPlatform: "livekit",
      platformAgentId: null,
      pullProductionCalls: false,
      monitoringApiKeyHint: null,
    });
    expect(platform.registered.connections).toHaveLength(0);
    expect(platform.tests.tests).toHaveLength(0);
    expect(platform.running.runs).toHaveLength(0);

    // One key, minted for this project and named for the job it does.
    expect(platform.keys.minted).toHaveLength(1);
    const minted = platform.keys.minted[0]!;
    expect(minted.scope).toBe("project");
    expect(minted.name).toContain("front-desk");
    // Never this machine's own credential.
    expect(minted.secret).not.toBe(platform.device.keys[0]);

    // Exactly the two lines, in a file that had none.
    const env = await readFile(path.join(workspace.dir, ENV_FILE_NAME), "utf8");
    expect(env.trimEnd().split("\n")).toEqual([
      `EGMA_URL=${platform.url}`,
      `EGMA_API_KEY=${minted.secret}`,
    ]);

    // And the worker really was edited, which is why the line says so.
    const worker = await readFile(path.join(workspace.dir, "agent.py"), "utf8");
    expect(worker).toContain("monitor_livekit(ctx)");

    // Monitoring wrote no committed folder at all: the platform is the one
    // place the truth about monitoring lives.
    await expect(
      readFile(path.join(workspace.dir, "egma", "config.yaml"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });

    // The coding agent was told, in the dispatch itself, never to touch an
    // environment file — the key is Egma's own code's to write.
    const sent = await dispatched();
    const edit = sent.find((task) => task.includes(MONITORING_EDIT_TASK)) ?? "";
    expect(edit).toContain("Never open, write, or mention a `.env` file");
    expect(edit).not.toContain(minted.secret);

    // The lines survive the screen, one to a line, for the deployment.
    expect(exitLines(report)).toContain(`export EGMA_API_KEY=${minted.secret}`);
    expect(buildExitLine(report)).toContain("Monitoring page");
  });

  /**
   * A key in a committed file is a key in every clone. Egma refuses the write
   * and prints the lines instead, which is what a deployment needed anyway.
   */
  it("refuses the write and prints the lines when Git does not ignore the file", async () => {
    await gitRepository(workspace.dir, ["node_modules"]);

    const { report } = await walk({
      goal: "monitoring",
      steps: liveKitDiscovery(),
      stepsByTask: [{ contains: MONITORING_EDIT_TASK, steps: appliesMonitorEntry() }],
    });

    expect(report).toMatchObject({ kind: "monitoring-wired", envFile: null });
    expect(walkExitCode(report)).toBe(0);
    if (report.kind !== "monitoring-wired") throw new Error("expected a wiring");
    expect(report.envRefusal).toContain("Git does not ignore");

    await expect(
      readFile(path.join(workspace.dir, ENV_FILE_NAME), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });

    const printed = exitLines(report).join("\n");
    expect(printed).toContain("EGMA_URL=");
    expect(printed).toContain("EGMA_API_KEY=");
  });

  /**
   * A coding agent that reports the edit and did not make it is not believed:
   * Egma opens the file and looks. The walk still ends well, with the lines to
   * add by hand and a key minted for when they are.
   */
  it("does not take a reported edit on trust", async () => {
    await gitRepository(workspace.dir, [ENV_FILE_NAME]);

    const { report, ui } = await walk({
      goal: "monitoring",
      steps: liveKitDiscovery(),
      stepsByTask: [
        {
          contains: MONITORING_EDIT_TASK,
          steps: [
            { kind: "say", text: "egma:found monitor-entry agent.py\n" },
            { kind: "say", text: "egma:found agent-name front-desk\n" },
            { kind: "stop", reason: "end_turn" },
          ],
        },
      ],
    });

    expect(report).toMatchObject({ kind: "monitoring-wired", wired: false });
    expect(ui.record.statuses.join("\n")).toContain("found no monitor_livekit()");
    expect(ui.record.statuses.join("\n")).toContain("monitor_livekit(ctx)");
    // The worker is exactly as the developer left it.
    expect(await readFile(path.join(workspace.dir, "agent.py"), "utf8")).toBe(WORKER_BEFORE);
  });
});

describe("choosing both", () => {
  let retell: FakeRetell;

  beforeEach(async () => {
    retell = await startFakeRetell(RETELL_ACCOUNT);
  });

  afterEach(async () => {
    await retell.close();
  });

  /**
   * One sitting, both promises: monitoring first and said out loud, one paste
   * filling both custodies, one agent row through the whole of it, and a last
   * screen that points at the graded run and at Monitoring.
   */
  it("runs monitoring first, pastes once, and keeps one agent row", async () => {
    const { report, ui } = await walk({
      goal: "both",
      steps: retellDiscovery(),
      stepsByTask: [{ contains: GENERATE_TASK, steps: writesOneTest("late-repair") }],
      answers: { "retell-key": KEY, reach: "text" },
      retell,
    });

    expect(report.kind).toBe("run-started");
    expect(walkExitCode(report)).toBe(0);

    // Said before monitoring is set up, and before the testing half starts,
    // because the order is the promise rather than a preference.
    const said = ui.record.statuses.findIndex((line) =>
      line.includes("Setting monitoring up first"),
    );
    const watching = ui.record.statuses.findIndex((line) =>
      line.includes("is watching"),
    );
    expect(said).toBeGreaterThanOrEqual(0);
    expect(said).toBeLessThan(watching);

    // One paste, and one screen that asked for it.
    expect(ui.record.keyAsks).toHaveLength(1);
    expect(ui.record.asked.filter((ask) => ask === "retell-key")).toHaveLength(1);

    // Both custodies hold a sealed copy of the one key.
    expect(platform.monitoring.monitoringKeys).toEqual([KEY]);
    expect(platform.registered.sealed).toEqual([KEY]);

    // One agent row for one voice agent, with the connection on it.
    expect(platform.registered.agents).toHaveLength(1);
    expect(platform.registered.agents[0]).toMatchObject({
      name: AGENT_NAME,
      agentPlatform: "retell",
      pullProductionCalls: true,
    });
    expect(platform.registered.connections).toHaveLength(1);
    expect(platform.registered.connections[0]?.agentId).toBe(
      platform.registered.agents[0]?.id,
    );

    // And the tests really ran.
    expect(platform.tests.tests).toHaveLength(1);
    expect(platform.running.runs).toHaveLength(1);

    // The last screen names both promises.
    const lines = exitLines(report).join("\n");
    expect(lines).toContain("Your first run is live");
    expect(lines).toContain("Monitoring page");
  });

  /**
   * The whole-run sweep, on the lane that handles the key most: it is pasted
   * once, sealed twice, and exists nowhere a person or a program could read it
   * afterwards.
   */
  it("leaves the key in no file, no line and no report", async () => {
    const { report, ui } = await walk({
      goal: "both",
      steps: retellDiscovery(),
      stepsByTask: [{ contains: GENERATE_TASK, steps: writesOneTest("late-repair") }],
      answers: { "retell-key": KEY, reach: "text" },
      retell,
    });

    expect(report.kind).toBe("run-started");
    // The sweep is only worth its name against a run that really used the key.
    expect(platform.monitoring.monitoringKeys).toEqual([KEY]);
    expect(platform.registered.sealed).toEqual([KEY]);

    expect(JSON.stringify(ui.record)).not.toContain(KEY);
    expect(JSON.stringify(report)).not.toContain(KEY);
    expect(exitLines(report).join("\n")).not.toContain(KEY);

    for (const name of await filesUnder(workspace.dir)) {
      const held = await readFile(path.join(workspace.dir, name), "utf8").catch(() => "");
      expect(held, `${name} holds the key`).not.toContain(KEY);
    }

    // Not in the coding agent's own output, which Egma keeps whole, and not in
    // anything Egma sent it. The sweep is only worth its name if it really saw
    // the task that writes the tests: that one carries what the provider is
    // running, which is the one place a key could ride along.
    const logFile = ui.record.drivenAgentLog as string;
    try {
      expect(await readFile(logFile, "utf8").catch(() => "")).not.toContain(KEY);
      const sent = await dispatched();
      expect(sent.some((task) => task.includes(GENERATE_TASK))).toBe(true);
      expect(sent.join("\n")).not.toContain(KEY);
    } finally {
      await rm(logFile, { force: true });
    }

    // At Egma it rides one body per custody, sealed, and no address at all.
    for (const record of platform.records) {
      expect(record.path).not.toContain(KEY);
    }
  });

  /**
   * The same sitting on LiveKit: the worker is wired, the row is created once,
   * and the connection the testing half needs is added to that row rather than
   * to a second one.
   */
  it("wires the worker and reuses its row for the LiveKit connection", async () => {
    await writeFile(path.join(workspace.dir, "agent.py"), WORKER_BEFORE, "utf8");
    await gitRepository(workspace.dir, [ENV_FILE_NAME]);

    const { report, ui } = await walk({
      goal: "both",
      steps: liveKitDiscovery(),
      stepsByTask: [
        { contains: MONITORING_EDIT_TASK, steps: appliesMonitorEntry() },
        { contains: MOCK_AUTHORING_TASK, steps: writesNoMockedWorld() },
        { contains: GENERATE_TASK, steps: writesOneTest("late-repair") },
      ],
      answers: {
        "connection:variant": "livekit_room.project_credentials",
        "connection:config:url": "wss://acme.livekit.cloud",
        "connection:credentials:apiKey": LIVEKIT_API_KEY,
        "connection:credentials:apiSecret": LIVEKIT_API_SECRET,
      },
    });

    expect(report.kind).toBe("run-started");

    // One row, named by the coding agent, bound to LiveKit, with the
    // simulation connection on it.
    expect(platform.registered.agents).toHaveLength(1);
    expect(platform.registered.agents[0]).toMatchObject({
      name: "front-desk",
      agentPlatform: "livekit",
    });
    expect(platform.registered.connections).toHaveLength(1);
    expect(platform.registered.connections[0]?.agentId).toBe(
      platform.registered.agents[0]?.id,
    );

    // The name was settled by the monitoring half, so nobody was asked for it.
    expect(ui.record.connectionAsks.map((ask) => ask.id)).not.toContain(
      "connection:agent-name",
    );

    // The `.env` holds the two lines and the worker holds the entry.
    const env = await readFile(path.join(workspace.dir, ENV_FILE_NAME), "utf8");
    expect(env).toContain("EGMA_API_KEY=");
    expect(await readFile(path.join(workspace.dir, "agent.py"), "utf8")).toContain(
      "monitor_livekit(ctx)",
    );

    expect(exitLines(report).join("\n")).toContain("Monitoring page");
  });
});

describe("the .env writer's own guarantees", () => {
  const values = { url: "https://egma.test", key: new MintedSecret("egma_sk_writer_check") };

  it("refuses a symlinked .env and leaves the link exactly as it was", async () => {
    await gitRepository(workspace.dir, [ENV_FILE_NAME]);
    const elsewhere = path.join(workspace.dir, "elsewhere.txt");
    await writeFile(elsewhere, "not an env file\n", "utf8");
    await symlink("elsewhere.txt", path.join(workspace.dir, ENV_FILE_NAME));

    const wrote = await writeEnvFile(workspace.dir, values);

    expect(wrote.kind).toBe("refused");
    if (wrote.kind === "refused") expect(wrote.reason).toContain("symbolic link");
    // The link still points where the developer pointed it, and its target is
    // untouched — the key went nowhere.
    expect(await readFile(path.join(workspace.dir, ENV_FILE_NAME), "utf8")).toBe(
      "not an env file\n",
    );
    expect(await readFile(elsewhere, "utf8")).not.toContain("egma_sk_writer_check");
  });

  it("replaces an existing .env in one motion, keeps its other lines, and lands it private", async () => {
    await gitRepository(workspace.dir, [ENV_FILE_NAME]);
    const file = path.join(workspace.dir, ENV_FILE_NAME);
    await writeFile(file, "OTHER=kept\nEGMA_API_KEY=old\n", { encoding: "utf8", mode: 0o644 });

    const wrote = await writeEnvFile(workspace.dir, values);

    expect(wrote).toEqual({ kind: "written", file: ENV_FILE_NAME, replaced: true });
    const held = await readFile(file, "utf8");
    expect(held).toContain("OTHER=kept");
    expect(held).toContain("EGMA_API_KEY=egma_sk_writer_check");
    expect(held).not.toContain("EGMA_API_KEY=old");
    // A live key was just written into it, so whatever mode the old file had,
    // the one standing now is the developer's alone.
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    // The one-motion swap leaves no staging file behind.
    const around = await filesUnder(workspace.dir);
    expect(around.filter((one) => one.includes(".egma-"))).toEqual([]);
  });
});
