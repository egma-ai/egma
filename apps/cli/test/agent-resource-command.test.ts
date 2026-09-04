import { Readable } from "node:stream";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  runAgentConnectionAddCommand,
  runAgentConnectionOptionsCommand,
  runAgentRegisterCommand,
} from "../src/commands/agent.ts";
import {
  CONFIG_FORMAT,
  createEgmaFolder,
  folderPathsIn,
  readConfig,
  writeConfig,
} from "../src/folder/egma-folder.ts";
import { makeWorkspace, type Workspace } from "./support/workspace.ts";

const URL = "https://egma.example";
const PROJECT_ID = "prj_project";
const AGENT_ID = "agt_agent";
const CONTROL_KEY = "egma_sk_control";
const RETELL_KEY = "retell-secret-value";

const RETELL_CHAT = {
  agentPlatform: "retell",
  agentPlatformLabel: "Retell",
  connectionType: "retell_text_mode",
  accessVariant: "retell_text_mode.api_key",
  accessVariantLabel: "Retell API key",
  modality: "chat",
  productLabel: "Retell text mode",
  topology: "hosted-broker",
  simulatorAdapter: true,
  fields: [{ key: "retellAgentId", label: "Retell Agent ID", kind: "text", required: true, help: "Provider Agent ID.", afterCredentials: false }],
  credentialRule: "required",
  credentialHelp: "Stored sealed.",
  credentialFields: [{ field: "apiKey", label: "Retell API key", kind: "secret", required: true, help: "Account key." }],
} as const;

const RETELL_WEB = {
  ...RETELL_CHAT,
  connectionType: "retell_web_call",
  accessVariant: "retell_web_call.api_key",
  modality: "voice",
  productLabel: "Retell web call",
} as const;

const RETELL_PHONE = {
  ...RETELL_CHAT,
  connectionType: "phone_number",
  accessVariant: "phone_number.public_e164",
  modality: "voice",
  productLabel: "Retell phone",
  fields: [{ key: "phoneNumber", label: "Phone number", kind: "e164", required: true, help: "E.164 number.", afterCredentials: false }],
  credentialRule: "forbidden",
  credentialFields: [],
} as const;

function livekitOption(
  access: "project_credentials" | "customer_token_endpoint",
  modality: "voice" | "chat",
) {
  const token = access === "customer_token_endpoint";
  return {
    agentPlatform: "livekit",
    agentPlatformLabel: "LiveKit",
    connectionType: "livekit_room",
    accessVariant: `livekit_room.${access}`,
    accessVariantLabel: token ? "Customer token endpoint" : "Project credentials",
    modality,
    productLabel: token ? "LiveKit token endpoint" : "LiveKit project credentials",
    topology: "agent-dials-out",
    simulatorAdapter: true,
    fields: token
      ? [
          { key: "tokenEndpoint", label: "Token endpoint", kind: "url", required: true, help: "Public HTTPS endpoint.", afterCredentials: false },
          { key: "agentName", label: "LiveKit Agent name", kind: "text", required: true, help: "Worker name.", afterCredentials: false },
        ]
      : [
          { key: "url", label: "LiveKit URL", kind: "url", required: true, help: "LiveKit server.", afterCredentials: false },
          { key: "agentName", label: "LiveKit Agent name", kind: "text", required: true, help: "Worker name.", afterCredentials: false },
        ],
    credentialRule: "required",
    credentialHelp: "Stored sealed.",
    credentialFields: token
      ? [{ field: "headers", label: "Auth headers", kind: "json", required: true, help: "Endpoint headers." }]
      : [
          { field: "apiKey", label: "API key", kind: "secret", required: true, help: "Project key." },
          { field: "apiSecret", label: "API secret", kind: "secret", required: true, help: "Project secret." },
        ],
  } as const;
}

class JsonResponse extends Response {
  constructor(body: unknown, status = 200) {
    super(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }
}

let workspace: Workspace;

beforeEach(async () => {
  workspace = await makeWorkspace();
  await createEgmaFolder({
    repository: workspace.dir,
    config: {
      format: CONFIG_FORMAT,
      platform: { origin: URL },
      project: { id: PROJECT_ID, name: "Fixture Project" },
      agents: [],
    },
  });
});

afterEach(async () => workspace.remove());

function output() {
  const out: string[] = [];
  const fail: string[] = [];
  return { out, fail, say: (line: string) => out.push(line), complain: (line: string) => fail.push(line) };
}

function base(io: ReturnType<typeof output>) {
  return {
    access: { url: URL, credentialsFile: workspace.credentialsFile },
    cwd: workspace.dir,
    credentialsStdin: false,
    env: { EGMA_API_KEY: CONTROL_KEY },
    signal: new AbortController().signal,
    out: io.say,
    fail: io.complain,
  } as const;
}

function agent(platform: "retell" | "livekit", monitoringKeyPresent = false) {
  return {
    id: AGENT_ID,
    name: "Receptionist",
    projectId: PROJECT_ID,
    agentPlatform: platform,
    platformAgentId: monitoringKeyPresent ? "agent_retell" : null,
    monitoringKeyPresent,
  } as const;
}

async function putLocalAgent(platform: "retell" | "livekit"): Promise<void> {
  const paths = folderPathsIn(workspace.dir);
  const config = await readConfig(paths.config);
  await writeConfig(paths.config, {
    ...config,
    agents: [{ id: AGENT_ID, name: "Receptionist", platform, connections: [] }],
  });
}

describe("skills-first Agent commands", () => {
  it("prints server-owned options, Retell Agent IDs, and phone numbers", async () => {
    const retellIo = output();
    const retellCode = await runAgentConnectionOptionsCommand({
      ...base(retellIo),
      platform: "retell",
      agentId: null,
      env: { EGMA_API_KEY: CONTROL_KEY, EGMA_RETELL_API_KEY: RETELL_KEY },
      fetchImpl: async (input, init) => {
        const request = new globalThis.URL(String(input));
        if (request.pathname === "/v1/connection-options") {
          return new JsonResponse({ items: [RETELL_CHAT, RETELL_PHONE] });
        }
        expect(request.pathname).toBe("/v1/agents:discover");
        expect(JSON.parse(String(init?.body))).toMatchObject({ credentials: { apiKey: RETELL_KEY } });
        return new JsonResponse({
          agents: [
            {
              platformAgentId: "agent_first",
              name: "First desk",
              modality: "voice",
              connectionCandidates: [
                { agentPlatform: "retell", connectionType: "retell_text_mode", accessVariant: "retell_text_mode.api_key", modality: "chat", productLabel: "Retell text mode", config: { retellAgentId: "agent_first" } },
                { agentPlatform: "retell", connectionType: "phone_number", accessVariant: "phone_number.public_e164", modality: "voice", productLabel: "Retell phone", config: { phoneNumber: "+14155550100" } },
              ],
            },
            { platformAgentId: "agent_second", name: "Second desk", modality: "voice", connectionCandidates: [] },
          ],
        });
      },
    });
    const retellOutput = retellIo.out.join("\n");
    expect(retellCode).toBe(0);
    expect(retellOutput.match(/agent_first/gu)).toHaveLength(1);
    expect(retellOutput.match(/agent_second/gu)).toHaveLength(1);
    expect(retellOutput).toContain("Phone numbers: +14155550100");
    expect(retellOutput).toContain("--retell-phone-number '<Phone number>'");

    const livekitIo = output();
    const livekitCode = await runAgentConnectionOptionsCommand({
      ...base(livekitIo),
      platform: "livekit",
      agentId: null,
      fetchImpl: async () =>
        new JsonResponse({
          items: [
            livekitOption("project_credentials", "voice"),
            livekitOption("project_credentials", "chat"),
            livekitOption("customer_token_endpoint", "voice"),
            livekitOption("customer_token_endpoint", "chat"),
          ],
        }),
    });
    const livekitOutput = livekitIo.out.join("\n");
    expect(livekitCode).toBe(0);
    expect(livekitOutput).toContain("Access: livekit-project-credentials");
    expect(livekitOutput).toContain("Access: livekit-token-endpoint");
    expect(livekitOutput).toContain("LiveKit token endpoint (voice)");
    expect(livekitOutput).toContain("LiveKit token endpoint (chat)");
    expect(livekitOutput).toContain("--livekit-token-endpoint '<Token endpoint>'");
    expect(livekitOutput).not.toContain("--livekit-url '<LiveKit URL>' --livekit-token-endpoint");
  });

  it("registers only Agent identity and refreshes config.yaml", async () => {
    const io = output();
    const receipt = agent("retell");
    let body: Record<string, unknown> | undefined;
    const code = await runAgentRegisterCommand({
      ...base(io),
      platform: "retell",
      name: "Receptionist",
      fetchImpl: async (input, init) => {
        const request = new globalThis.URL(String(input));
        if (init?.method === "POST") {
          body = JSON.parse(String(init.body)) as Record<string, unknown>;
          return new JsonResponse({ result: "created", agent: receipt }, 201);
        }
        expect(request.pathname).toBe("/v1/agents");
        return new JsonResponse({ agents: [{ ...receipt, connections: [] }], nextPageToken: null });
      },
    });
    expect(code).toBe(0);
    expect(body).toEqual({ name: "Receptionist", agentPlatform: "retell" });
    expect(body).not.toHaveProperty("connection");
    expect((await readConfig(folderPathsIn(workspace.dir).config)).agents).toEqual([
      { id: AGENT_ID, name: "Receptionist", platform: "retell", connections: [] },
    ]);
  });

  it("uses a one-time Retell key once, then reuses the stored binding", async () => {
    await putLocalAgent("retell");
    const io = output();
    const connections: Record<string, unknown>[] = [];
    const writes: Record<string, unknown>[] = [];
    const discoveries: Record<string, unknown>[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const request = new globalThis.URL(String(input));
      if (request.pathname === `/v1/agents/${AGENT_ID}`) {
        return new JsonResponse({ agent: agent("retell", connections.length > 0), connections });
      }
      if (request.pathname === "/v1/connection-options") {
        return new JsonResponse({ items: [RETELL_CHAT, RETELL_WEB] });
      }
      if (request.pathname === "/v1/agents:discover") {
        discoveries.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new JsonResponse({
          agents: [{
            platformAgentId: "agent_retell",
            name: "Receptionist",
            modality: "voice",
            connectionCandidates: [
              { agentPlatform: "retell", connectionType: "retell_text_mode", accessVariant: "retell_text_mode.api_key", modality: "chat", productLabel: "Retell text mode", config: { retellAgentId: "agent_retell" } },
              { agentPlatform: "retell", connectionType: "retell_web_call", accessVariant: "retell_web_call.api_key", modality: "voice", productLabel: "Retell web call", config: { retellAgentId: "agent_retell" } },
            ],
          }],
        });
      }
      if (request.pathname === `/v1/agents/${AGENT_ID}/connections`) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        writes.push(body);
        const connection = { id: `con_${writes.length}`, agentId: AGENT_ID, projectId: PROJECT_ID, productLabel: "Retell", credentialsHint: "alue", ...body };
        connections.push(connection);
        return new JsonResponse({ connection }, 201);
      }
      return new JsonResponse({ agents: [{ ...agent("retell", true), connections }], nextPageToken: null });
    };
    const common = {
      ...base(io), agentId: AGENT_ID, accessMethod: "retell-api-key", name: null,
      retellPhoneNumber: null, livekitUrl: null, livekitAgentName: null, livekitTokenEndpoint: null, fetchImpl,
    } as const;
    expect(await runAgentConnectionAddCommand({
      ...common,
      modality: "chat",
      retellAgentId: "agent_retell",
      credentialsStdin: true,
      stdin: Readable.from([JSON.stringify({ apiKey: RETELL_KEY })]),
    })).toBe(0);
    expect(await runAgentConnectionAddCommand({
      ...common,
      modality: "voice",
      retellAgentId: null,
      credentialsStdin: false,
    })).toBe(0);
    expect(discoveries[0]).toMatchObject({ credentials: { apiKey: RETELL_KEY } });
    expect(discoveries[1]).toEqual({ agentPlatform: "retell", agentId: AGENT_ID });
    expect(writes[0]).toHaveProperty("credentials", { apiKey: RETELL_KEY });
    expect(writes[1]).not.toHaveProperty("credentials");
    expect(JSON.stringify(await readConfig(folderPathsIn(workspace.dir).config))).not.toContain(RETELL_KEY);
  });

  it.each([
    ["project_credentials", "voice"],
    ["project_credentials", "chat"],
    ["customer_token_endpoint", "voice"],
    ["customer_token_endpoint", "chat"],
  ] as const)("adds LiveKit %s for %s", async (access, modality) => {
    await putLocalAgent("livekit");
    const io = output();
    const option = livekitOption(access, modality);
    const token = access === "customer_token_endpoint";
    let body: Record<string, unknown> | undefined;
    const config = token
      ? { tokenEndpoint: "https://tokens.example.com/egma", agentName: "receptionist" }
      : { url: "wss://example.livekit.cloud", agentName: "receptionist" };
    const connection = { id: "con_livekit", agentId: AGENT_ID, projectId: PROJECT_ID, name: `LiveKit ${modality}`, agentPlatform: "livekit", connectionType: "livekit_room", accessVariant: option.accessVariant, modality, productLabel: "LiveKit", credentialsHint: "hint", config };
    const code = await runAgentConnectionAddCommand({
      ...base(io),
      agentId: AGENT_ID,
      accessMethod: token ? "livekit-token-endpoint" : "livekit-project-credentials",
      modality,
      name: `LiveKit ${modality}`,
      retellAgentId: null,
      retellPhoneNumber: null,
      livekitUrl: token ? null : "wss://example.livekit.cloud",
      livekitAgentName: "receptionist",
      livekitTokenEndpoint: token ? "https://tokens.example.com/egma" : null,
      credentialsStdin: token,
      ...(token
        ? {
            stdin: Readable.from([
              JSON.stringify({ headers: { Authorization: "Bearer secret" } }),
            ]),
          }
        : {}),
      env: token ? { EGMA_API_KEY: CONTROL_KEY } : { EGMA_API_KEY: CONTROL_KEY, EGMA_LIVEKIT_API_KEY: "livekit-key", EGMA_LIVEKIT_API_SECRET: "livekit-secret" },
      fetchImpl: async (input, init) => {
        const request = new globalThis.URL(String(input));
        if (request.pathname === `/v1/agents/${AGENT_ID}`) return new JsonResponse({ agent: agent("livekit"), connections: [] });
        if (request.pathname === "/v1/connection-options") return new JsonResponse({ items: [option] });
        if (request.pathname === `/v1/agents/${AGENT_ID}/connections`) {
          body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return new JsonResponse({ connection }, 201);
        }
        return new JsonResponse({ agents: [{ ...agent("livekit"), connections: [connection] }], nextPageToken: null });
      },
    });
    expect(code).toBe(0);
    expect(body).toMatchObject({ accessVariant: option.accessVariant, modality, config });
    if (token) {
      expect(body?.["config"]).not.toHaveProperty("url");
      expect(body?.["credentials"]).toEqual({ headers: JSON.stringify({ Authorization: "Bearer secret" }) });
    } else {
      expect(body?.["credentials"]).toEqual({ apiKey: "livekit-key", apiSecret: "livekit-secret" });
    }
  });

  it("refuses unsupported credential fields before a Connection write", async () => {
    await putLocalAgent("livekit");
    const io = output();
    let wrote = false;
    const code = await runAgentConnectionAddCommand({
      ...base(io),
      agentId: AGENT_ID,
      accessMethod: "livekit-token-endpoint",
      modality: "chat",
      name: null,
      retellAgentId: null,
      retellPhoneNumber: null,
      livekitUrl: null,
      livekitAgentName: "receptionist",
      livekitTokenEndpoint: "https://tokens.example.com/egma",
      credentialsStdin: true,
      stdin: Readable.from([JSON.stringify({ apiKey: "must-not-print" })]),
      fetchImpl: async (input) => {
        const request = new globalThis.URL(String(input));
        if (request.pathname === `/v1/agents/${AGENT_ID}`) return new JsonResponse({ agent: agent("livekit"), connections: [] });
        if (request.pathname === "/v1/connection-options") return new JsonResponse({ items: [livekitOption("customer_token_endpoint", "chat")] });
        wrote = true;
        throw new Error("must not write");
      },
    });
    expect(code).toBe(1);
    expect(wrote).toBe(false);
    expect(io.fail.join("\n")).toContain("unsupported fields");
    expect(`${io.out.join("\n")}${io.fail.join("\n")}`).not.toContain("must-not-print");
  });
});
