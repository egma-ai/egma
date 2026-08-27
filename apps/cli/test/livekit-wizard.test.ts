/** LiveKit through the real wizard flow, from repository discovery to a run. */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  connectLiveKit,
  liveKitKeyPair,
  LIVEKIT_KEY_PAIR_VARIANT,
  LIVEKIT_TOKEN_ENDPOINT_VARIANT,
} from "../src/livekit/connect.ts";
import type { StartLocalLiveKitWorker } from "../src/livekit/local-worker.ts";
import { HeadlessUI } from "../src/ui/headless-ui.ts";
import type { AskId } from "../src/ui/wizard-ui.ts";
import { liveKitConnectionSetupStep } from "../src/wizard/livekit-connection-setup-step.ts";
import { selectedPlatform } from "../src/wizard/login-step.ts";
import { runWizard } from "../src/wizard/wizard-flow.ts";
import { workerEntryInstructions } from "../src/wizard/worker-integration-step.ts";
import type { FakeStep } from "./support/fake-agent.ts";
import { startPlatform, type Platform } from "./support/fixture-platform/index.ts";
import { gradeEveryRun } from "./support/grading.ts";
import { runInTerminal } from "./support/pty.ts";
import {
  CLI_ENTRY,
  FAKE_AGENT,
  makeWorkspace,
  type Workspace,
} from "./support/workspace.ts";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const API_KEY = "APIhx4bmvHnLcWXYZ";
const API_SECRET = "livekit-secret-E5F6G7H8QRST";
const HEADERS = '{"Authorization":"Bearer private-token"}';

const localWorkerRuns: Array<{
  readonly url: string;
  readonly dispatchName: string;
  readonly entrypoint: string;
  readonly dependencyManifest: string;
  stopped: boolean;
}> = [];

const startFakeLocalWorker: StartLocalLiveKitWorker = async (options) => {
  const recorded = {
    url: options.url,
    dispatchName: options.dispatchName,
    entrypoint: options.entrypoint,
    dependencyManifest: options.dependencyManifest,
    stopped: false,
  };
  localWorkerRuns.push(recorded);
  let finish!: () => void;
  const ended = new Promise<{ readonly kind: "stopped" }>((resolve) => {
    finish = () => resolve({ kind: "stopped" });
  });
  return {
    kind: "started",
    worker: {
      ended,
      stop: async () => {
        recorded.stopped = true;
        finish();
      },
    },
  };
};

/**
 * The customer's worker before Egma touches it: an ordinary LiveKit job
 * entrypoint with one tool and no Egma anywhere in it.
 */
const WORKER_BEFORE = [
  "from livekit import agents",
  "from livekit.agents import Agent, AgentSession, function_tool",
  "",
  "",
  "class FrontDesk(Agent):",
  "    @function_tool",
  "    async def check_availability(self, day: str) -> str:",
  '        """Look up the free slots on one day."""',
  '        return "nothing free"',
  "",
  "",
  "async def entrypoint(ctx: agents.JobContext) -> None:",
  "    await ctx.connect()",
  "    agent = FrontDesk()",
  "    session = AgentSession()",
  "    await session.start(agent=agent, room=ctx.room)",
  "",
].join("\n");

/** The same file after the coding agent has applied the testing entry. */
const WORKER_AFTER = WORKER_BEFORE.replace(
  "    await session.start(agent=agent, room=ctx.room)",
  [
    "    await mockable(agent, ctx, session)",
    "    await session.start(agent=agent, room=ctx.room)",
  ].join("\n"),
).replace("from livekit import agents", "from egma import mockable\nfrom livekit import agents");

/** A worker that already sends monitoring evidence before Testing is chosen. */
const WORKER_MONITORED_BEFORE = WORKER_BEFORE.replace(
  "async def entrypoint(ctx: agents.JobContext) -> None:\n    await ctx.connect()",
  "async def entrypoint(ctx: agents.JobContext) -> None:\n    monitor_livekit(ctx)\n    await ctx.connect()",
).replace(
  "from livekit import agents",
  "from egma import monitor_livekit\nfrom livekit import agents",
);

/** Testing added without deleting a pre-existing monitoring hook or adding connect. */
const WORKER_TESTING_PRESERVES_MONITORING = WORKER_AFTER.replace(
  "from egma import mockable",
  "from egma import mockable, monitor_livekit",
).replace(
  "async def entrypoint(ctx: agents.JobContext) -> None:\n    await ctx.connect()",
  "async def entrypoint(ctx: agents.JobContext) -> None:\n    monitor_livekit(ctx)",
);

/** The project's mocked world, as the driven agent would write the file. */
const MOCK_TOOLS_FILE = [
  "# The mock tools this project answers with",
  "",
  "## Mock tools",
  "### check_availability",
  "```json",
  '{ "answer": { "slots": ["Wednesday 15:00"] } }',
  "```",
  "",
].join("\n");

/** The one task that owns the worker and dependency manifest. */
const WORKER_INTEGRATION_TASK = "Reconcile this LiveKit worker with Egma";
/** The one fragment that names the mock-authoring task and nothing else. */
const MOCK_AUTHORING_TASK = "Write the mocked world for";
const REQUIREMENTS_BEFORE = "livekit-agents\n";
const REQUIREMENTS_WITH_EGMA = `${REQUIREMENTS_BEFORE}egma>=0.1.0\n`;

/**
 * A scripted agent that reports the edit and does not make it.
 *
 * The path it names is real and the file is really there — it is the worker
 * this workspace was given — so nothing but reading the file can tell this
 * apart from the honest case.
 */
function claimsWithoutEditing(): FakeStep[] {
  return [
    { kind: "say", text: "egma:found worker-entry agent.py\n" },
    { kind: "say", text: "egma:found agent-name front-desk\n" },
    { kind: "stop", reason: "end_turn" },
  ];
}

/**
 * The awaited call, exactly as the skill publishes it.
 *
 * Held in one constant because every shape below writes these same words: what
 * separates them is only whether the file makes them run.
 */
const CALL = "await mockable(agent, ctx, session)";

/** The worker with `lines` put in above where the session starts. */
function workerWith(...lines: readonly string[]): string {
  return WORKER_BEFORE.replace(
    "    await session.start(agent=agent, room=ctx.room)",
    [...lines, "    await session.start(agent=agent, room=ctx.room)"].join("\n"),
  );
}

/**
 * The four ways the words end up in the file without the call ever running.
 *
 * Every one of them really changes the file and really holds the exact line the
 * skill teaches, which is what makes them the shapes a check on the text alone
 * would wave through — and it is exactly the shape a model reaches for when it
 * has been asked to add one line and is explaining itself while it does.
 */
const MENTIONED_NOT_CALLED = [
  { what: "a whole-line comment", lines: [`    # ${CALL}`] },
  { what: "a docstring", lines: ["    \"\"\"Egma is wired below:", `    ${CALL}`, '    """'] },
  { what: "a string literal", lines: [`    _wired = "${CALL}"`] },
  { what: "an inline trailing comment", lines: [`    agent = agent  # ${CALL}`] },
] as const;

/** A scripted agent that writes one of those and reports the edit anyway. */
function claimsAMentionOnly(lines: readonly string[]): FakeStep[] {
  return [
    { kind: "write-file", path: "agent.py", content: workerWith(...lines) },
    { kind: "say", text: "egma:found worker-entry agent.py\n" },
    { kind: "say", text: "egma:found agent-name front-desk\n" },
    { kind: "stop", reason: "end_turn" },
  ];
}

/**
 * The control: a worker that explains itself in a docstring *and* runs the
 * call.
 *
 * Refusing this would be the check overshooting — the mention is how people
 * write code, and the line underneath it is a real edit.
 */
function claimsARealCallBesideAMention(): FakeStep[] {
  const wired = workerWith(
    '    """Egma answers this agent\'s tools from here:',
    `    ${CALL}`,
    '    """',
    `    ${CALL}`,
  ).replace("from livekit import agents", "from egma import mockable\nfrom livekit import agents");
  return [
    { kind: "write-file", path: "agent.py", content: wired },
    {
      kind: "write-file",
      path: "requirements.txt",
      content: REQUIREMENTS_WITH_EGMA,
    },
    { kind: "say", text: "egma:found worker-entry agent.py\n" },
    { kind: "say", text: "egma:found dependency-manifest requirements.txt\n" },
    { kind: "say", text: "egma:found agent-name front-desk\n" },
    { kind: "stop", reason: "end_turn" },
  ];
}

/** A scripted agent that names a file outside the repository altogether. */
function claimsAPathOutsideTheRepository(): FakeStep[] {
  return [
    { kind: "say", text: "egma:found worker-entry ../../etc/passwd\n" },
    { kind: "say", text: "egma:found agent-name front-desk\n" },
    { kind: "stop", reason: "end_turn" },
  ];
}

/** What the scripted agent does when it cannot identify one job entrypoint. */
function cannotFindTheWorker(): FakeStep[] {
  return [
    { kind: "say", text: "egma:none Two workers define an entrypoint and neither is obviously the one.\n" },
    { kind: "stop", reason: "end_turn" },
  ];
}

/** What the scripted agent does when Egma sends the worker-integration task. */
function integrationSteps(): FakeStep[] {
  return [
    { kind: "write-file", path: "agent.py", content: WORKER_AFTER },
    {
      kind: "write-file",
      path: "requirements.txt",
      content: REQUIREMENTS_WITH_EGMA,
    },
    { kind: "say", text: "egma:found worker-entry agent.py\n" },
    { kind: "say", text: "egma:found dependency-manifest requirements.txt\n" },
    { kind: "say", text: "egma:found agent-name front-desk\n" },
    { kind: "stop", reason: "end_turn" },
  ];
}

function integrationPreservingMonitoringWithoutConnect(): FakeStep[] {
  return [
    {
      kind: "write-file",
      path: "agent.py",
      content: WORKER_TESTING_PRESERVES_MONITORING,
    },
    {
      kind: "write-file",
      path: "requirements.txt",
      content: REQUIREMENTS_WITH_EGMA,
    },
    { kind: "say", text: "egma:found worker-entry agent.py\n" },
    { kind: "say", text: "egma:found dependency-manifest requirements.txt\n" },
    { kind: "say", text: "egma:found agent-name front-desk\n" },
    { kind: "stop", reason: "end_turn" },
  ];
}

function integrationWithoutEgmaDependency(): FakeStep[] {
  return [
    { kind: "write-file", path: "agent.py", content: WORKER_AFTER },
    { kind: "say", text: "egma:found worker-entry agent.py\n" },
    { kind: "say", text: "egma:found dependency-manifest requirements.txt\n" },
    { kind: "say", text: "egma:found agent-name front-desk\n" },
    { kind: "stop", reason: "end_turn" },
  ];
}

function integrationWithoutDependencyReport(): FakeStep[] {
  return integrationSteps().filter(
    (step) => !(step.kind === "say" && step.text.includes("dependency-manifest")),
  );
}

function laterRemovesMonitoring(): FakeStep[] {
  return [
    { kind: "write-file", path: "agent.py", content: WORKER_AFTER },
    { kind: "stop", reason: "end_turn" },
  ];
}

function laterRemovesEgmaDependency(): FakeStep[] {
  return [
    {
      kind: "write-file",
      path: "requirements.txt",
      content: REQUIREMENTS_BEFORE,
    },
    { kind: "stop", reason: "end_turn" },
  ];
}

/** What the scripted agent does when Egma sends the mock-world task. */
function mockingSteps(): FakeStep[] {
  return [
    { kind: "say", text: "egma:plan check_availability\n" },
    { kind: "say", text: "egma:writing check_availability\n" },
    { kind: "write-file", path: "egma/mock-tools.md", content: MOCK_TOOLS_FILE },
    { kind: "say", text: "egma:wrote check_availability\n" },
    { kind: "stop", reason: "end_turn" },
  ];
}

let platform: Platform;
let workspace: Workspace;

beforeEach(async () => {
  localWorkerRuns.length = 0;
  platform = await startPlatform();
  workspace = await makeWorkspace({
    "package.json": '{"name":"livekit-front-desk","dependencies":{"livekit-agents":"latest"}}\n',
    "requirements.txt": REQUIREMENTS_BEFORE,
    "agent.ts": "// LiveKit AgentSession with a front desk prompt\n",
    "agent.py": WORKER_BEFORE,
  });
  await workspace.signIn(platform.url, platform.device.mint());
});

afterEach(async () => {
  await platform.close();
  await workspace?.remove();
});

function catalog(): Record<string, unknown> {
  return {
    items: [
      {
        agentPlatform: "livekit",
        agentPlatformLabel: "LiveKit",
        connectionType: "livekit_room",
        accessVariant: LIVEKIT_KEY_PAIR_VARIANT,
        accessVariantLabel: "LiveKit project credentials — Recommended",
        modality: "voice",
        productLabel: "LiveKit project credentials",
        topology: "agent-dials-out",
        simulatorAdapter: true,
        fields: [
          { key: "url", label: "LiveKit server URL", kind: "url", required: true, help: "The server.", afterCredentials: false },
          { key: "agentName", label: "Agent name", kind: "text", required: false, help: "Optional dispatch name.", afterCredentials: false },
          { key: "metadata", label: "Room metadata", kind: "json", required: false, help: "Optional JSON metadata.", afterCredentials: true },
        ],
        credentialRule: "required",
        credentialHelp: "Egma stores this pair sealed.",
        credentialFields: [
          { field: "apiKey", label: "API key", kind: "secret", required: true, help: "The project key." },
          { field: "apiSecret", label: "API secret", kind: "secret", required: true, help: "The project secret." },
        ],
      },
      {
        agentPlatform: "livekit",
        agentPlatformLabel: "LiveKit",
        connectionType: "livekit_room",
        accessVariant: LIVEKIT_TOKEN_ENDPOINT_VARIANT,
        accessVariantLabel: "Customer token endpoint — Advanced",
        modality: "voice",
        productLabel: "LiveKit token endpoint",
        topology: "agent-dials-out",
        simulatorAdapter: true,
        fields: [
          { key: "url", label: "LiveKit server URL", kind: "url", required: true, help: "The server.", afterCredentials: false },
          { key: "tokenEndpoint", label: "Token endpoint", kind: "url", required: true, help: "Where Egma requests one token.", afterCredentials: false },
        ],
        credentialRule: "required",
        credentialHelp: "Endpoint auth headers, stored sealed.",
        credentialFields: [
          { field: "headers", label: "Auth headers", kind: "json", required: true, help: "JSON headers." },
        ],
      },
    ],
  };
}

function connectionFetch(): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith("/v1/connection-options")) {
      return new Response(JSON.stringify(catalog()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return fetch(input, init);
  }) as typeof fetch;
}

function testFile(): string {
  return [
    "---",
    "format: 4",
    "name: greets-a-new-customer",
    "---",
    "## Scenario",
    "A new customer asks what the front desk can do.",
    "## Expected behaviors",
    "1. The agent explains how it can help.",
    "",
  ].join("\n");
}

function writingSteps(): FakeStep[] {
  return [
    { kind: "say", text: "egma:plan greets-a-new-customer\n" },
    { kind: "say", text: "egma:writing greets-a-new-customer\n" },
    {
      kind: "write-file",
      path: "egma/tests/front-desk-tests/greets-a-new-customer.md",
      content: testFile(),
    },
    { kind: "say", text: "egma:wrote greets-a-new-customer\n" },
    { kind: "stop", reason: "end_turn" },
  ];
}

/** Different answers to the same question, for one correction loop. */
class CorrectionUI extends HeadlessUI {
  readonly #answers = new Map<string, (string | null)[]>();

  constructor(answers: Readonly<Record<string, readonly (string | null)[]>>) {
    super();
    for (const [ask, values] of Object.entries(answers)) {
      this.#answers.set(ask, [...values]);
    }
  }

  override waitForAnswer(ask: AskId): Promise<string | null> {
    this.record.asked.push(ask);
    return Promise.resolve(this.#answers.get(ask)?.shift() ?? null);
  }
}

function connectionSetupStep(
  ui: HeadlessUI,
  discovery: {
    readonly dispatchName?: string;
    readonly entrypoint?: string;
  } = {},
) {
  return liveKitConnectionSetupStep({
    ui,
    platform: {
      url: platform.url,
      credentialsFile: workspace.credentialsFile,
    },
    cwd: workspace.dir,
    signal: new AbortController().signal,
    suggestedName: "front-desk",
    dispatchName: discovery.dispatchName ?? "front-desk-worker",
    entrypoint: discovery.entrypoint ?? "agent.py",
    fetchImpl: connectionFetch(),
  });
}

describe("LiveKit in the wizard", () => {
  it("shows every required connection and credential field together before collection", async () => {
    const script = await workspace.script({
      steps: [
        { kind: "say", text: "egma:found framework livekit-agents\n" },
        { kind: "say", text: "egma:found agent-name front-desk\n" },
        { kind: "say", text: "egma:found dispatch-name front-desk-worker\n" },
        { kind: "say", text: "egma:found entrypoint agent.py\n" },
        { kind: "stop", reason: "end_turn" },
      ],
      stepsByTask: [
        { contains: WORKER_INTEGRATION_TASK, steps: integrationSteps() },
      ],
    });
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
      env: workspace.env(),
      cols: 140,
    });
    const sees = async (...parts: readonly string[]): Promise<string> => {
      const found = await terminal.waitFor(
        () => parts.every((part) => terminal.screen().includes(part)),
        5_000,
      );
      if (!found) {
        throw new Error(
          `LiveKit terminal did not show: ${parts.join(" | ")}\n\nlast screen:\n${terminal.screen()}`,
        );
      }
      return terminal.screen();
    };

    try {
      await sees("Welcome to egma", "Press Enter to authenticate", "[q] quit");
      terminal.write("\r");
      await sees("[enter] begin", "[q] quit");
      terminal.write("\r");
      await sees("Setup", "› Simulation testing");
      terminal.write("\r");
      await sees("How should Egma get LiveKit room tokens?");
      terminal.write("\r");

      const form = await sees(
        "LiveKit connection details",
        "Get these values from your LiveKit project settings.",
        "LiveKit WebSocket URL *",
        "wss://your-project.livekit.cloud",
        "API key *",
        "Enter LiveKit API key",
        "API secret *",
        "Enter LiveKit API secret",
      );
      expect(form).not.toContain(API_KEY);
      expect(form).not.toContain(API_SECRET);
      // The field frame can finish one render before Ink applies the measured
      // caret position. Wait for the terminal-visible cursor itself rather
      // than racing that layout effect.
      expect(
        await terminal.waitFor(() => terminal.raw().includes("\u001B[?25h"), 5_000),
      ).toBe(true);

      const clickField = (label: string): void => {
        const lines = terminal.screen().split("\n");
        const labelRow = lines.findLastIndex((line) => line.includes(label));
        expect(labelRow, `field ${label} is on screen`).toBeGreaterThanOrEqual(0);
        // Label, top border, then the input row. SGR coordinates are one-based.
        terminal.write(`\u001B[<0;10;${labelRow + 3}M`);
      };

      const fieldShows = async (label: string, value: string): Promise<void> => {
        const shown = await terminal.waitFor(() => {
          const lines = terminal.screen().split("\n");
          const labelRow = lines.findLastIndex((line) => line.includes(label));
          return labelRow >= 0 && (lines[labelRow + 2] ?? "").includes(value);
        });
        expect(shown, `field ${label} shows its entered value`).toBe(true);
      };

      clickField("API secret *");
      await sees("› API secret *");
      terminal.write(API_SECRET);
      const secret = await sees("●".repeat(API_SECRET.length));
      expect(secret).not.toContain(API_SECRET);
      expect(terminal.raw()).not.toContain(API_SECRET);

      clickField("API key *");
      await sees("› API key *");
      terminal.write(API_KEY);
      await fieldShows("API key *", "●".repeat(API_KEY.length));

      clickField("LiveKit WebSocket URL *");
      await sees("› LiveKit WebSocket URL *");
      terminal.write("wss://acme.livekit.clod\u001B[Du");
      await sees("wss://acme.livekit.cloud");
      expect(terminal.raw()).not.toContain(API_KEY);

      terminal.write("\u0003");
      expect(await terminal.exited).toBe(130);
    } finally {
      await terminal.kill();
    }
  });

  it.each([
    {
      name: "project key pair",
      variant: LIVEKIT_KEY_PAIR_VARIANT,
      answers: {
        "connection:config:url": "wss://acme.livekit.cloud",
        "connection:credentials:apiKey": API_KEY,
        "connection:credentials:apiSecret": API_SECRET,
      },
      config: {
        url: "wss://acme.livekit.cloud",
        agentName: "front-desk-worker",
      },
      sealed: [API_KEY, API_SECRET],
    },
    {
      name: "token endpoint",
      variant: LIVEKIT_TOKEN_ENDPOINT_VARIANT,
      answers: {
        "connection:config:url": "wss://acme.livekit.cloud",
        "connection:config:tokenEndpoint": "https://tokens.example/livekit",
        "connection:credentials:headers": HEADERS,
      },
      config: {
        url: "wss://acme.livekit.cloud",
        tokenEndpoint: "https://tokens.example/livekit",
      },
      sealed: [HEADERS],
    },
  ] as const)("connects with a $name and runs the written test", async (shape) => {
    const script = await workspace.script({
      steps: [{ kind: "stop", reason: "end_turn" }],
      stepsByTask: [
        {
          contains: "Find the voice agent in",
          steps: [
            { kind: "say", text: "egma:found framework livekit-agents\n" },
            { kind: "say", text: "egma:found agent-name front-desk\n" },
            { kind: "say", text: "egma:found dispatch-name front-desk-worker\n" },
            { kind: "say", text: "egma:found entrypoint agent.py\n" },
            { kind: "say", text: "egma:found prompts agent.ts\n" },
            { kind: "say", text: "egma:found tools agent.ts (1 definition)\n" },
            { kind: "stop", reason: "end_turn" },
          ],
        },
        { contains: WORKER_INTEGRATION_TASK, steps: integrationSteps() },
        { contains: MOCK_AUTHORING_TASK, steps: mockingSteps() },
        { contains: "Write 1 test", steps: writingSteps() },
      ],
    });
    const ui = new HeadlessUI({
      answers: {
        "connection:variant": shape.variant,
        ...shape.answers,
      },
    });

    const grading = gradeEveryRun(platform, { atMost: 1 });
    let report;
    try {
      report = await runWizard({
        ui,
        launch: { ...workspace.launch(script), id: "codex", name: "Codex" },
        cwd: workspace.dir,
        signal: new AbortController().signal,
        platform: selectedPlatform({
          url: platform.url,
          credentialsFile: workspace.credentialsFile,
        }),
        connectionFetchImpl: connectionFetch(),
        startLiveKitWorker: startFakeLocalWorker,
        howManyTests: 1,
        runPollMs: 20,
      });
    } finally {
      grading.stop();
    }

    expect(report.kind).toBe("run-started");
    expect(platform.registered.agents.map((agent) => agent.name)).toEqual(["front-desk"]);
    expect(platform.registered.connections).toHaveLength(1);
    expect(platform.registered.connections[0]).toMatchObject({
      agentPlatform: "livekit",
      connectionType: "livekit_room",
      accessVariant: shape.variant,
      modality: "voice",
      config: shape.config,
    });
    expect(platform.registered.sealed).toEqual(shape.sealed);
    expect(localWorkerRuns).toEqual(
      shape.variant === LIVEKIT_KEY_PAIR_VARIANT
        ? [
            {
              url: "wss://acme.livekit.cloud",
              dispatchName: "front-desk-worker",
              entrypoint: "agent.py",
              dependencyManifest: "requirements.txt",
              stopped: true,
            },
          ]
        : [],
    );
    expect(ui.record.asked).not.toContain("retell-key");
    expect(ui.record.asked).not.toContain("reach");
    expect(ui.record.connectionAsks.map((ask) => ask.id)).toContain("connection:variant");
    expect(ui.record.connectionFieldGroups).toHaveLength(1);
    expect(ui.record.connectionFieldGroups[0]).toMatchObject({
      title: "LiveKit connection details",
      help:
        "For project credentials, get the WebSocket URL, API key, and API secret from LiveKit Cloud. Egma uses them to connect each simulation to a room.",
      notice:
        "Credentials are not sent to the coding agent or written to this repository. " +
        "Egma stores them sealed; project credentials also reach the local worker only through its process environment.",
    });
    expect(ui.record.connectionFieldGroups[0]?.fields.map((field) => field.id)).toEqual(
      shape.variant === LIVEKIT_KEY_PAIR_VARIANT
        ? [
            "connection:config:url",
            "connection:credentials:apiKey",
            "connection:credentials:apiSecret",
          ]
        : [
            "connection:config:url",
            "connection:config:tokenEndpoint",
            "connection:credentials:headers",
          ],
    );
    expect(
      ui.record.connectionAsks.find((ask) => ask.id === "connection:variant"),
    ).toMatchObject({
      help:
        "Project credentials (API key and secret) are Recommended and let Egma " +
        "run this repository's worker locally. An Advanced customer token endpoint " +
        "keeps the signing secret with you and requires an already-running worker.",
      defaultValue: LIVEKIT_KEY_PAIR_VARIANT,
      choices: [
        {
          value: LIVEKIT_KEY_PAIR_VARIANT,
          label: "LiveKit project credentials — Recommended",
        },
        {
          value: LIVEKIT_TOKEN_ENDPOINT_VARIANT,
          label: "Customer token endpoint — Advanced",
        },
      ],
    });
    expect(ui.record.connectionAsks.some((ask) => JSON.stringify(ask).includes(API_SECRET))).toBe(false);
    expect(JSON.stringify(ui.record.connectionFieldGroups)).not.toContain(API_SECRET);
    expect(platform.tests.tests).toHaveLength(1);
    expect(platform.running.runs).toHaveLength(1);

    const driven = JSON.parse(
      await readFile(path.join(workspace.dir, "fake-agent-report.json"), "utf8"),
    ) as { processIds: number[]; sessionIds: string[]; promptSessionIds: string[] };
    expect(new Set(driven.processIds).size).toBe(1);
    expect(driven.sessionIds).toHaveLength(1);
    // Four dispatches — find the agent, integrate the worker once, write the
    // tests, and write their mocked world — all use one ACP session.
    expect(driven.promptSessionIds).toEqual([
      driven.sessionIds[0],
      driven.sessionIds[0],
      driven.sessionIds[0],
      driven.sessionIds[0],
    ]);
  });

  /**
   * The whole LiveKit testing lane, offline, with the mock-authoring dispatch
   * scripted however the case at hand needs it.
   */
  async function liveKitLane(options: {
    readonly framework: string;
    readonly integration: FakeStep[];
    readonly mocking?: FakeStep[];
    readonly entrypoint?: string;
  }) {
    const script = await workspace.script({
      steps: [{ kind: "stop", reason: "end_turn" }],
      stepsByTask: [
        {
          contains: "Find the voice agent in",
          steps: [
            { kind: "say", text: `egma:found framework ${options.framework}\n` },
            { kind: "say", text: "egma:found agent-name front-desk\n" },
            { kind: "say", text: "egma:found dispatch-name front-desk-worker\n" },
            {
              kind: "say",
              text: `egma:found entrypoint ${options.entrypoint ?? "agent.py"}\n`,
            },
            { kind: "say", text: "egma:found tools agent.py (1 definition)\n" },
            { kind: "stop", reason: "end_turn" },
          ],
        },
        { contains: WORKER_INTEGRATION_TASK, steps: options.integration },
        { contains: MOCK_AUTHORING_TASK, steps: options.mocking ?? [] },
        { contains: "Write 1 test", steps: writingSteps() },
      ],
    });
    const ui = new HeadlessUI({
      answers: {
        "connection:variant": LIVEKIT_KEY_PAIR_VARIANT,
        "connection:config:url": "wss://acme.livekit.cloud",
        "connection:credentials:apiKey": API_KEY,
        "connection:credentials:apiSecret": API_SECRET,
      },
    });

    const grading = gradeEveryRun(platform, { atMost: 1 });
    try {
      const report = await runWizard({
        ui,
        launch: { ...workspace.launch(script), id: "codex", name: "Codex" },
        cwd: workspace.dir,
        signal: new AbortController().signal,
        platform: selectedPlatform({
          url: platform.url,
          credentialsFile: workspace.credentialsFile,
        }),
        connectionFetchImpl: connectionFetch(),
        startLiveKitWorker: startFakeLocalWorker,
        howManyTests: 1,
        runPollMs: 20,
      });
      return { report, ui };
    } finally {
      grading.stop();
    }
  }

  /**
   * The whole LiveKit testing lane, offline, asserted on what a developer could
   * check afterwards: which files landed and what they say, what the platform
   * was sent, and what the last line said.
   *
   * The gap this closes is the one the effort exists for. Before it, a
   * wizard-onboarded LiveKit repository ran its first simulations with no Egma
   * in the worker, no mocked world, and nothing on screen that said so.
   */
  it("wires the SDK, writes the mocked world, and shows both at the gate", async () => {
    const { report, ui } = await liveKitLane({
      framework: "livekit-agents",
      integration: integrationSteps(),
      mocking: mockingSteps(),
    });

    expect(report.kind).toBe("run-started");

    // The seam: the customer's own worker now awaits Egma where the tools are
    // attached and nothing has been said yet.
    const worker = await readFile(path.join(workspace.dir, "agent.py"), "utf8");
    expect(worker).toContain("from egma import mockable");
    expect(worker).toContain("await mockable(agent, ctx, session)");
    expect(worker.indexOf("await mockable")).toBeLessThan(worker.indexOf("await session.start"));
    expect(ui.record.statuses).toContain(
      "◆ Egma's requested worker integration is in agent.py",
    );
    expect(ui.record.statuses).toEqual(
      expect.arrayContaining([
        "◆ Planned 1 mock tool",
        "◆ Writing mock tool check_availability",
        "◆ Wrote mock tool check_availability",
      ]),
    );

    // The world: one grounded answer per real tool, in the committed file.
    const mocks = await readFile(
      path.join(workspace.dir, "egma", "mock-tools.md"),
      "utf8",
    );
    expect(mocks).toContain("### check_availability");

    // And it reached the platform with the tests, which is what lets a
    // simulation be served an answer and stamped for coverage at all.
    expect(platform.mocking.mockTools.map((tool) => tool.tool)).toEqual([
      "check_availability",
    ]);

    // The gate showed the tests and the world they run in, together.
    expect(ui.record.gate?.rows.map((row) => row.name)).toEqual([
      "greets-a-new-customer",
    ]);
    expect(ui.record.gate?.mocks).toEqual([
      { tool: "check_availability", says: "answers" },
    ]);
    // The worker and its Python dependency manifest are both named on the same
    // screen: pressing enter runs only after Egma has verified both files.
    expect(ui.record.gate?.changed).toEqual(["agent.py", "requirements.txt"]);
  });

  it("preserves existing monitoring in Testing mode and accepts no explicit connect", async () => {
    await writeFile(
      path.join(workspace.dir, "agent.py"),
      WORKER_MONITORED_BEFORE.replace("    await ctx.connect()\n", ""),
      "utf8",
    );
    const { report, ui } = await liveKitLane({
      framework: "livekit-agents",
      integration: integrationPreservingMonitoringWithoutConnect(),
    });

    expect(report.kind).toBe("run-started");
    const worker = await readFile(path.join(workspace.dir, "agent.py"), "utf8");
    expect(worker).toContain("monitor_livekit(ctx)");
    expect(worker).toContain("await mockable(agent, ctx, session)");
    expect(worker).not.toContain("await ctx.connect()");
    expect(platform.keys.minted).toHaveLength(0);

    const driven = JSON.parse(
      await readFile(path.join(workspace.dir, "fake-agent-report.json"), "utf8"),
    ) as { instructions: string[] };
    const integration =
      driven.instructions.find((task) => task.includes(WORKER_INTEGRATION_TASK)) ?? "";
    expect(integration).toContain("final mode is **testing**");
    expect(integration).toContain(
      "egma:found dependency-manifest pyproject.toml",
    );
    expect(integration).toContain(
      "including an\nEgma entry that was already there before this task",
    );
    expect(integration).not.toContain(
      "this repository has not asked for production monitoring",
    );
  });

  it("does not run when Testing removes an existing monitoring hook", async () => {
    await writeFile(path.join(workspace.dir, "agent.py"), WORKER_MONITORED_BEFORE, "utf8");

    const { report } = await liveKitLane({
      framework: "livekit-agents",
      // This edit satisfies Testing but wrongly deletes what was already there.
      integration: integrationSteps(),
    });

    expect(report).toMatchObject({ kind: "failed" });
    if (report.kind !== "failed") throw new Error("expected preservation refusal");
    expect(report.reason).toContain("existing monitor_livekit()");
    expect(platform.running.runs).toHaveLength(0);
    expect(localWorkerRuns).toHaveLength(0);
  });

  it("does not run when a later task removes preserved monitoring", async () => {
    await writeFile(
      path.join(workspace.dir, "agent.py"),
      WORKER_MONITORED_BEFORE.replace("    await ctx.connect()\n", ""),
      "utf8",
    );

    const { report, ui } = await liveKitLane({
      framework: "livekit-agents",
      integration: integrationPreservingMonitoringWithoutConnect(),
      mocking: laterRemovesMonitoring(),
    });

    expect(report).toMatchObject({ kind: "failed" });
    if (report.kind !== "failed") throw new Error("expected final preservation refusal");
    expect(report.reason).toContain("worker changed after integration approval");
    expect(report.reason).toContain("did not open review, push tests");
    expect(ui.record.gate).toBeNull();
    expect(platform.tests.tests).toHaveLength(0);
    expect(platform.running.runs).toHaveLength(0);
    expect(localWorkerRuns).toHaveLength(0);
  });

  it("does not run when the reported Python manifest omits egma", async () => {
    const { report } = await liveKitLane({
      framework: "livekit-agents",
      integration: integrationWithoutEgmaDependency(),
    });

    expect(report).toMatchObject({ kind: "failed" });
    if (report.kind !== "failed") throw new Error("expected dependency refusal");
    expect(report.reason).toContain("does not declare the Python egma distribution");
    expect(platform.running.runs).toHaveLength(0);
    expect(localWorkerRuns).toHaveLength(0);
  });

  it("does not run when the coding agent reports no dependency manifest", async () => {
    const { report } = await liveKitLane({
      framework: "livekit-agents",
      integration: integrationWithoutDependencyReport(),
    });

    expect(report).toMatchObject({ kind: "failed" });
    if (report.kind !== "failed") throw new Error("expected dependency report refusal");
    expect(report.reason).toContain("did not report the Python dependency manifest");
    expect(platform.running.runs).toHaveLength(0);
    expect(localWorkerRuns).toHaveLength(0);
  });

  it("does not run when a later task removes egma from the manifest", async () => {
    const { report, ui } = await liveKitLane({
      framework: "livekit-agents",
      integration: integrationSteps(),
      mocking: laterRemovesEgmaDependency(),
    });

    expect(report).toMatchObject({ kind: "failed" });
    if (report.kind !== "failed") throw new Error("expected final dependency refusal");
    expect(report.reason).toContain(
      "runtime dependency manifest changed after integration approval",
    );
    expect(report.reason).toContain("did not open review, push tests");
    expect(ui.record.gate).toBeNull();
    expect(platform.tests.tests).toHaveLength(0);
    expect(platform.running.runs).toHaveLength(0);
    expect(localWorkerRuns).toHaveLength(0);
  });

  it("does not dispatch an edit when the pre-edit worker cannot be snapshotted", async () => {
    const before = await readFile(path.join(workspace.dir, "agent.py"), "utf8");
    const { report, ui } = await liveKitLane({
      framework: "livekit-agents",
      entrypoint: "missing.py",
      integration: integrationSteps(),
    });

    expect(report.kind).toBe("failed");
    expect(ui.record.statuses.join("\n")).toContain(
      "could not snapshot missing.py inside this repository before integration",
    );
    expect(await readFile(path.join(workspace.dir, "agent.py"), "utf8")).toBe(before);
    const driven = JSON.parse(
      await readFile(path.join(workspace.dir, "fake-agent-report.json"), "utf8"),
    ) as { instructions: string[] };
    expect(
      driven.instructions.some((task) => task.includes(WORKER_INTEGRATION_TASK)),
    ).toBe(false);
    expect(platform.running.runs).toHaveLength(0);
    expect(localWorkerRuns).toHaveLength(0);
  });

  /**
   * The branch that decides whether a LiveKit walk dies or reaches a run.
   *
   * A coding agent that cannot identify one job entrypoint edits nothing and
   * says so. Egma prints its own lines for the developer to add by hand, then
   * stops before any remote setup. It must never claim or run a seam it did not
   * wire.
   */
  it("prints the lines itself and does not run when the worker cannot be found", async () => {
    const before = await readFile(path.join(workspace.dir, "agent.py"), "utf8");

    const { report, ui } = await liveKitLane({
      framework: "livekit-agents",
      integration: cannotFindTheWorker(),
    });

    expect(report.kind).toBe("failed");
    expect(platform.running.runs).toHaveLength(0);
    expect(localWorkerRuns).toHaveLength(0);

    // Egma's own block, word for word, rather than whatever the agent printed.
    for (const line of workerEntryInstructions("testing")) {
      if (line === "") continue;
      expect(ui.record.statuses).toContain(line);
    }
    // And the agent's own reason for not finding one is shown above it.
    expect(ui.record.statuses.join("\n")).toContain("Two workers define an entrypoint");

    // No seam was claimed and none was made.
    expect(
      ui.record.statuses.some((line) =>
        line.includes("requested worker integration is in"),
      ),
    ).toBe(false);
    expect(await readFile(path.join(workspace.dir, "agent.py"), "utf8")).toBe(before);
    expect(ui.record.gate).toBeNull();
    expect(platform.mocking.mockTools).toHaveLength(0);
  });

  /**
   * A marker is a claim, and this is the claim that costs money to believe.
   *
   * A coding agent that reports the edit and does not make it would otherwise
   * have Egma tell the developer their worker is wired, name it at the gate,
   * and swallow the instruction block — and then run the whole suite against
   * their real backend with every screen saying it was isolated. So the file is
   * opened and the awaited line looked for, and a claim Egma cannot find takes
   * the same path as an agent that admitted it found nothing.
   */
  it("does not believe a reported edit it cannot find in the file", async () => {
    const before = await readFile(path.join(workspace.dir, "agent.py"), "utf8");

    const { report, ui } = await liveKitLane({
      framework: "livekit-agents",
      integration: claimsWithoutEditing(),
    });

    expect(report.kind).toBe("failed");
    expect(platform.running.runs).toHaveLength(0);
    expect(localWorkerRuns).toHaveLength(0);

    // Nothing was claimed: not on screen, not at the gate.
    expect(
      ui.record.statuses.some((line) =>
        line.includes("requested worker integration is in"),
      ),
    ).toBe(false);
    expect(ui.record.gate).toBeNull();

    // The developer is told what Egma looked for and where, and given the lines.
    expect(ui.record.statuses.join("\n")).toContain(
      "Egma read agent.py, but expected exactly one mockable() call after integration and found 0.",
    );
    for (const line of workerEntryInstructions("testing")) {
      if (line === "") continue;
      expect(ui.record.statuses).toContain(line);
    }

    // And the worker really is untouched, which is the fact behind all of it.
    expect(await readFile(path.join(workspace.dir, "agent.py"), "utf8")).toBe(before);
  });

  /**
   * Words in a file are not a call.
   *
   * Each of these really writes the exact line the skill teaches, and in none of
   * them does it run. Anything that searched the text would say the worker was
   * wired; what decides is whether the file makes it code.
   */
  it.each(MENTIONED_NOT_CALLED)(
    "does not believe the call when it is only in $what",
    async ({ lines }) => {
      const { report, ui } = await liveKitLane({
        framework: "livekit-agents",
        integration: claimsAMentionOnly(lines),
      });

      expect(report.kind).toBe("failed");
      expect(platform.running.runs).toHaveLength(0);
      expect(localWorkerRuns).toHaveLength(0);
      // The words really are in the file, which is the whole point of the case.
      expect(await readFile(path.join(workspace.dir, "agent.py"), "utf8")).toContain(CALL);
      expect(ui.record.statuses.join("\n")).toContain(
        "Egma read agent.py, but expected exactly one mockable() call after integration and found 0.",
      );
      expect(ui.record.gate).toBeNull();
      expect(
        ui.record.statuses.some((line) =>
          line.includes("requested worker integration is in"),
        ),
      ).toBe(false);
    },
  );

  /**
   * And the control, so the check is known to be reading code rather than
   * refusing everything that mentions the line.
   *
   * A worker that explains itself in a docstring and runs the call underneath
   * is an ordinary worker, and Egma believes it.
  */
  it("believes a real call that sits under a docstring mentioning it", async () => {
    await writeFile(
      path.join(workspace.dir, "agent.py"),
      workerWith(
        '    """Egma answers this agent\'s tools from here:',
        `    ${CALL}`,
        '    """',
      ),
      "utf8",
    );
    const { report, ui } = await liveKitLane({
      framework: "livekit-agents",
      integration: claimsARealCallBesideAMention(),
    });

    expect(report.kind).toBe("run-started");
    expect(ui.record.statuses).toContain(
      "◆ Egma's requested worker integration is in agent.py",
    );
    expect(ui.record.gate?.changed).toEqual(["agent.py", "requirements.txt"]);
  });

  /**
   * A path that leaves the repository is not read at all.
   *
   * The reported file is the developer's own worker or it is nothing. Reading
   * whatever a driven coding agent points at — up through the tree, or through
   * a link — is not a thing Egma does, and a claim about a file outside the
   * repository is refused before it is opened rather than after.
   */
  it("refuses a reported edit outside the repository without reading it", async () => {
    const { report, ui } = await liveKitLane({
      framework: "livekit-agents",
      integration: claimsAPathOutsideTheRepository(),
    });

    expect(report.kind).toBe("failed");
    expect(platform.running.runs).toHaveLength(0);
    expect(localWorkerRuns).toHaveLength(0);
    expect(ui.record.statuses.join("\n")).toContain(
      "../../etc/passwd is outside this repository, so Egma did not read it.",
    );
    expect(
      ui.record.statuses.some((line) =>
        line.includes("requested worker integration is in"),
      ),
    ).toBe(false);
    expect(ui.record.gate).toBeNull();
    for (const line of workerEntryInstructions("testing")) {
      if (line === "") continue;
      expect(ui.record.statuses).toContain(line);
    }
  });

  /**
   * A Node LiveKit worker has no Egma SDK to put inside it.
   *
   * The SDK ships for Python today. Wiring a Python import into a TypeScript
   * worker would be worse than doing nothing, and running tests without
   * isolation could call real tools. The wizard says which of those it found
   * and stops before it creates testing resources.
   */
  it("refuses an unisolated testing run for a Node worker", async () => {
    const { report, ui } = await liveKitLane({
      framework: "@livekit/agents",
      integration: integrationSteps(),
    });

    expect(report.kind).toBe("failed");
    if (report.kind !== "failed") throw new Error("expected Node refusal");
    expect(report.reason).toContain("Node LiveKit worker cannot be integrated");
    expect(report.reason).toContain("did not create remote resources");
    expect(ui.record.statuses.join(" ")).toContain("Egma SDK is Python only today");
    expect(ui.record.gate).toBeNull();
    expect(platform.registered.connections).toHaveLength(0);
    expect(platform.suites.suites).toHaveLength(0);
    expect(platform.tests.tests).toHaveLength(0);
    expect(platform.running.runs).toHaveLength(0);
    expect(localWorkerRuns).toHaveLength(0);

    // Neither integration nor mock authoring was sent: the SDK is unavailable.
    const driven = JSON.parse(
      await readFile(path.join(workspace.dir, "fake-agent-report.json"), "utf8"),
    ) as { instructions: string[] };
    expect(
      driven.instructions.some((task) => task.includes(WORKER_INTEGRATION_TASK)),
    ).toBe(false);
    expect(driven.instructions.some((task) => task.includes(MOCK_AUTHORING_TASK))).toBe(
      false,
    );
  });
});

describe("LiveKit correction paths", () => {
  it.each([
    {
      fact: "dispatch name",
      discovery: { dispatchName: "unknown", entrypoint: "agent.py" },
      reason:
        "Egma could not find the LiveKit dispatch name in this repository, so it did not create a connection. Set the worker's agent name in code and run Egma again.",
    },
    {
      fact: "worker entrypoint",
      discovery: { dispatchName: "front-desk-worker", entrypoint: "  UNKNOWN  " },
      reason:
        "Egma could not find the LiveKit worker entrypoint in this repository, so it did not create a connection. Make the worker startup path clear and run Egma again.",
    },
  ])("does not accept an unknown discovered $fact", async ({ discovery, reason }) => {
    const ui = new HeadlessUI();

    const result = await connectionSetupStep(ui, discovery);

    expect(result).toEqual({
      report: { kind: "failed", reason },
      connected: null,
    });
    expect(ui.record.asked).toEqual([]);
    expect(ui.record.connectionAsks).toEqual([]);
    expect(platform.registered.agents).toHaveLength(0);
    expect(platform.registered.connections).toHaveLength(0);
    expect(platform.registered.sealed).toHaveLength(0);
  });

  it("reports a discovered-name collision without asking for another name", async () => {
    const existing = await connectLiveKit(
      {
        variant: LIVEKIT_KEY_PAIR_VARIANT,
        name: "front-desk",
        url: "wss://existing.livekit.cloud",
        credentials: liveKitKeyPair(API_KEY, API_SECRET),
      },
      {
        url: platform.url,
        key: platform.device.keys[0]!,
      },
    );
    expect(existing.kind).toBe("registered");

    const ui = new CorrectionUI({
      "connection:variant": [LIVEKIT_KEY_PAIR_VARIANT],
      "connection:config:url": ["wss://new.livekit.cloud"],
      "connection:credentials:apiKey": [API_KEY],
      "connection:credentials:apiSecret": [API_SECRET],
    });

    const result = await connectionSetupStep(ui);

    const collision =
      "An Egma agent already uses the name front-desk. Rename this voice agent in its source, then run Egma again.";
    expect(result).toEqual({
      report: { kind: "failed", reason: collision },
      connected: null,
    });
    expect(ui.record.connectionAsks.map((ask) => ask.id)).not.toContain(
      "connection:agent-name",
    );
    expect(platform.registered.agents.map((agent) => agent.name)).toEqual(["front-desk"]);
    expect(platform.registered.connections).toHaveLength(1);
  });

  it("reports a platform refusal without restarting credential collection", async () => {
    const ui = new CorrectionUI({
      "connection:variant": [LIVEKIT_KEY_PAIR_VARIANT],
      "connection:config:url": ["not-a-url"],
      "connection:credentials:apiKey": [API_KEY],
      "connection:credentials:apiSecret": [API_SECRET],
    });

    const result = await connectionSetupStep(ui);

    const refusal =
      "the config's url must be a ws, wss, http or https URL, which looks like wss://example.livekit.cloud";
    expect(result).toEqual({
      report: { kind: "failed", reason: refusal },
      connected: null,
    });
    expect(platform.registered.agents).toHaveLength(0);
    expect(platform.registered.sealed).toHaveLength(0);
  });

  it("stops before registration when a required field is missing", async () => {
    const ui = new CorrectionUI({
      "connection:variant": [LIVEKIT_KEY_PAIR_VARIANT],
      "connection:config:url": [null],
    });

    const result = await connectionSetupStep(ui);

    expect(result).toEqual({
      report: {
        kind: "failed",
        reason:
          "No value was given for LiveKit server URL, so nothing was created.",
      },
      connected: null,
    });
    expect(platform.registered.agents).toHaveLength(0);
    expect(platform.registered.connections).toHaveLength(0);
    expect(platform.registered.sealed).toHaveLength(0);
    // Required fields are one form, so the headless seam receives every field
    // in that form even when the first value is missing.
    expect(ui.record.connectionFieldGroups[0]?.fields.map((field) => field.id)).toEqual([
      "connection:config:url",
      "connection:credentials:apiKey",
      "connection:credentials:apiSecret",
    ]);
    expect(ui.record.asked).toContain("connection:credentials:apiKey");
  });

  it("reports invalid required JSON as a JSON-object correction", async () => {
    const ui = new CorrectionUI({
      "connection:agent-name": ["front-desk"],
      "connection:variant": [LIVEKIT_TOKEN_ENDPOINT_VARIANT],
      "connection:config:url": ["wss://acme.livekit.cloud"],
      "connection:config:tokenEndpoint": ["https://tokens.example/livekit"],
      "connection:credentials:headers": ["not-json"],
    });

    const result = await connectionSetupStep(ui);

    expect(result).toEqual({
      report: {
        kind: "failed",
        reason:
          "Auth headers must be one JSON object. Correct it and run Egma again.",
      },
      connected: null,
    });
    expect(platform.registered.agents).toHaveLength(0);
    expect(platform.registered.connections).toHaveLength(0);
    expect(platform.registered.sealed).toHaveLength(0);
  });
});
