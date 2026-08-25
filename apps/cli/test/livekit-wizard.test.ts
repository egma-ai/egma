/** LiveKit through the real wizard flow, from repository discovery to a run. */

import { readFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  connectLiveKit,
  liveKitKeyPair,
  LIVEKIT_KEY_PAIR_VARIANT,
  LIVEKIT_TOKEN_ENDPOINT_VARIANT,
} from "../src/livekit/connect.ts";
import { HeadlessUI } from "../src/ui/headless-ui.ts";
import type { AskId } from "../src/ui/wizard-ui.ts";
import { liveKitConnectionSetupStep } from "../src/wizard/livekit-connection-setup-step.ts";
import { selectedPlatform } from "../src/wizard/login-step.ts";
import { sdkEntryInstructions } from "../src/wizard/mock-authoring-step.ts";
import { runWizard } from "../src/wizard/wizard-flow.ts";
import type { FakeStep } from "./support/fake-agent.ts";
import { startPlatform, type Platform } from "./support/fixture-platform/index.ts";
import { gradeEveryRun } from "./support/grading.ts";
import { makeWorkspace, type Workspace } from "./support/workspace.ts";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const API_KEY = "APIhx4bmvHnLcWXYZ";
const API_SECRET = "livekit-secret-E5F6G7H8QRST";
const HEADERS = '{"Authorization":"Bearer private-token"}';

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

/** The one fragment that names the mock-authoring task and nothing else. */
const MOCK_AUTHORING_TASK = "run isolated from its real";

/**
 * A scripted agent that reports the edit and does not make it.
 *
 * The path it names is real and the file is really there — it is the worker
 * this workspace was given — so nothing but reading the file can tell this
 * apart from the honest case.
 */
function claimsWithoutEditing(): FakeStep[] {
  return [
    { kind: "say", text: "egma:found sdk-entry agent.py\n" },
    { kind: "write-file", path: "egma/mock-tools.md", content: MOCK_TOOLS_FILE },
    { kind: "say", text: "egma:wrote check_availability\n" },
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
    { kind: "say", text: "egma:found sdk-entry agent.py\n" },
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
    { kind: "say", text: "egma:found sdk-entry agent.py\n" },
    { kind: "stop", reason: "end_turn" },
  ];
}

/** A scripted agent that names a file outside the repository altogether. */
function claimsAPathOutsideTheRepository(): FakeStep[] {
  return [
    { kind: "say", text: "egma:found sdk-entry ../../etc/passwd\n" },
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

/** What the scripted agent does when Egma sends it the mock-authoring task. */
function mockingSteps(): FakeStep[] {
  return [
    { kind: "say", text: "egma:plan check_availability\n" },
    { kind: "write-file", path: "agent.py", content: WORKER_AFTER },
    { kind: "say", text: "egma:found sdk-entry agent.py\n" },
    { kind: "write-file", path: "egma/mock-tools.md", content: MOCK_TOOLS_FILE },
    { kind: "say", text: "egma:wrote check_availability\n" },
    { kind: "stop", reason: "end_turn" },
  ];
}

let platform: Platform;
let workspace: Workspace;

beforeEach(async () => {
  platform = await startPlatform();
  workspace = await makeWorkspace({
    "package.json": '{"name":"livekit-front-desk","dependencies":{"livekit-agents":"latest"}}\n',
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
      path: "egma/tests/generated/greets-a-new-customer.md",
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

function connectionSetupStep(ui: HeadlessUI) {
  return liveKitConnectionSetupStep({
    ui,
    platform: {
      url: platform.url,
      credentialsFile: workspace.credentialsFile,
    },
    cwd: workspace.dir,
    signal: new AbortController().signal,
    suggestedName: "front-desk",
    fetchImpl: connectionFetch(),
  });
}

describe("LiveKit in the wizard", () => {
  it.each([
    {
      name: "project key pair",
      variant: LIVEKIT_KEY_PAIR_VARIANT,
      answers: {
        "connection:config:url": "wss://acme.livekit.cloud",
        "connection:config:agentName": "front-desk-worker",
        "connection:config:metadata": '{"tenant":"acme"}',
        "connection:credentials:apiKey": API_KEY,
        "connection:credentials:apiSecret": API_SECRET,
      },
      config: {
        url: "wss://acme.livekit.cloud",
        agentName: "front-desk-worker",
        metadata: '{"tenant":"acme"}',
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
            { kind: "say", text: "egma:found prompts agent.ts\n" },
            { kind: "say", text: "egma:found tools agent.ts (1 definition)\n" },
            { kind: "stop", reason: "end_turn" },
          ],
        },
        { contains: MOCK_AUTHORING_TASK, steps: mockingSteps() },
        { contains: "Write 1 test", steps: writingSteps() },
      ],
    });
    const ui = new HeadlessUI({
      answers: {
        "connection:agent-name": "front-desk",
        "connection:variant": shape.variant,
        ...shape.answers,
      },
    });

    const grading = gradeEveryRun(platform, { atMost: 1 });
    let report;
    try {
      report = await runWizard({
        ui,
        launch: { ...workspace.launch(script), id: "codex-acp", name: "Codex" },
        cwd: workspace.dir,
        signal: new AbortController().signal,
        platform: selectedPlatform({
          url: platform.url,
          credentialsFile: workspace.credentialsFile,
        }),
        connectionFetchImpl: connectionFetch(),
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
    expect(ui.record.asked).not.toContain("retell-key");
    expect(ui.record.asked).not.toContain("reach");
    expect(ui.record.connectionAsks.map((ask) => ask.id)).toContain("connection:variant");
    expect(
      ui.record.connectionAsks.find((ask) => ask.id === "connection:variant"),
    ).toMatchObject({
      help:
        "Project credentials (API key and secret) are Recommended and are the " +
        "quickest setup. An Advanced customer token endpoint keeps the signing " +
        "secret with you; Egma calls it for each simulation.",
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
    expect(platform.tests.tests).toHaveLength(1);
    expect(platform.running.runs).toHaveLength(1);

    const driven = JSON.parse(
      await readFile(path.join(workspace.dir, "fake-agent-report.json"), "utf8"),
    ) as { processIds: number[]; sessionIds: string[]; promptSessionIds: string[] };
    expect(new Set(driven.processIds).size).toBe(1);
    expect(driven.sessionIds).toHaveLength(1);
    // Three dispatches now — find the agent, write the tests, write the world
    // those tests run in — and all of them in the one process and the one
    // protocol connection the wizard opened.
    expect(driven.promptSessionIds).toEqual([
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
    readonly mocking: FakeStep[];
  }) {
    const script = await workspace.script({
      steps: [{ kind: "stop", reason: "end_turn" }],
      stepsByTask: [
        {
          contains: "Find the voice agent in",
          steps: [
            { kind: "say", text: `egma:found framework ${options.framework}\n` },
            { kind: "say", text: "egma:found agent-name front-desk\n" },
            { kind: "say", text: "egma:found tools agent.py (1 definition)\n" },
            { kind: "stop", reason: "end_turn" },
          ],
        },
        { contains: MOCK_AUTHORING_TASK, steps: options.mocking },
        { contains: "Write 1 test", steps: writingSteps() },
      ],
    });
    const ui = new HeadlessUI({
      answers: {
        "connection:agent-name": "front-desk",
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
        launch: { ...workspace.launch(script), id: "codex-acp", name: "Codex" },
        cwd: workspace.dir,
        signal: new AbortController().signal,
        platform: selectedPlatform({
          url: platform.url,
          credentialsFile: workspace.credentialsFile,
        }),
        connectionFetchImpl: connectionFetch(),
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
      mocking: mockingSteps(),
    });

    expect(report.kind).toBe("run-started");

    // The seam: the customer's own worker now awaits Egma where the tools are
    // attached and nothing has been said yet.
    const worker = await readFile(path.join(workspace.dir, "agent.py"), "utf8");
    expect(worker).toContain("from egma import mockable");
    expect(worker).toContain("await mockable(agent, ctx, session)");
    expect(worker.indexOf("await mockable")).toBeLessThan(worker.indexOf("await session.start"));
    expect(ui.record.statuses).toContain("◆ Egma's testing entry is in agent.py");

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
    // And the one edit the wizard made to the developer's own code is named on
    // the same screen: pressing enter runs against a worker Egma just changed.
    expect(ui.record.gate?.changed).toEqual(["agent.py"]);
  });

  /**
   * The branch that decides whether a LiveKit walk dies or reaches a run.
   *
   * A coding agent that cannot identify one job entrypoint edits nothing and
   * says so. Egma does not stop: it prints its own lines for the developer to
   * add by hand, and the walk finishes with the run it came for — which is the
   * run every LiveKit repository got before this step existed. What it must
   * never do is claim a seam it did not wire.
   */
  it("prints the lines itself when the worker cannot be found, and still runs", async () => {
    const before = await readFile(path.join(workspace.dir, "agent.py"), "utf8");

    const { report, ui } = await liveKitLane({
      framework: "livekit-agents",
      mocking: cannotFindTheWorker(),
    });

    // The walk reached what it came for.
    expect(report.kind).toBe("run-started");
    expect(platform.running.runs).toHaveLength(1);

    // Egma's own block, word for word, rather than whatever the agent printed.
    for (const line of sdkEntryInstructions()) {
      if (line === "") continue;
      expect(ui.record.statuses).toContain(line);
    }
    // And the agent's own reason for not finding one is shown above it.
    expect(ui.record.statuses.join("\n")).toContain("Two workers define an entrypoint");

    // No seam was claimed and none was made.
    expect(ui.record.statuses.some((line) => line.includes("testing entry is in"))).toBe(false);
    expect(await readFile(path.join(workspace.dir, "agent.py"), "utf8")).toBe(before);
    expect(ui.record.gate?.changed).toEqual([]);
    expect(ui.record.gate?.mocks).toEqual([]);
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
      mocking: claimsWithoutEditing(),
    });

    expect(report.kind).toBe("run-started");

    // Nothing was claimed: not on screen, not at the gate.
    expect(ui.record.statuses.some((line) => line.includes("testing entry is in"))).toBe(
      false,
    );
    expect(ui.record.gate?.changed).toEqual([]);

    // The developer is told what Egma looked for and where, and given the lines.
    expect(ui.record.statuses.join("\n")).toContain(
      "Egma read agent.py and found no awaited mockable() in it.",
    );
    for (const line of sdkEntryInstructions()) {
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
        mocking: claimsAMentionOnly(lines),
      });

      expect(report.kind).toBe("run-started");
      // The words really are in the file, which is the whole point of the case.
      expect(await readFile(path.join(workspace.dir, "agent.py"), "utf8")).toContain(CALL);
      expect(ui.record.statuses.join("\n")).toContain(
        "Egma read agent.py and found no awaited mockable() in it.",
      );
      expect(ui.record.gate?.changed).toEqual([]);
      expect(ui.record.statuses.some((line) => line.includes("testing entry is in"))).toBe(
        false,
      );
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
    const { report, ui } = await liveKitLane({
      framework: "livekit-agents",
      mocking: claimsARealCallBesideAMention(),
    });

    expect(report.kind).toBe("run-started");
    expect(ui.record.statuses).toContain("◆ Egma's testing entry is in agent.py");
    expect(ui.record.gate?.changed).toEqual(["agent.py"]);
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
      mocking: claimsAPathOutsideTheRepository(),
    });

    expect(report.kind).toBe("run-started");
    expect(ui.record.statuses.join("\n")).toContain(
      "../../etc/passwd is outside this repository, so Egma did not read it.",
    );
    expect(ui.record.statuses.some((line) => line.includes("testing entry is in"))).toBe(
      false,
    );
    expect(ui.record.gate?.changed).toEqual([]);
    for (const line of sdkEntryInstructions()) {
      if (line === "") continue;
      expect(ui.record.statuses).toContain(line);
    }
  });

  /**
   * A Node LiveKit worker has no Egma SDK to put inside it.
   *
   * The SDK ships for Python today. Wiring a Python import into a TypeScript
   * worker would be worse than doing nothing, and writing a mocked world for a
   * worker that can never serve it would be writing answers nobody reads. So
   * the step says which of those it is and the walk carries on.
   */
  it("says the SDK is Python only for a Node worker, and dispatches nothing", async () => {
    const { report, ui } = await liveKitLane({
      framework: "@livekit/agents",
      mocking: mockingSteps(),
    });

    expect(report.kind).toBe("run-started");
    expect(ui.record.statuses.join(" ")).toContain("Egma SDK is Python only today");
    expect(ui.record.gate?.changed).toEqual([]);
    expect(ui.record.gate?.mocks).toEqual([]);

    // The mock-authoring task was never sent: there was nothing to ask for.
    const driven = JSON.parse(
      await readFile(path.join(workspace.dir, "fake-agent-report.json"), "utf8"),
    ) as { instructions: string[] };
    expect(driven.instructions.some((task) => task.includes(MOCK_AUTHORING_TASK))).toBe(
      false,
    );
  });
});

describe("LiveKit correction paths", () => {
  it("shows a name collision, then registers the corrected name", async () => {
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
      "connection:agent-name": ["front-desk", "front-desk-2"],
      "connection:variant": [LIVEKIT_KEY_PAIR_VARIANT, LIVEKIT_KEY_PAIR_VARIANT],
      "connection:config:url": [
        "wss://new.livekit.cloud",
        "wss://new.livekit.cloud",
      ],
      "connection:config:agentName": [null, null],
      "connection:config:metadata": [null, null],
      "connection:credentials:apiKey": [API_KEY, API_KEY],
      "connection:credentials:apiSecret": [API_SECRET, API_SECRET],
    });

    const result = await connectionSetupStep(ui);

    const collision =
      "An Egma agent already uses the name front-desk. Choose another name.";
    expect(result.report).toEqual({
      kind: "connected",
      agentName: "front-desk-2",
      connectionName: "livekit_room-1",
    });
    expect(ui.record.statuses).toContain(collision);
    expect(
      ui.record.connectionAsks.filter((ask) => ask.id === "connection:agent-name")[1],
    ).toMatchObject({ problem: collision });
    expect(platform.registered.agents.map((agent) => agent.name)).toEqual([
      "front-desk",
      "front-desk-2",
    ]);
    expect(platform.registered.connections).toHaveLength(2);
  });

  it("shows a platform refusal, then registers the corrected field", async () => {
    const ui = new CorrectionUI({
      "connection:agent-name": ["front-desk", "front-desk"],
      "connection:variant": [LIVEKIT_KEY_PAIR_VARIANT, LIVEKIT_KEY_PAIR_VARIANT],
      "connection:config:url": ["not-a-url", "wss://acme.livekit.cloud"],
      "connection:config:agentName": [null, null],
      "connection:config:metadata": [null, null],
      "connection:credentials:apiKey": [API_KEY, API_KEY],
      "connection:credentials:apiSecret": [API_SECRET, API_SECRET],
    });

    const result = await connectionSetupStep(ui);

    const refusal =
      "the config's url must be a ws, wss, http or https URL, which looks like wss://example.livekit.cloud";
    expect(result.report).toEqual({
      kind: "connected",
      agentName: "front-desk",
      connectionName: "livekit_room-1",
    });
    expect(ui.record.statuses).toContain(refusal);
    expect(
      ui.record.connectionAsks.filter((ask) => ask.id === "connection:agent-name")[1],
    ).toMatchObject({ problem: refusal });
    expect(platform.registered.agents.map((agent) => agent.name)).toEqual(["front-desk"]);
    expect(platform.registered.connections[0]?.config).toEqual({
      url: "wss://acme.livekit.cloud",
    });
    // The refused request did not seal or keep anything.
    expect(platform.registered.sealed).toEqual([API_KEY, API_SECRET]);
  });

  it("stops before registration when a required field is missing", async () => {
    const ui = new CorrectionUI({
      "connection:agent-name": ["front-desk"],
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
    expect(ui.record.asked).not.toContain("connection:credentials:apiKey");
  });
});
