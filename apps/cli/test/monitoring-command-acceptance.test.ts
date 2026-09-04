/** Agent monitoring through the built skills-first CLI and fixture platform. */

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";

import { expect, it, vi } from "vitest";

import {
  createEgmaFolder,
  EMPTY_CONFIG,
  folderPathsIn,
} from "../src/folder/egma-folder.ts";
import {
  startPlatform,
  type Platform,
} from "./support/fixture-platform/index.ts";
import { CLI_ENTRY, makeWorkspace, type Workspace } from "./support/workspace.ts";

const EGMA_KEY = "egma_sk_monitoring-command-acceptance";
const RETELL_KEY = "retell-monitoring-only-secret-WXYZ";
const RETELL_AGENT_ID = "retell_agent_receptionist";
const SKILL_HANDOFF =
  "npx --yes skills add egma-ai/egma --skill integrate-egma";

type Result = {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
};

async function egma(
  workspace: Workspace,
  args: readonly string[],
  input = "",
): Promise<Result> {
  const child = spawn(process.execPath, [CLI_ENTRY, ...args], {
    cwd: workspace.dir,
    env: workspace.env(),
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.stdin.end(input);
  const code = await new Promise<number>((resolve) => {
    child.on("close", (value) => resolve(value ?? 1));
  });
  return { code, stdout, stderr };
}

async function registerAgent(
  platform: Platform,
  agentPlatform: "retell" | "livekit",
): Promise<{ readonly id: string; readonly name: string }> {
  const response = await fetch(
    `${platform.url}/v1/agents?projectId=${platform.projectId}`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${EGMA_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: agentPlatform === "retell" ? "Receptionist" : "LiveKit concierge",
        agentPlatform,
      }),
    },
  );
  expect(response.status).toBe(201);
  const created = (await response.json()) as {
    readonly agent: { readonly id: string; readonly name: string };
  };
  return created.agent;
}

async function initialized(
  platform: Platform,
  workspace: Workspace,
  agentPlatform: "retell" | "livekit",
): Promise<{ readonly id: string; readonly name: string }> {
  platform.signedInWith(EGMA_KEY);
  await workspace.signIn(platform.url, EGMA_KEY);
  const agent = await registerAgent(platform, agentPlatform);
  await createEgmaFolder({
    repository: workspace.dir,
    config: {
      ...EMPTY_CONFIG,
      platform: { origin: platform.url },
      project: { id: platform.projectId, name: "Fixture project" },
      agents: [
        {
          ...agent,
          platform: agentPlatform,
          connections: [],
        },
      ],
    },
  });
  return agent;
}

function didNotPrint(result: Result, secret: string): void {
  expect(result.stdout.includes(secret)).toBe(false);
  expect(result.stderr.includes(secret)).toBe(false);
}

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

it("sets up monitoring for a bare Retell Agent from one-time JSON stdin, then stops future pulls without erasing evidence", async () => {
  const [platform, workspace] = await Promise.all([
    startPlatform(),
    makeWorkspace(),
  ]);
  try {
    const agent = await initialized(platform, workspace, "retell");
    const beforeSetup = platform.records.length;

    const setup = await egma(
      workspace,
      [
        "agent",
        "monitoring",
        "setup",
        "--agent",
        agent.id,
        "--platform",
        "retell",
        "--retell-agent",
        RETELL_AGENT_ID,
        "--credentials-stdin",
      ],
      JSON.stringify({ apiKey: RETELL_KEY }),
    );

    expect(setup.code, setup.stderr).toBe(0);
    expect(setup.stderr).toBe("");
    didNotPrint(setup, RETELL_KEY);
    expect(setup.stdout).toContain(
      `Retell monitoring is set up for Egma Agent ${agent.id}.`,
    );
    expect(platform.monitoring.monitoringKeys).toEqual([RETELL_KEY]);

    const setupRequests = platform.records.slice(beforeSetup);
    expect(
      setupRequests.map((record) => `${record.method} ${record.path}${record.query}`),
    ).toEqual([
      `GET /v1/agents/${agent.id}?projectId=${platform.projectId}`,
      `POST /v1/monitoring/start?projectId=${platform.projectId}`,
    ]);
    const storedAfterSetup = platform.registered.agents[0];
    expect(storedAfterSetup).toMatchObject({
      id: agent.id,
      platformAgentId: RETELL_AGENT_ID,
      pullProductionCalls: true,
      monitoringApiKeyHint: "WXYZ",
    });

    const evidenceAt = new Date("2026-09-03T12:34:56.000Z");
    platform.registered.received(agent.id, evidenceAt);
    const beforeStop = platform.records.length;
    const stop = await egma(workspace, [
      "agent",
      "monitoring",
      "stop",
      "--agent",
      agent.id,
      "--platform",
      "retell",
    ]);

    expect(stop.code, stop.stderr).toBe(0);
    expect(stop.stderr).toBe("");
    expect(stop.stdout).toContain(
      `Stopped pulling future Retell calls for Egma Agent ${agent.id}. Existing traces were kept.`,
    );
    expect(
      platform.records
        .slice(beforeStop)
        .map((record) => `${record.method} ${record.path}${record.query}`),
    ).toEqual([
      `POST /v1/monitoring/agents/${agent.id}/stop?projectId=${platform.projectId}`,
    ]);
    expect(platform.registered.agents[0]).toMatchObject({
      pullProductionCalls: false,
      platformAgentId: RETELL_AGENT_ID,
      monitoringApiKeyHint: "WXYZ",
      lastReceivedAt: evidenceAt.toISOString(),
    });

    const config = await readFile(folderPathsIn(workspace.dir).config, "utf8");
    const credentials = await readFile(workspace.credentialsFile, "utf8");
    expect(config).not.toContain(RETELL_KEY);
    expect(credentials).not.toContain(RETELL_KEY);
  } finally {
    await Promise.all([platform.close(), workspace.remove()]);
  }
});

it("hands both LiveKit monitoring commands to integrate-egma without a monitoring write", async () => {
  const [platform, workspace] = await Promise.all([
    startPlatform(),
    makeWorkspace(),
  ]);
  try {
    const agent = await initialized(platform, workspace, "livekit");
    const beforeCommands = platform.records.length;
    const configBefore = await readFile(folderPathsIn(workspace.dir).config, "utf8");

    const setup = await egma(workspace, [
      "agent",
      "monitoring",
      "setup",
      "--agent",
      agent.id,
      "--platform",
      "livekit",
    ]);
    const stop = await egma(workspace, [
      "agent",
      "monitoring",
      "stop",
      "--agent",
      agent.id,
      "--platform",
      "livekit",
    ]);

    expect(setup).toMatchObject({ code: 1, stderr: "" });
    expect(stop).toMatchObject({ code: 1, stderr: "" });
    expect(setup.stdout).toContain(SKILL_HANDOFF);
    expect(stop.stdout).toContain(SKILL_HANDOFF);
    expect(setup.stdout).toContain("LiveKit monitoring setup");
    expect(stop.stdout).toContain("LiveKit monitoring removal");
    expect(platform.records).toHaveLength(beforeCommands);
    expect(platform.monitoring.monitoringKeys).toEqual([]);
    expect(platform.registered.agents[0]).toMatchObject({
      id: agent.id,
      agentPlatform: "livekit",
      pullProductionCalls: false,
      monitoringApiKeyHint: null,
    });
    expect(await readFile(folderPathsIn(workspace.dir).config, "utf8")).toBe(
      configBefore,
    );
  } finally {
    await Promise.all([platform.close(), workspace.remove()]);
  }
});
