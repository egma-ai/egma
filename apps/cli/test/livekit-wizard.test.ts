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
import { connectLiveKitStep } from "../src/wizard/livekit-connect-step.ts";
import { alreadyAsked } from "../src/wizard/login-step.ts";
import { runWizard } from "../src/wizard/wizard-flow.ts";
import type { FakeStep } from "./support/fake-agent.ts";
import { startPlatform, type Platform } from "./support/fixture-platform/index.ts";
import { gradeEveryRun } from "./support/grading.ts";
import { makeWorkspace, type Workspace } from "./support/workspace.ts";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const API_KEY = "APIhx4bmvHnLcWXYZ";
const API_SECRET = "livekit-secret-E5F6G7H8QRST";
const HEADERS = '{"Authorization":"Bearer private-token"}';

let platform: Platform;
let workspace: Workspace;

beforeEach(async () => {
  platform = await startPlatform();
  workspace = await makeWorkspace({
    "package.json": '{"name":"livekit-front-desk","dependencies":{"livekit-agents":"latest"}}\n',
    "agent.ts": "// LiveKit AgentSession with a front desk prompt\n",
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
        type: "livekit",
        label: "LiveKit",
        modalities: ["voice"],
        topology: "agent-dials-out",
        simulator_adapter: true,
        capability_discovery: false,
        variants: [
          {
            id: LIVEKIT_KEY_PAIR_VARIANT,
            label: "LiveKit project credentials — Recommended",
            chosen_by: null,
            fields: [
              { key: "url", label: "LiveKit server URL", kind: "url", required: true, help: "The server." },
              { key: "agentName", label: "Agent name", kind: "text", required: false, help: "Optional dispatch name." },
              { key: "metadata", label: "Room metadata", kind: "json", required: false, help: "Optional JSON metadata." },
            ],
            credential_rule: "required",
            credential_help: "Egma stores this pair sealed.",
            credential_fields: [
              { field: "apiKey", label: "API key", kind: "secret", required: true, help: "The project key." },
              { field: "apiSecret", label: "API secret", kind: "secret", required: true, help: "The project secret." },
            ],
          },
          {
            id: LIVEKIT_TOKEN_ENDPOINT_VARIANT,
            label: "Customer token endpoint — Advanced",
            chosen_by: "tokenEndpoint",
            fields: [
              { key: "url", label: "LiveKit server URL", kind: "url", required: true, help: "The server." },
              { key: "tokenEndpoint", label: "Token endpoint", kind: "url", required: true, help: "Where Egma requests one token." },
            ],
            credential_rule: "optional",
            credential_help: "Optional endpoint auth headers, stored sealed.",
            credential_fields: [
              { field: "headers", label: "Auth headers", kind: "json", required: false, help: "Optional JSON headers." },
            ],
          },
        ],
      },
    ],
  };
}

function connectionFetch(): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith("/api/connection-types")) {
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
    { kind: "write-file", path: "egma/tests/greets-a-new-customer.md", content: testFile() },
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

function connectStep(ui: HeadlessUI) {
  return connectLiveKitStep({
    ui,
    platform: {
      url: platform.url,
      instanceId: platform.instanceId,
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
        platform: alreadyAsked({
          url: platform.url,
          instanceId: platform.instanceId,
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
      type: "livekit",
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
    expect(driven.promptSessionIds).toEqual([driven.sessionIds[0], driven.sessionIds[0]]);
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

    const result = await connectStep(ui);

    const collision =
      "An Egma agent already uses the name front-desk. Choose another name.";
    expect(result.report).toEqual({
      kind: "connected",
      agentName: "front-desk-2",
      connectionName: "livekit-1",
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

    const result = await connectStep(ui);

    const refusal =
      "the config's url must be a ws, wss, http or https URL, which looks like wss://example.livekit.cloud";
    expect(result.report).toEqual({
      kind: "connected",
      agentName: "front-desk",
      connectionName: "livekit-1",
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

    const result = await connectStep(ui);

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
