import { readFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  AGENT_MONITORING_EXIT,
  runAgentMonitoringSetupCommand,
  runAgentMonitoringStopCommand,
} from "../src/commands/agent-monitoring.ts";
import { runProjectApiKeyCreateCommand } from "../src/commands/project-api-key.ts";
import {
  EMPTY_CONFIG,
  createEgmaFolder,
  folderPathsIn,
  readConfig,
  writeConfig,
} from "../src/folder/egma-folder.ts";
import { FOLDER_EXIT } from "../src/commands/folder-verbs.ts";
import { makeWorkspace, type Workspace } from "./support/workspace.ts";

const URL = "https://egma.example";
const PROJECT_ID = "prj_01K3XQ7M4E8YB2FVN0H9TZQWER";
const AGENT_ID = "agt_01K3XQ7M4E8YB2FVN0H9TZQWER";
const RETELL_AGENT_ID = "agent_retell_receptionist";

let workspace: Workspace;

class JsonResponse extends Response {
  constructor(value: unknown, init: ResponseInit = {}) {
    const headers = new Headers(init.headers);
    headers.set("content-type", "application/json");
    super(JSON.stringify(value), { ...init, headers });
  }
}

function configFor(platform: "retell" | "livekit") {
  return {
    ...EMPTY_CONFIG,
    platform: { origin: URL },
    project: { id: PROJECT_ID, name: "Northside" },
    agents: [
      {
        id: AGENT_ID,
        name: "Receptionist",
        platform,
        connections: [{ id: "con_primary", name: "Primary" }],
      },
    ],
  } as const;
}

function retellAgent(
  overrides: Partial<{
    platformAgentId: string | null;
    monitoringApiKeyHint: string | null;
  }> = {},
) {
  return {
    agent: {
      id: AGENT_ID,
      name: "Receptionist",
      projectId: PROJECT_ID,
      agentPlatform: "retell",
      platformAgentId: RETELL_AGENT_ID,
      monitoringApiKeyHint: "...1234",
      pullProductionCalls: false,
      lastReceivedAt: null,
      archived: false,
      ...overrides,
    },
    connections: [],
  };
}

beforeEach(async () => {
  workspace = await makeWorkspace();
  await workspace.signIn(URL);
  await createEgmaFolder({
    repository: workspace.dir,
    config: configFor("retell"),
  });
});

afterEach(async () => workspace.remove());

describe("Project API-key resource command", () => {
  it("uses the bound Project, prints the secret once, and stores nothing", async () => {
    const requests: Request[] = [];
    const secret = "egma_sk_only_print_this_once";
    const out: string[] = [];
    const code = await runProjectApiKeyCreateCommand({
      access: { url: URL, credentialsFile: workspace.credentialsFile },
      cwd: workspace.dir,
      name: "Local release",
      out: (line) => out.push(line),
      fail: (line) => out.push(`failure: ${line}`),
      fetchImpl: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        return new JsonResponse(
          {
            id: "key_01K3XQ7M4E8YB2FVN0H9TZQWER",
            name: "Local release",
            scope: "project",
            organizationId: "org_one",
            projectId: PROJECT_ID,
            looksLike: "egma_sk_...once",
            createdByUserId: "usr_one",
            createdAt: "2026-01-01T00:00:00.000Z",
            lastUsedAt: null,
            revokedAt: null,
            secret,
          },
          { status: 201 },
        );
      },
    });

    expect(code).toBe(FOLDER_EXIT.done);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(`${URL}/v1/keys`);
    expect(await requests[0]?.json()).toEqual({
      name: "Local release",
      projectId: PROJECT_ID,
    });
    expect(out).toContain("Created Project API key Local release.");
    expect(out).toContain("Key ID: key_01K3XQ7M4E8YB2FVN0H9TZQWER");
    expect(out).toContain("Copy this key now. Egma CLI does not save it.");
    expect(out.join("\n")).not.toContain("status:");
    expect(out.join("\n").split(secret)).toHaveLength(2);
    expect(
      await readFile(folderPathsIn(workspace.dir).config, "utf8"),
    ).not.toContain(secret);
    expect(await readFile(workspace.credentialsFile, "utf8")).not.toContain(secret);
  });

});

describe("Agent monitoring resource commands", () => {
  it("starts Retell monitoring with the Agent's sealed key", async () => {
    const requests: Request[] = [];
    const bodies: unknown[] = [];
    const out: string[] = [];
    const code = await runAgentMonitoringSetupCommand({
      access: { url: URL, credentialsFile: workspace.credentialsFile },
      cwd: workspace.dir,
      agent: AGENT_ID,
      platform: "retell",
      // Ambient credentials cannot replace the Agent's stored key.
      env: { EGMA_RETELL_API_KEY: "retell_key_that_must_not_be_sent" },
      out: (line) => out.push(line),
      fail: (line) => out.push(`failure: ${line}`),
      fetchImpl: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        if (request.method === "GET") return new JsonResponse(retellAgent());
        bodies.push(await request.json());
        return new JsonResponse({
          watching: [
            {
              agentId: AGENT_ID,
              agentName: "Receptionist",
              platformAgentId: RETELL_AGENT_ID,
              created: false,
              pullProductionCalls: true,
            },
          ],
          refused: [],
        });
      },
    });

    expect(code).toBe(AGENT_MONITORING_EXIT.done);
    expect(requests.map((one) => `${one.method} ${one.url}`)).toEqual([
      `GET ${URL}/v1/agents/${AGENT_ID}?projectId=${PROJECT_ID}`,
      `POST ${URL}/v1/monitoring/start?projectId=${PROJECT_ID}`,
    ]);
    expect(bodies).toEqual([
      {
        agentPlatform: "retell",
        watch: [{ agentId: AGENT_ID, platformAgentId: RETELL_AGENT_ID }],
      },
    ]);
    expect(out).toContain(
      `Retell monitoring is set up for Egma Agent ${AGENT_ID}.`,
    );
    expect(out).toContain(`Retell Agent: ${RETELL_AGENT_ID}`);
  });

  it("binds a bare Retell Agent with a one-time key on standard input", async () => {
    const config = configFor("retell");
    await writeConfig(folderPathsIn(workspace.dir).config, {
      ...config,
      agents: config.agents.map((agent) => ({ ...agent, connections: [] })),
    });
    const oneTimeKey = "retell_key_from_standard_input";
    const bodies: unknown[] = [];
    const code = await runAgentMonitoringSetupCommand({
      access: { url: URL, credentialsFile: workspace.credentialsFile },
      cwd: workspace.dir,
      agent: AGENT_ID,
      platform: "retell",
      retellAgentId: RETELL_AGENT_ID,
      credentialsStdin: true,
      stdin: Readable.from([JSON.stringify({ apiKey: oneTimeKey })]),
      env: {},
      out: () => undefined,
      fail: () => undefined,
      fetchImpl: async (input, init) => {
        const request = new Request(input, init);
        if (request.method === "GET") {
          return new JsonResponse(
            retellAgent({ platformAgentId: null, monitoringApiKeyHint: null }),
          );
        }
        bodies.push(await request.json());
        return new JsonResponse({
          watching: [
            {
              agentId: AGENT_ID,
              agentName: "Receptionist",
              platformAgentId: RETELL_AGENT_ID,
              created: false,
              pullProductionCalls: true,
            },
          ],
          refused: [],
        });
      },
    });

    expect(code).toBe(AGENT_MONITORING_EXIT.done);
    expect(bodies).toEqual([
      {
        agentPlatform: "retell",
        apiKey: oneTimeKey,
        watch: [{ agentId: AGENT_ID, platformAgentId: RETELL_AGENT_ID }],
      },
    ]);
  });

  it("stops Retell monitoring in the bound Project", async () => {
    const requests: Request[] = [];
    const out: string[] = [];
    const code = await runAgentMonitoringStopCommand({
      access: { url: URL, credentialsFile: workspace.credentialsFile },
      cwd: workspace.dir,
      agent: AGENT_ID,
      platform: "retell",
      out: (line) => out.push(line),
      fail: (line) => out.push(`failure: ${line}`),
      fetchImpl: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        return new JsonResponse({
          monitoring: {
            agentId: AGENT_ID,
            pullProductionCalls: false,
            agentPlatform: "retell",
            platformAgentId: RETELL_AGENT_ID,
            monitoringApiKeyHint: "...1234",
            lastReceivedAt: null,
          },
        });
      },
    });

    expect(code).toBe(AGENT_MONITORING_EXIT.done);
    expect(requests.map((one) => `${one.method} ${one.url}`)).toEqual([
      `POST ${URL}/v1/monitoring/agents/${AGENT_ID}/stop?projectId=${PROJECT_ID}`,
    ]);
    expect(out).toContain(
      `Stopped pulling future Retell calls for Egma Agent ${AGENT_ID}. Existing traces were kept.`,
    );
  });

  it("hands LiveKit setup and removal to the integration skill without a request", async () => {
    const configFile = folderPathsIn(workspace.dir).config;
    await writeConfig(configFile, configFor("livekit"));
    const before = await readConfig(configFile);
    let requests = 0;
    const setup: string[] = [];
    const stop: string[] = [];
    const shared = {
      access: { url: URL, credentialsFile: workspace.credentialsFile },
      cwd: workspace.dir,
      agent: AGENT_ID,
      fail: (line: string) => setup.push(`failure: ${line}`),
      fetchImpl: async () => {
        requests += 1;
        throw new Error("LiveKit handoff must not contact Egma");
      },
    };

    expect(
      await runAgentMonitoringSetupCommand({
        ...shared,
        platform: "livekit",
        out: (line) => setup.push(line),
      }),
    ).toBe(AGENT_MONITORING_EXIT.failed);
    expect(
      await runAgentMonitoringStopCommand({
        ...shared,
        platform: "livekit",
        out: (line) => stop.push(line),
        fail: (line) => stop.push(`failure: ${line}`),
      }),
    ).toBe(AGENT_MONITORING_EXIT.failed);

    expect(requests).toBe(0);
    expect(setup).toContain(
      "  npx --yes skills add egma-ai/egma --skill integrate-egma",
    );
    expect(setup.join("\n")).toContain("LiveKit monitoring setup");
    expect(stop.join("\n")).toContain("LiveKit monitoring removal");
    expect(await readConfig(configFile)).toEqual(before);
  });

  it("refuses a platform that does not match the selected Agent", async () => {
    let requests = 0;
    const output: string[] = [];
    const shared = {
      access: { url: URL, credentialsFile: workspace.credentialsFile },
      cwd: workspace.dir,
      agent: AGENT_ID,
      platform: "livekit",
      out: (line: string) => output.push(line),
      fail: (line: string) => output.push(`failure: ${line}`),
      fetchImpl: async () => {
        requests += 1;
        throw new Error("A platform mismatch must not contact Egma");
      },
    };

    expect(await runAgentMonitoringSetupCommand(shared)).toBe(1);
    expect(await runAgentMonitoringStopCommand(shared)).toBe(1);
    expect(requests).toBe(0);
    expect(
      output.filter(
        (line) =>
          line ===
          `failure: Agent ${AGENT_ID} uses retell, not livekit. Nothing was changed.`,
      ),
    ).toHaveLength(2);
    expect(output.join("\n")).not.toContain("status:");
  });
});
