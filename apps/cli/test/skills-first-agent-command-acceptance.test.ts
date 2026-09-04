/** The skills-first Agent and Connection contract through the built CLI. */

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";

import { expect, it, vi } from "vitest";

import {
  createEgmaFolder,
  EMPTY_CONFIG,
  folderPathsIn,
  readConfig,
  writeConfig,
} from "../src/folder/egma-folder.ts";
import { startPlatform, type Platform } from "./support/fixture-platform/index.ts";
import { NOT_AUTHENTICATED } from "./support/fixture-platform/reading.ts";
import {
  CLI_ENTRY,
  makeWorkspace,
  type Workspace,
} from "./support/workspace.ts";

const EGMA_KEY = "egma_sk_skills-first-agent-acceptance";
const RETELL_KEY = "retell-secret-agent-acceptance-WXYZ";
const STALE_RETELL_KEY = "retell-stale-shell-key-DO-NOT-USE";
const LIVEKIT_KEY = "livekit-key-agent-acceptance-ABCD";
const LIVEKIT_SECRET = "livekit-secret-agent-acceptance-WXYZ";
const STALE_LIVEKIT_KEY = "livekit-stale-shell-key-DO-NOT-USE";
const STALE_LIVEKIT_SECRET = "livekit-stale-shell-secret-DO-NOT-USE";
const TOKEN_HEADER = "Bearer token-endpoint-acceptance-secret";

type Result = {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
};

async function egma(
  workspace: Workspace,
  args: readonly string[],
  options: {
    readonly input?: string;
    readonly env?: NodeJS.ProcessEnv;
  } = {},
): Promise<Result> {
  const child = spawn(process.execPath, [CLI_ENTRY, ...args], {
    cwd: workspace.dir,
    env: workspace.env(options.env),
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
  child.stdin.end(options.input ?? "");
  const code = await new Promise<number>((resolve) => {
    child.on("close", (value) => resolve(value ?? 1));
  });
  return { code, stdout, stderr };
}

async function initialized(
  platform: Platform,
  workspace: Workspace,
): Promise<void> {
  platform.signedInWith(EGMA_KEY);
  await workspace.signIn(platform.url, EGMA_KEY);
  await createEgmaFolder({
    repository: workspace.dir,
    config: {
      ...EMPTY_CONFIG,
      platform: { origin: platform.url },
      project: { id: platform.projectId, name: "Fixture project" },
      agents: [],
    },
  });
}

function didNotPrint(result: Result, secret: string): void {
  expect(result.stdout.includes(secret)).toBe(false);
  expect(result.stderr.includes(secret)).toBe(false);
}

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

it("registers Agent identity, then adds and reuses a Retell binding and key", async () => {
  const [platform, workspace] = await Promise.all([
    startPlatform(),
    makeWorkspace(),
  ]);
  try {
    await initialized(platform, workspace);

    const beforeOldCommand = platform.records.length;
    const oldCommand = await egma(workspace, [
      "agent",
      "register",
      "--platform",
      "retell",
      "--access",
      "retell-api-key",
      "--modality",
      "chat",
    ]);
    expect(oldCommand.code).toBe(1);
    expect(platform.records).toHaveLength(beforeOldCommand);
    expect(`${oldCommand.stdout}${oldCommand.stderr}`).toContain(
      "--access",
    );

    const registered = await egma(workspace, [
      "agent",
      "register",
      "--platform",
      "retell",
      "--name",
      "Front desk",
    ]);
    expect(registered.code, registered.stderr).toBe(0);
    const agentId = platform.registered.agents[0]?.id ?? "";
    expect(agentId).toMatch(/^agt_/u);

    const registration = platform.records.find(
      (record) =>
        record.method === "POST" && record.path === "/v1/agents",
    );
    expect(registration?.body).toEqual({
      name: "Front desk",
      agentPlatform: "retell",
    });
    expect(new URLSearchParams(registration?.query ?? "").get("projectId")).toBe(
      platform.projectId,
    );
    expect(platform.registered.projectsNamed).toEqual([platform.projectId]);

    const afterRegistration = await readConfig(
      folderPathsIn(workspace.dir).config,
    );
    expect(afterRegistration.agents).toEqual([
      {
        id: agentId,
        name: "Front desk",
        platform: "retell",
        connections: [],
      },
    ]);

    const duplicate = await egma(workspace, [
      "agent",
      "register",
      "--platform",
      "retell",
      "--name",
      "Front desk",
    ]);
    expect(duplicate.code).toBe(1);
    expect(duplicate.stderr.split("\n")[0]).toBe(
      'an agent named "Front desk" already exists in this project',
    );
    expect(duplicate.stderr).toContain("Choose another --name.");

    platform.registered.retellAccount(RETELL_KEY, [
      {
        id: "retell_agent_front_desk",
        name: "Front desk",
        modality: "voice",
        phoneNumbers: ["+14155550100"],
      },
      {
        id: "retell_agent_chat_native",
        name: "Chat native",
        modality: "chat",
      },
    ]);

    const listed = await egma(
      workspace,
      ["agent", "connection", "options", "--platform", "retell"],
      { env: { EGMA_RETELL_API_KEY: RETELL_KEY } },
    );
    expect(listed.code, listed.stderr).toBe(0);
    expect(listed.stdout).toContain(
      "Front desk (retell_agent_front_desk)",
    );
    expect(listed.stdout).toContain(
      "Chat native (retell_agent_chat_native)",
    );
    expect(listed.stdout).toContain("Phone numbers: +14155550100");
    expect(listed.stdout).toContain(
      "First Retell Connection verification: EGMA_RETELL_API_KEY",
    );
    expect(listed.stdout).toContain(
      "egma agent connection add --agent '<Egma Agent ID>'",
    );
    didNotPrint(listed, RETELL_KEY);

    const beforeFirstConnection = platform.records.length;
    const firstConnection = await egma(
      workspace,
      [
        "agent",
        "connection",
        "add",
        "--agent",
        agentId,
        "--access",
        "retell-api-key",
        "--modality",
        "chat",
        "--name",
        "Fast text",
        "--retell-agent",
        "retell_agent_front_desk",
        "--credentials-stdin",
      ],
      {
        input: JSON.stringify({ apiKey: RETELL_KEY }),
        env: { EGMA_RETELL_API_KEY: STALE_RETELL_KEY },
      },
    );
    expect(firstConnection.code, firstConnection.stderr).toBe(0);
    expect(firstConnection.stdout).toContain('Using Agent "Front desk"');
    expect(firstConnection.stdout).not.toContain('Registered Agent "Front desk"');
    didNotPrint(firstConnection, RETELL_KEY);
    didNotPrint(firstConnection, STALE_RETELL_KEY);

    const firstRequests = platform.records.slice(beforeFirstConnection);
    expect(firstRequests.map((record) => `${record.method} ${record.path}`)).toEqual([
      `GET /v1/agents/${agentId}`,
      "GET /v1/connection-options",
      "POST /v1/agents:discover",
      `POST /v1/agents/${agentId}/connections`,
      "GET /v1/agents",
    ]);
    expect(firstRequests[0]?.query).toBe(`?projectId=${platform.projectId}`);
    expect(firstRequests[3]?.query).toBe(`?projectId=${platform.projectId}`);
    const firstDiscovery = firstRequests[2];
    expect(firstDiscovery?.body).toMatchObject({ agentPlatform: "retell" });
    expect(
      ((firstDiscovery?.body?.["credentials"] as
        | Record<string, unknown>
        | undefined)?.["apiKey"] ?? null) === RETELL_KEY,
    ).toBe(true);
    expect(new URLSearchParams(firstDiscovery?.query ?? "").get("projectId")).toBe(
      platform.projectId,
    );

    const firstWrite = firstRequests[3]?.body ?? {};
    const { credentials: firstCredentials, ...safeFirstWrite } = firstWrite;
    expect(safeFirstWrite).toEqual({
      name: "Fast text",
      agentPlatform: "retell",
      connectionType: "retell_text_mode",
      accessVariant: "retell_text_mode.api_key",
      modality: "chat",
      config: { retellAgentId: "retell_agent_front_desk" },
      platformAgentId: "retell_agent_front_desk",
    });
    expect(
      ((firstCredentials as Record<string, unknown> | undefined)?.["apiKey"] ??
        null) === RETELL_KEY,
    ).toBe(true);
    expect(platform.registered.sealed.includes(RETELL_KEY)).toBe(true);
    expect(platform.registered.agents[0]).toMatchObject({
      id: agentId,
      platformAgentId: "retell_agent_front_desk",
      monitoringApiKeyHint: "WXYZ",
    });

    const beforeSecondConnection = platform.records.length;
    const secondConnection = await egma(workspace, [
      "agent",
      "connection",
      "add",
      "--agent",
      agentId,
      "--access",
      "retell-api-key",
      "--modality",
      "voice",
      "--name",
      "Web call",
      "--retell-agent",
      "retell_agent_front_desk",
    ]);
    expect(secondConnection.code, secondConnection.stderr).toBe(0);
    didNotPrint(secondConnection, RETELL_KEY);

    const secondRequests = platform.records.slice(beforeSecondConnection);
    expect(secondRequests.map((record) => `${record.method} ${record.path}`)).toEqual([
      `GET /v1/agents/${agentId}`,
      "GET /v1/connection-options",
      "POST /v1/agents:discover",
      `POST /v1/agents/${agentId}/connections`,
      "GET /v1/agents",
    ]);
    expect(secondRequests[0]?.query).toBe(`?projectId=${platform.projectId}`);
    expect(secondRequests[3]?.query).toBe(`?projectId=${platform.projectId}`);
    expect(secondRequests[2]?.body).toEqual({
      agentPlatform: "retell",
      agentId,
    });
    expect(
      new URLSearchParams(secondRequests[2]?.query ?? "").get("projectId"),
    ).toBe(platform.projectId);
    expect(secondRequests[3]?.body).not.toHaveProperty("credentials");
    expect(secondRequests[3]?.body).toMatchObject({
      name: "Web call",
      platformAgentId: "retell_agent_front_desk",
      connectionType: "retell_web_call",
      accessVariant: "retell_web_call.api_key",
      modality: "voice",
    });

    const configDocument = await readFile(
      folderPathsIn(workspace.dir).config,
      "utf8",
    );
    expect(configDocument.includes(RETELL_KEY)).toBe(false);
    expect(configDocument).not.toContain("retell_agent_front_desk");
    const finalConfig = await readConfig(folderPathsIn(workspace.dir).config);
    expect(finalConfig.agents[0]?.connections).toHaveLength(2);
  } finally {
    await Promise.all([platform.close(), workspace.remove()]);
  }
});

it("uses a one-time Retell key to bind a first phone Connection without storing it on the Connection", async () => {
  const [platform, workspace] = await Promise.all([
    startPlatform(),
    makeWorkspace(),
  ]);
  try {
    await initialized(platform, workspace);
    const registered = await egma(workspace, [
      "agent",
      "register",
      "--platform",
      "retell",
      "--name",
      "Phone desk",
    ]);
    expect(registered.code, registered.stderr).toBe(0);
    const agentId = platform.registered.agents[0]?.id ?? "";

    platform.registered.retellAccount(RETELL_KEY, [
      {
        id: "retell_agent_phone_desk",
        name: "Phone desk",
        modality: "voice",
        phoneNumbers: ["+14155550101"],
      },
    ]);

    const before = platform.records.length;
    const added = await egma(
      workspace,
      [
        "agent",
        "connection",
        "add",
        "--agent",
        agentId,
        "--access",
        "retell-phone-number",
        "--modality",
        "voice",
        "--retell-agent",
        "retell_agent_phone_desk",
        "--retell-phone-number",
        "+14155550101",
        "--credentials-stdin",
      ],
      {
        input: JSON.stringify({ apiKey: RETELL_KEY }),
        env: { EGMA_RETELL_API_KEY: STALE_RETELL_KEY },
      },
    );

    expect(added.code, added.stderr).toBe(0);
    expect(added.stdout).toContain('Added Connection "Retell phone"');
    didNotPrint(added, RETELL_KEY);
    didNotPrint(added, STALE_RETELL_KEY);

    const requests = platform.records.slice(before);
    expect(requests.map((record) => `${record.method} ${record.path}`)).toEqual([
      `GET /v1/agents/${agentId}`,
      "GET /v1/connection-options",
      "POST /v1/agents:discover",
      `POST /v1/agents/${agentId}/connections`,
      "GET /v1/agents",
    ]);
    expect(requests[2]?.body).toEqual({
      agentPlatform: "retell",
      credentials: { apiKey: RETELL_KEY },
    });
    expect(requests[3]?.body).toMatchObject({
      name: "Retell phone",
      agentPlatform: "retell",
      connectionType: "phone_number",
      accessVariant: "phone_number.public_e164",
      modality: "voice",
      config: { phoneNumber: "+14155550101" },
      platformAgentId: "retell_agent_phone_desk",
    });

    expect(platform.registered.connections).toHaveLength(1);
    expect(platform.registered.connections[0]).toMatchObject({
      agentId,
      connectionType: "phone_number",
      accessVariant: "phone_number.public_e164",
      modality: "voice",
      config: { phoneNumber: "+14155550101" },
      credentials: null,
      credentialsHint: null,
    });
    expect(platform.registered.agents[0]).toMatchObject({
      id: agentId,
      platformAgentId: "retell_agent_phone_desk",
      monitoringApiKeyHint: "WXYZ",
    });
    expect(platform.registered.sealed.includes(RETELL_KEY)).toBe(true);

    const configDocument = await readFile(
      folderPathsIn(workspace.dir).config,
      "utf8",
    );
    expect(configDocument).not.toContain(RETELL_KEY);
    expect(configDocument).not.toContain("retell_agent_phone_desk");
    expect(await readConfig(folderPathsIn(workspace.dir).config)).toEqual({
      format: 4,
      platform: { origin: platform.url },
      project: { id: platform.projectId, name: "Fixture project" },
      agents: [
        {
          id: agentId,
          name: "Phone desk",
          platform: "retell",
          connections: [
            {
              id: platform.registered.connections[0]?.id,
              name: "Retell phone",
            },
          ],
        },
      ],
    });
  } finally {
    await Promise.all([platform.close(), workspace.remove()]);
  }
});

it("adds both LiveKit credential shapes with provider-specific flags", async () => {
  const [platform, workspace] = await Promise.all([
    startPlatform(),
    makeWorkspace(),
  ]);
  try {
    await initialized(platform, workspace);
    const registered = await egma(workspace, [
      "agent",
      "register",
      "--platform",
      "livekit",
      "--name",
      "Receptionist",
    ]);
    expect(registered.code, registered.stderr).toBe(0);
    const agentId = platform.registered.agents[0]?.id ?? "";

    const listed = await egma(workspace, [
      "agent",
      "connection",
      "options",
      "--platform",
      "livekit",
    ]);
    expect(listed.code, listed.stderr).toBe(0);
    expect(listed.stdout).toContain("LiveKit connection options");
    expect(listed.stdout).toContain("Access: livekit-project-credentials");
    expect(listed.stdout).toContain("Access: livekit-token-endpoint");
    expect(listed.stdout).toContain(
      "Your LiveKit project or self-hosted server, like wss://example.livekit.cloud.",
    );
    expect(listed.stdout).toContain(
      "This is the quickest setup. Egma mints its own room tokens",
    );
    expect(listed.stdout).toContain("The LiveKit project's API key.");

    const irrelevantValue =
      "https://do-not-print.example/irrelevant-token-endpoint";
    const beforeIrrelevant = platform.records.length;
    const irrelevant = await egma(workspace, [
      "agent",
      "connection",
      "add",
      "--agent",
      agentId,
      "--access",
      "livekit-project-credentials",
      "--modality",
      "voice",
      "--livekit-url",
      "wss://example.livekit.cloud",
      "--livekit-agent-name",
      "receptionist",
      "--livekit-token-endpoint",
      irrelevantValue,
    ]);
    expect(irrelevant.code).toBe(1);
    expect(irrelevant.stderr).toContain("--livekit-token-endpoint");
    didNotPrint(irrelevant, irrelevantValue);
    expect(
      platform.records.slice(beforeIrrelevant).some(
        (record) =>
          record.method === "POST" &&
          record.path === `/v1/agents/${agentId}/connections`,
      ),
    ).toBe(false);

    const projectCredentials = await egma(
      workspace,
      [
        "agent",
        "connection",
        "add",
        "--agent",
        agentId,
        "--access",
        "livekit-project-credentials",
        "--modality",
        "voice",
        "--livekit-url",
        "wss://example.livekit.cloud",
        "--livekit-agent-name",
        "receptionist",
      ],
      {
        env: {
          EGMA_LIVEKIT_API_KEY: LIVEKIT_KEY,
          EGMA_LIVEKIT_API_SECRET: LIVEKIT_SECRET,
        },
      },
    );
    expect(projectCredentials.code, projectCredentials.stderr).toBe(0);
    didNotPrint(projectCredentials, LIVEKIT_KEY);
    didNotPrint(projectCredentials, LIVEKIT_SECRET);

    const projectWrite = platform.records.find(
      (record) =>
        record.method === "POST" &&
        record.path === `/v1/agents/${agentId}/connections` &&
        record.body?.["name"] === "LiveKit project credentials",
    )?.body;
    const { credentials: projectSecrets, ...safeProjectWrite } =
      projectWrite ?? {};
    expect(safeProjectWrite).toEqual({
      name: "LiveKit project credentials",
      agentPlatform: "livekit",
      connectionType: "livekit_room",
      accessVariant: "livekit_room.project_credentials",
      modality: "voice",
      config: {
        url: "wss://example.livekit.cloud",
        agentName: "receptionist",
      },
    });
    expect(Object.keys((projectSecrets ?? {}) as object).sort()).toEqual([
      "apiKey",
      "apiSecret",
    ]);
    expect(
      ((projectSecrets as Record<string, unknown> | undefined)?.["apiKey"] ??
        null) === LIVEKIT_KEY,
    ).toBe(true);
    expect(
      ((projectSecrets as Record<string, unknown> | undefined)?.[
        "apiSecret"
      ] ?? null) === LIVEKIT_SECRET,
    ).toBe(true);

    const duplicateConnection = await egma(
      workspace,
      [
        "agent",
        "connection",
        "add",
        "--agent",
        agentId,
        "--access",
        "livekit-project-credentials",
        "--modality",
        "voice",
        "--livekit-url",
        "wss://example.livekit.cloud",
        "--livekit-agent-name",
        "receptionist",
      ],
      {
        env: {
          EGMA_LIVEKIT_API_KEY: LIVEKIT_KEY,
          EGMA_LIVEKIT_API_SECRET: LIVEKIT_SECRET,
        },
      },
    );
    expect(duplicateConnection.code).toBe(1);
    expect(duplicateConnection.stderr.split("\n")[0]).toBe(
      'a connection named "LiveKit project credentials" already exists on this agent',
    );
    expect(duplicateConnection.stderr).toContain("Choose another --name.");

    const projectChat = await egma(
      workspace,
      [
        "agent",
        "connection",
        "add",
        "--agent",
        agentId,
        "--access",
        "livekit-project-credentials",
        "--modality",
        "chat",
        "--name",
        "Project chat",
        "--livekit-url",
        "wss://example.livekit.cloud",
        "--livekit-agent-name",
        "receptionist",
        "--credentials-stdin",
      ],
      {
        input: JSON.stringify({
          apiKey: LIVEKIT_KEY,
          apiSecret: LIVEKIT_SECRET,
        }),
        env: {
          EGMA_LIVEKIT_API_KEY: STALE_LIVEKIT_KEY,
          EGMA_LIVEKIT_API_SECRET: STALE_LIVEKIT_SECRET,
        },
      },
    );
    expect(projectChat.code, projectChat.stderr).toBe(0);
    didNotPrint(projectChat, LIVEKIT_KEY);
    didNotPrint(projectChat, LIVEKIT_SECRET);
    didNotPrint(projectChat, STALE_LIVEKIT_KEY);
    didNotPrint(projectChat, STALE_LIVEKIT_SECRET);

    const projectChatWrite = platform.records.find(
      (record) =>
        record.method === "POST" &&
        record.path === `/v1/agents/${agentId}/connections` &&
        record.body?.["name"] === "Project chat",
    )?.body;
    const { credentials: projectChatSecrets, ...safeProjectChatWrite } =
      projectChatWrite ?? {};
    expect(safeProjectChatWrite).toEqual({
      name: "Project chat",
      agentPlatform: "livekit",
      connectionType: "livekit_room",
      accessVariant: "livekit_room.project_credentials",
      modality: "chat",
      config: {
        url: "wss://example.livekit.cloud",
        agentName: "receptionist",
      },
    });
    expect(Object.keys((projectChatSecrets ?? {}) as object).sort()).toEqual([
      "apiKey",
      "apiSecret",
    ]);
    expect(
      ((projectChatSecrets as Record<string, unknown> | undefined)?.["apiKey"] ??
        null) === LIVEKIT_KEY,
    ).toBe(true);
    expect(
      ((projectChatSecrets as Record<string, unknown> | undefined)?.[
        "apiSecret"
      ] ?? null) === LIVEKIT_SECRET,
    ).toBe(true);

    const tokenEndpoint = await egma(
      workspace,
      [
        "agent",
        "connection",
        "add",
        "--agent",
        agentId,
        "--access",
        "livekit-token-endpoint",
        "--modality",
        "voice",
        "--name",
        "Customer token endpoint",
        "--livekit-url",
        "wss://example.livekit.cloud",
        "--livekit-token-endpoint",
        "https://tokens.example.com/egma/livekit",
      ],
      {
        env: {
          EGMA_LIVEKIT_TOKEN_ENDPOINT_HEADERS: JSON.stringify({
            Authorization: TOKEN_HEADER,
          }),
        },
      },
    );
    expect(tokenEndpoint.code, tokenEndpoint.stderr).toBe(0);
    didNotPrint(tokenEndpoint, TOKEN_HEADER);

    const endpointWrite = platform.records.find(
      (record) =>
        record.method === "POST" &&
        record.path === `/v1/agents/${agentId}/connections` &&
        record.body?.["name"] === "Customer token endpoint",
    )?.body;
    const { credentials: endpointSecrets, ...safeEndpointWrite } =
      endpointWrite ?? {};
    expect(safeEndpointWrite).toEqual({
      name: "Customer token endpoint",
      agentPlatform: "livekit",
      connectionType: "livekit_room",
      accessVariant: "livekit_room.customer_token_endpoint",
      modality: "voice",
      config: {
        url: "wss://example.livekit.cloud",
        tokenEndpoint: "https://tokens.example.com/egma/livekit",
      },
    });
    expect(Object.keys((endpointSecrets ?? {}) as object)).toEqual(["headers"]);
    expect(
      String(
        (endpointSecrets as Record<string, unknown> | undefined)?.["headers"] ??
          "",
      ).includes(TOKEN_HEADER),
    ).toBe(true);
    expect(platform.registered.sealed.includes(LIVEKIT_KEY)).toBe(true);
    expect(platform.registered.sealed.includes(LIVEKIT_SECRET)).toBe(true);
    expect(
      platform.registered.sealed.some((value) => value.includes(TOKEN_HEADER)),
    ).toBe(true);

    const configDocument = await readFile(
      folderPathsIn(workspace.dir).config,
      "utf8",
    );
    for (const secret of [LIVEKIT_KEY, LIVEKIT_SECRET, TOKEN_HEADER]) {
      expect(configDocument.includes(secret)).toBe(false);
    }
    const finalConfig = await readConfig(folderPathsIn(workspace.dir).config);
    expect(finalConfig.agents[0]?.connections).toHaveLength(3);
  } finally {
    await Promise.all([platform.close(), workspace.remove()]);
  }
});

it("refuses invalid credential stdin before a Retell or LiveKit Connection write", async () => {
  const [platform, workspace] = await Promise.all([
    startPlatform(),
    makeWorkspace(),
  ]);
  try {
    await initialized(platform, workspace);
    const retellRegistration = await egma(workspace, [
      "agent",
      "register",
      "--platform",
      "retell",
      "--name",
      "Retell desk",
    ]);
    expect(retellRegistration.code, retellRegistration.stderr).toBe(0);
    const livekitRegistration = await egma(workspace, [
      "agent",
      "register",
      "--platform",
      "livekit",
      "--name",
      "LiveKit desk",
    ]);
    expect(livekitRegistration.code, livekitRegistration.stderr).toBe(0);
    const retellAgentId =
      platform.registered.agents.find((agent) => agent.name === "Retell desk")
        ?.id ?? "";
    const livekitAgentId =
      platform.registered.agents.find((agent) => agent.name === "LiveKit desk")
        ?.id ?? "";

    const malformedRetellSecret = "retell-malformed-stdin-secret-NEVER-PRINT";
    const beforeRetell = platform.records.length;
    const retell = await egma(
      workspace,
      [
        "agent",
        "connection",
        "add",
        "--agent",
        retellAgentId,
        "--access",
        "retell-api-key",
        "--modality",
        "chat",
        "--retell-agent",
        "retell_agent_bad_stdin",
        "--credentials-stdin",
      ],
      { input: `{"apiKey":"${malformedRetellSecret}"` },
    );
    expect(retell.code).toBe(1);
    didNotPrint(retell, malformedRetellSecret);
    expect(
      platform.records.slice(beforeRetell).some(
        (record) =>
          record.method === "POST" &&
          record.path === `/v1/agents/${retellAgentId}/connections`,
      ),
    ).toBe(false);

    const incorrectLivekitKey = "livekit-incorrect-stdin-key-NEVER-PRINT";
    const incorrectLivekitSecret =
      "livekit-incorrect-stdin-secret-NEVER-PRINT";
    const beforeLivekit = platform.records.length;
    const livekit = await egma(
      workspace,
      [
        "agent",
        "connection",
        "add",
        "--agent",
        livekitAgentId,
        "--access",
        "livekit-project-credentials",
        "--modality",
        "voice",
        "--livekit-url",
        "wss://example.livekit.cloud",
        "--livekit-agent-name",
        "livekit-desk",
        "--credentials-stdin",
      ],
      {
        input: JSON.stringify({
          apiKey: incorrectLivekitKey,
          apiSecret: { secret: incorrectLivekitSecret },
        }),
      },
    );
    expect(livekit.code).toBe(1);
    didNotPrint(livekit, incorrectLivekitKey);
    didNotPrint(livekit, incorrectLivekitSecret);
    expect(
      platform.records.slice(beforeLivekit).some(
        (record) =>
          record.method === "POST" &&
          record.path === `/v1/agents/${livekitAgentId}/connections`,
      ),
    ).toBe(false);

    const secretCredentialKey = "credential-key-secret-NEVER-PRINT\nnext-line";
    const beforeUnknownCredential = platform.records.length;
    const unknownCredential = await egma(
      workspace,
      [
        "agent",
        "connection",
        "add",
        "--agent",
        livekitAgentId,
        "--access",
        "livekit-project-credentials",
        "--modality",
        "voice",
        "--livekit-url",
        "wss://example.livekit.cloud",
        "--livekit-agent-name",
        "livekit-desk",
        "--credentials-stdin",
      ],
      {
        input: JSON.stringify({
          apiKey: LIVEKIT_KEY,
          apiSecret: LIVEKIT_SECRET,
          [secretCredentialKey]: "not-a-supported-field",
        }),
      },
    );
    expect(unknownCredential.code).toBe(1);
    expect(unknownCredential.stderr).toContain(
      "Credentials on standard input contain unsupported fields.",
    );
    didNotPrint(unknownCredential, secretCredentialKey);
    didNotPrint(unknownCredential, "credential-key-secret-NEVER-PRINT");
    expect(
      platform.records.slice(beforeUnknownCredential).some(
        (record) =>
          record.method === "POST" &&
          record.path === `/v1/agents/${livekitAgentId}/connections`,
      ),
    ).toBe(false);

    const configDocument = await readFile(
      folderPathsIn(workspace.dir).config,
      "utf8",
    );
    for (const secret of [
      malformedRetellSecret,
      incorrectLivekitKey,
      incorrectLivekitSecret,
      "credential-key-secret-NEVER-PRINT",
    ]) {
      expect(configDocument.includes(secret)).toBe(false);
    }
  } finally {
    await Promise.all([platform.close(), workspace.remove()]);
  }
});

it("prints the exact platform refusal before local guidance for a missing Agent", async () => {
  const [platform, workspace] = await Promise.all([
    startPlatform(),
    makeWorkspace(),
  ]);
  try {
    await initialized(platform, workspace);
    const paths = folderPathsIn(workspace.dir);
    const config = await readConfig(paths.config);
    const missingAgentId = "agt_missing_agent";
    await writeConfig(paths.config, {
      ...config,
      agents: [
        {
          id: missingAgentId,
          name: "Gone",
          platform: "livekit",
          connections: [],
        },
      ],
    });

    const result = await egma(workspace, [
      "agent",
      "connection",
      "add",
      "--agent",
      missingAgentId,
      "--access",
      "livekit-project-credentials",
      "--modality",
      "voice",
    ]);

    expect(result.code).toBe(1);
    expect(result.stderr.split("\n")[0]).toBe(
      "no agent of yours has that id. Check the id, or list your agents with GET /v1/agents.",
    );
    expect(result.stderr).toContain("Run egma pull");
  } finally {
    await Promise.all([platform.close(), workspace.remove()]);
  }
});

it.each([
  {
    label: "unknown option",
    option: {
      agentPlatform: "livekit",
      agentPlatformLabel: "LiveKit",
      connectionType: "future_room",
      accessVariant: "future_room.magic",
      accessVariantLabel: "Future access",
      modality: "voice",
      productLabel: "Future private label",
      topology: "agent-dials-out",
      simulatorAdapter: true,
      usesPlatformCarrier: false,
      fields: [],
      credentialRule: "forbidden",
      credentialHelp: "None.",
      credentialFields: [],
    },
  },
  {
    label: "unknown field",
    option: {
      agentPlatform: "livekit",
      agentPlatformLabel: "LiveKit",
      connectionType: "livekit_room",
      accessVariant: "livekit_room.project_credentials",
      accessVariantLabel: "Project credentials",
      modality: "voice",
      productLabel: "Future private label",
      topology: "agent-dials-out",
      simulatorAdapter: true,
      usesPlatformCarrier: false,
      fields: [
        {
          key: "futureField",
          label: "Future field",
          kind: "text",
          required: true,
          help: "A future server field.",
          afterCredentials: false,
        },
      ],
      credentialRule: "required",
      credentialHelp: "Stored sealed.",
      credentialFields: [
        {
          field: "apiKey",
          label: "API key",
          kind: "secret",
          required: true,
          help: "The key.",
        },
        {
          field: "apiSecret",
          label: "API secret",
          kind: "secret",
          required: true,
          help: "The secret.",
        },
      ],
    },
  },
  {
    label: "unknown credential field",
    option: {
      agentPlatform: "livekit",
      agentPlatformLabel: "LiveKit",
      connectionType: "livekit_room",
      accessVariant: "livekit_room.project_credentials",
      accessVariantLabel: "Project credentials",
      modality: "voice",
      productLabel: "Future private label",
      topology: "agent-dials-out",
      simulatorAdapter: true,
      usesPlatformCarrier: false,
      fields: [
        {
          key: "url",
          label: "LiveKit URL",
          kind: "url",
          required: true,
          help: "The LiveKit server.",
          afterCredentials: false,
        },
        {
          key: "agentName",
          label: "LiveKit Agent name",
          kind: "text",
          required: true,
          help: "The Agent name.",
          afterCredentials: false,
        },
      ],
      credentialRule: "required",
      credentialHelp: "Stored sealed.",
      credentialFields: [
        {
          field: "futureSecret",
          label: "Future secret",
          kind: "secret",
          required: true,
          help: "A future server credential.",
        },
      ],
    },
  },
])("refuses a server catalog with an $label", async ({ option }) => {
  const [platform, workspace] = await Promise.all([
    startPlatform({ connectionOptions: [option] }),
    makeWorkspace(),
  ]);
  try {
    await initialized(platform, workspace);
    const result = await egma(workspace, [
      "agent",
      "connection",
      "options",
      "--platform",
      "livekit",
    ]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      "Egma returned a Connection option this CLI does not understand. Update egma-cli, then try again.",
    );
    expect(result.stdout).not.toContain("Future private label");
  } finally {
    await Promise.all([platform.close(), workspace.remove()]);
  }
});

it("lets the server catalog make a known Connection credential optional", async () => {
  const optionalProjectCredentials = {
    agentPlatform: "livekit",
    agentPlatformLabel: "LiveKit",
    connectionType: "livekit_room",
    accessVariant: "livekit_room.project_credentials",
    accessVariantLabel: "Project credentials",
    modality: "voice",
    productLabel: "LiveKit voice",
    topology: "agent-dials-out",
    simulatorAdapter: true,
    usesPlatformCarrier: false,
    fields: [
      {
        key: "url",
        label: "LiveKit URL",
        kind: "url",
        required: true,
        help: "The LiveKit server.",
        afterCredentials: false,
      },
      {
        key: "agentName",
        label: "LiveKit Agent name",
        kind: "text",
        required: true,
        help: "The Agent name.",
        afterCredentials: false,
      },
    ],
    credentialRule: "optional",
    credentialHelp: "Credentials may be omitted for this platform deployment.",
    credentialFields: [
      {
        field: "apiKey",
        label: "API key",
        kind: "secret",
        required: true,
        help: "The key when this deployment needs one.",
      },
      {
        field: "apiSecret",
        label: "API secret",
        kind: "secret",
        required: true,
        help: "The secret when this deployment needs one.",
      },
    ],
  } as const;
  const [platform, workspace] = await Promise.all([
    startPlatform({ connectionOptions: [optionalProjectCredentials] }),
    makeWorkspace(),
  ]);
  try {
    await initialized(platform, workspace);
    const listed = await egma(workspace, [
      "agent",
      "connection",
      "options",
      "--platform",
      "livekit",
    ]);
    expect(listed.code, listed.stderr).toBe(0);
    expect(listed.stdout).toContain("The LiveKit server.");
    expect(listed.stdout).toContain(
      "Credentials may be omitted for this platform deployment.",
    );
    expect(listed.stdout).toContain("The key when this deployment needs one.");
    expect(listed.stdout).toContain("Connection credential: optional");

    const registered = await egma(workspace, [
      "agent",
      "register",
      "--platform",
      "livekit",
      "--name",
      "Receptionist",
    ]);
    expect(registered.code, registered.stderr).toBe(0);
    const agentId = platform.registered.agents[0]?.id ?? "";
    const before = platform.records.length;

    const result = await egma(workspace, [
      "agent",
      "connection",
      "add",
      "--agent",
      agentId,
      "--access",
      "livekit-project-credentials",
      "--modality",
      "voice",
      "--livekit-url",
      "wss://fixture.livekit.cloud",
      "--livekit-agent-name",
      "receptionist",
    ]);

    // The fixture's normal write contract still requires the key pair, so it
    // refuses this artificial catalog. The important client contract is that
    // server-owned optionality let the request reach that boundary without a
    // locally invented credentials requirement.
    expect(result.code).toBe(1);
    const write = platform.records
      .slice(before)
      .find(
        (record) =>
          record.method === "POST" &&
          record.path === `/v1/agents/${agentId}/connections`,
      );
    expect(write).toBeDefined();
    expect(write?.body).not.toHaveProperty("credentials");
  } finally {
    await Promise.all([platform.close(), workspace.remove()]);
  }
});

it("relays the platform's exact 401 sentence from Connection options", async () => {
  const [platform, workspace] = await Promise.all([
    startPlatform(),
    makeWorkspace(),
  ]);
  try {
    await initialized(platform, workspace);
    await workspace.signIn(platform.url, "egma_sk_not_valid_here");

    const result = await egma(workspace, [
      "agent",
      "connection",
      "options",
      "--platform",
      "livekit",
    ]);

    expect(result.code).toBe(1);
    expect(result.stderr.split("\n")[0]).toBe(NOT_AUTHENTICATED.message);
    expect(result.stdout).toBe("");
  } finally {
    await Promise.all([platform.close(), workspace.remove()]);
  }
});
