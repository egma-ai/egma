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
const CONNECTION_ID = "con_connection";
const CONTROL_KEY = "egma_sk_control";
const RETELL_KEY = "retell-secret-value";

const RETELL_TEXT = {
  agentPlatform: "retell",
  agentPlatformLabel: "Retell",
  connectionType: "retell_text_mode",
  accessVariant: "retell_text_mode.api_key",
  accessVariantLabel: "Retell API key",
  modality: "chat",
  productLabel: "Retell text mode",
  topology: "hosted-broker",
  simulatorAdapter: true,
  fields: [
    {
      key: "retellAgentId",
      label: "Retell Agent ID",
      kind: "text",
      required: true,
      help: "The provider Agent ID.",
      afterCredentials: false,
    },
  ],
  credentialRule: "required",
  credentialHelp: "Stored sealed.",
  credentialFields: [
    {
      field: "apiKey",
      label: "Retell API key",
      kind: "secret",
      required: true,
      help: "The account key.",
    },
  ],
} as const;

const RETELL_CHAT_API = {
  ...RETELL_TEXT,
  connectionType: "retell_chat_api",
  accessVariant: "retell_chat_api.api_key",
  productLabel: "Retell chat API",
} as const;

const RETELL_WEB = {
  ...RETELL_TEXT,
  connectionType: "retell_web_call",
  accessVariant: "retell_web_call.api_key",
  modality: "voice",
  productLabel: "Retell web call",
} as const;

const LIVEKIT_TOKEN = {
  agentPlatform: "livekit",
  agentPlatformLabel: "LiveKit",
  connectionType: "livekit_room",
  accessVariant: "livekit_room.customer_token_endpoint",
  accessVariantLabel: "Customer token endpoint",
  modality: "voice",
  productLabel: "LiveKit token endpoint",
  topology: "agent-dials-out",
  simulatorAdapter: true,
  fields: [
    {
      key: "url",
      label: "LiveKit WebSocket URL",
      kind: "url",
      required: true,
      help: "The server.",
      afterCredentials: false,
    },
    {
      key: "tokenEndpoint",
      label: "Token endpoint",
      kind: "url",
      required: true,
      help: "The endpoint.",
      afterCredentials: false,
    },
  ],
  credentialRule: "required",
  credentialHelp: "Stored sealed.",
  credentialFields: [
    {
      field: "headers",
      label: "Auth headers",
      kind: "json",
      required: true,
      help: "Headers sent to the endpoint.",
    },
  ],
} as const;

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

afterEach(async () => {
  await workspace.remove();
});

function output() {
  const out: string[] = [];
  const fail: string[] = [];
  return {
    out,
    fail,
    say: (line: string) => out.push(line),
    complain: (line: string) => fail.push(line),
  };
}

function registrationReceipt(input: {
  readonly name: string;
  readonly platform: "retell" | "livekit";
  readonly platformAgentId: string | null;
  readonly connectionType: string;
  readonly accessVariant: string;
  readonly modality: "chat" | "voice";
  readonly config: Readonly<Record<string, string>>;
}) {
  return {
    result: "created",
    agent: {
      id: AGENT_ID,
      name: input.name,
      projectId: PROJECT_ID,
      agentPlatform: input.platform,
      platformAgentId: input.platformAgentId,
      monitoringKeyPresent: input.platform === "retell",
    },
    connection: {
      id: CONNECTION_ID,
      name: "connection-1",
      agentPlatform: input.platform,
      connectionType: input.connectionType,
      accessVariant: input.accessVariant,
      modality: input.modality,
      productLabel: "Connection",
      credentialsHint: "hint",
      config: input.config,
    },
  };
}

describe("skills-led Agent commands", () => {
  it("lists LiveKit flags and credential sources from the server catalog", async () => {
    const io = output();
    const code = await runAgentConnectionOptionsCommand({
      access: { url: URL, credentialsFile: workspace.credentialsFile },
      cwd: workspace.dir,
      platform: "livekit",
      agentId: null,
      credentialsStdin: false,
      env: { EGMA_API_KEY: CONTROL_KEY },
      signal: new AbortController().signal,
      out: io.say,
      fail: io.complain,
      fetchImpl: async (input) => {
        expect(new globalThis.URL(String(input)).pathname).toBe(
          "/v1/connection-options",
        );
        return new JsonResponse({ items: [LIVEKIT_TOKEN] });
      },
    });

    expect(code).toBe(0);
    expect(io.fail).toEqual([]);
    expect(io.out).toContain("  Access: livekit-token-endpoint");
    expect(io.out).toContain(
      "  Required flags: --livekit-url, --token-endpoint",
    );
    expect(io.out).toContain(
      "  Credential environment: EGMA_LIVEKIT_TOKEN_HEADERS",
    );
    expect(io.out.join("\n")).toContain("--name '<Egma Agent name>'");
  });

  it("prints add commands when Retell discovery reuses an Egma Agent key", async () => {
    const paths = folderPathsIn(workspace.dir);
    const config = await readConfig(paths.config);
    await writeConfig(paths.config, {
      ...config,
      agents: [
        {
          id: AGENT_ID,
          name: "Receptionist",
          platform: "retell",
          connections: [],
        },
      ],
    });
    const io = output();
    const fetchImpl: typeof fetch = async (input, init) => {
      const requested = new globalThis.URL(String(input));
      if (requested.pathname === "/v1/connection-options") {
        return new JsonResponse({ items: [RETELL_TEXT] });
      }
      if (requested.pathname === `/v1/agents/${AGENT_ID}`) {
        return new JsonResponse({
          agent: {
            id: AGENT_ID,
            name: "Receptionist",
            projectId: PROJECT_ID,
            agentPlatform: "retell",
            platformAgentId: "agent_retell",
            monitoringKeyPresent: true,
          },
          connections: [],
        });
      }
      if (requested.pathname === "/v1/agents:discover") {
        expect(JSON.parse(String(init?.body))).toMatchObject({
          agentPlatform: "retell",
          agentId: AGENT_ID,
        });
        return new JsonResponse({
          agents: [
            {
              platformAgentId: "agent_retell",
              name: "Receptionist",
              modality: "voice",
              connectionCandidates: [
                {
                  agentPlatform: "retell",
                  connectionType: "retell_text_mode",
                  accessVariant: "retell_text_mode.api_key",
                  modality: "chat",
                  productLabel: "Retell text mode",
                  config: { retellAgentId: "agent_retell" },
                },
              ],
            },
          ],
        });
      }
      throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${requested}`);
    };

    const code = await runAgentConnectionOptionsCommand({
      access: { url: URL, credentialsFile: workspace.credentialsFile },
      cwd: workspace.dir,
      platform: "retell",
      agentId: AGENT_ID,
      credentialsStdin: false,
      env: { EGMA_API_KEY: CONTROL_KEY },
      signal: new AbortController().signal,
      out: io.say,
      fail: io.complain,
      fetchImpl,
    });

    const shown = io.out.join("\n");
    expect(code).toBe(0);
    expect(io.fail).toEqual([]);
    expect(shown).toContain(
      `egma agent connection add --access retell-api-key --modality chat --agent '${AGENT_ID}'`,
    );
    expect(shown).not.toContain("egma agent register");
    expect(shown).not.toContain("--platform retell");
    expect(shown).not.toContain("--retell-agent");
  });

  it("registers a discovered Retell Agent and refreshes config.yaml", async () => {
    const io = output();
    let registration: Record<string, unknown> | undefined;
    const receipt = registrationReceipt({
      name: "Receptionist",
      platform: "retell",
      platformAgentId: "agent_retell",
      connectionType: "retell_text_mode",
      accessVariant: "retell_text_mode.api_key",
      modality: "chat",
      config: { retellAgentId: "agent_retell" },
    });
    const fetchImpl: typeof fetch = async (input, init) => {
      const requested = new globalThis.URL(String(input));
      if (requested.pathname === "/v1/connection-options") {
        return new JsonResponse({ items: [RETELL_CHAT_API, RETELL_TEXT] });
      }
      if (requested.pathname === "/v1/agents:discover") {
        const body = JSON.parse(String(init?.body)) as {
          readonly credentials: { readonly apiKey: string };
        };
        expect(body.credentials.apiKey).toBe(RETELL_KEY);
        expect(requested.searchParams.get("projectId")).toBe(PROJECT_ID);
        return new JsonResponse({
          agents: [
            {
              platformAgentId: "agent_retell",
              name: "Receptionist",
              modality: "voice",
              connectionCandidates: [
                {
                  agentPlatform: "retell",
                  connectionType: "retell_text_mode",
                  accessVariant: "retell_text_mode.api_key",
                  modality: "chat",
                  productLabel: "Retell text mode",
                  config: { retellAgentId: "agent_retell" },
                },
              ],
            },
          ],
        });
      }
      if (requested.pathname === "/v1/agents" && init?.method === "POST") {
        expect(requested.searchParams.get("projectId")).toBe(PROJECT_ID);
        registration = JSON.parse(String(init.body)) as Record<string, unknown>;
        return new JsonResponse(receipt, 201);
      }
      if (requested.pathname === "/v1/agents") {
        return new JsonResponse({
          agents: [{ ...receipt.agent, connections: [receipt.connection] }],
          nextPageToken: null,
        });
      }
      throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${requested}`);
    };

    const code = await runAgentRegisterCommand({
      access: { url: URL, credentialsFile: workspace.credentialsFile },
      cwd: workspace.dir,
      platform: "retell",
      accessMethod: "retell-api-key",
      modality: "chat",
      name: null,
      connectionName: null,
      retellAgentId: "agent_retell",
      phoneNumber: null,
      livekitUrl: null,
      dispatchName: null,
      tokenEndpoint: null,
      metadata: null,
      credentialsStdin: false,
      env: { EGMA_API_KEY: CONTROL_KEY, EGMA_RETELL_API_KEY: RETELL_KEY },
      signal: new AbortController().signal,
      out: io.say,
      fail: io.complain,
      fetchImpl,
    });

    expect(code).toBe(0);
    expect(registration).toMatchObject({
      name: "Receptionist",
      agentPlatform: "retell",
      connection: {
        agentPlatform: "retell",
        connectionType: "retell_text_mode",
        accessVariant: "retell_text_mode.api_key",
        modality: "chat",
        config: { retellAgentId: "agent_retell" },
        platformAgentId: "agent_retell",
        credentials: { apiKey: RETELL_KEY },
      },
    });
    expect(JSON.stringify(registration)).not.toContain("agentPlatformSelection");
    const config = await readConfig(folderPathsIn(workspace.dir).config);
    expect(config.agents).toEqual([
      {
        id: AGENT_ID,
        name: "Receptionist",
        platform: "retell",
        connections: [{ id: CONNECTION_ID, name: "connection-1" }],
      },
    ]);
    expect(io.out).toContain("status: created");
  });

  it("uses a Retell Agent's stored key when adding a Connection", async () => {
    await createEgmaFolder({ repository: workspace.dir });
    const paths = folderPathsIn(workspace.dir);
    const existing = await readConfig(paths.config);
    await writeConfig(paths.config, {
      ...existing,
      agents: [
        {
          id: AGENT_ID,
          name: "Receptionist",
          platform: "retell",
          connections: [],
        },
      ],
    });

    const io = output();
    let discoveryBody: Record<string, unknown> | undefined;
    let addBody: Record<string, unknown> | undefined;
    const agent = {
      id: AGENT_ID,
      name: "Receptionist",
      projectId: PROJECT_ID,
      agentPlatform: "retell",
      platformAgentId: "agent_retell",
      monitoringKeyPresent: true,
    } as const;
    const connection = {
      id: CONNECTION_ID,
      name: "retell_web_call-1",
      agentPlatform: "retell",
      connectionType: "retell_web_call",
      accessVariant: "retell_web_call.api_key",
      modality: "voice",
      productLabel: "Retell web call",
      credentialsHint: "alue",
      config: { retellAgentId: "agent_retell" },
    } as const;
    const fetchImpl: typeof fetch = async (input, init) => {
      const requested = new globalThis.URL(String(input));
      if (requested.pathname === "/v1/connection-options") {
        return new JsonResponse({ items: [RETELL_WEB] });
      }
      if (requested.pathname === `/v1/agents/${AGENT_ID}`) {
        return new JsonResponse({ agent, connections: [] });
      }
      if (requested.pathname === "/v1/agents:discover") {
        expect(requested.searchParams.get("projectId")).toBe(PROJECT_ID);
        discoveryBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new JsonResponse({
          agents: [
            {
              platformAgentId: "agent_retell",
              name: "Receptionist",
              modality: "voice",
              connectionCandidates: [
                {
                  agentPlatform: "retell",
                  connectionType: "retell_web_call",
                  accessVariant: "retell_web_call.api_key",
                  modality: "voice",
                  productLabel: "Retell web call",
                  config: { retellAgentId: "agent_retell" },
                },
              ],
            },
          ],
        });
      }
      if (
        requested.pathname === `/v1/agents/${AGENT_ID}/connections` &&
        init?.method === "POST"
      ) {
        addBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        return new JsonResponse({ connection }, 201);
      }
      if (requested.pathname === "/v1/agents") {
        return new JsonResponse({
          agents: [{ ...agent, connections: [connection] }],
          nextPageToken: null,
        });
      }
      throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${requested}`);
    };

    const code = await runAgentConnectionAddCommand({
      access: { url: URL, credentialsFile: workspace.credentialsFile },
      cwd: workspace.dir,
      agentId: AGENT_ID,
      accessMethod: "retell-api-key",
      modality: "voice",
      connectionName: null,
      phoneNumber: null,
      livekitUrl: null,
      dispatchName: null,
      tokenEndpoint: null,
      metadata: null,
      credentialsStdin: true,
      stdin: Readable.from(["replacement-key-that-must-not-be-used"]),
      env: {
        EGMA_API_KEY: CONTROL_KEY,
        EGMA_RETELL_API_KEY: "another-replacement-that-must-not-be-used",
      },
      signal: new AbortController().signal,
      out: io.say,
      fail: io.complain,
      fetchImpl,
    });

    expect(code).toBe(0);
    expect(discoveryBody).toEqual({
      agentPlatform: "retell",
      agentId: AGENT_ID,
    });
    expect(addBody).toMatchObject({
      agentPlatform: "retell",
      connectionType: "retell_web_call",
      accessVariant: "retell_web_call.api_key",
      platformAgentId: "agent_retell",
    });
    expect(JSON.stringify(addBody)).not.toContain("replacement");
    expect(io.out).toContain("status: connection-added");
  });

  it("accepts structured token headers on standard input", async () => {
    const io = output();
    let registration: Record<string, unknown> | undefined;
    const receipt = registrationReceipt({
      name: "Receptionist",
      platform: "livekit",
      platformAgentId: null,
      connectionType: "livekit_room",
      accessVariant: "livekit_room.customer_token_endpoint",
      modality: "voice",
      config: {
        url: "wss://example.livekit.cloud",
        tokenEndpoint: "https://example.com/livekit/token",
      },
    });
    const fetchImpl: typeof fetch = async (input, init) => {
      const requested = new globalThis.URL(String(input));
      if (requested.pathname === "/v1/connection-options") {
        return new JsonResponse({ items: [LIVEKIT_TOKEN] });
      }
      if (requested.pathname === "/v1/agents" && init?.method === "POST") {
        registration = JSON.parse(String(init.body)) as Record<string, unknown>;
        return new JsonResponse(receipt, 201);
      }
      if (requested.pathname === "/v1/agents") {
        return new JsonResponse({
          agents: [{ ...receipt.agent, connections: [receipt.connection] }],
          nextPageToken: null,
        });
      }
      throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${requested}`);
    };

    const code = await runAgentRegisterCommand({
      access: { url: URL, credentialsFile: workspace.credentialsFile },
      cwd: workspace.dir,
      platform: "livekit",
      accessMethod: "livekit-token-endpoint",
      modality: "voice",
      name: "Receptionist",
      connectionName: null,
      retellAgentId: null,
      phoneNumber: null,
      livekitUrl: "wss://example.livekit.cloud",
      dispatchName: null,
      tokenEndpoint: "https://example.com/livekit/token",
      metadata: null,
      credentialsStdin: true,
      stdin: Readable.from([
        JSON.stringify({ headers: { Authorization: "Bearer secret" } }),
      ]),
      env: { EGMA_API_KEY: CONTROL_KEY },
      signal: new AbortController().signal,
      out: io.say,
      fail: io.complain,
      fetchImpl,
    });

    expect(code).toBe(0);
    expect(registration).toMatchObject({
      connection: {
        credentials: {
          headers: JSON.stringify({ Authorization: "Bearer secret" }),
        },
      },
    });
  });
});
