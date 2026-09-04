import path from "node:path";
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

const RETELL_PHONE = {
  ...RETELL_TEXT,
  connectionType: "phone_number",
  accessVariant: "phone_number.public_e164",
  modality: "voice",
  productLabel: "Retell phone",
  fields: [
    {
      key: "phoneNumber",
      label: "Phone number",
      kind: "e164",
      required: true,
      help: "The number.",
      afterCredentials: false,
    },
  ],
  credentialRule: "forbidden",
  credentialFields: [],
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
      key: "agentName",
      label: "LiveKit Agent name",
      kind: "text",
      required: true,
      help: "The dispatch name.",
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

const LIVEKIT_PROJECT = {
  ...LIVEKIT_TOKEN,
  accessVariant: "livekit_room.project_credentials",
  accessVariantLabel: "Project credentials",
  productLabel: "LiveKit project credentials",
  fields: LIVEKIT_TOKEN.fields.filter((field) => field.key !== "tokenEndpoint"),
  credentialFields: [
    {
      field: "apiKey",
      label: "API key",
      kind: "secret",
      required: true,
      help: "The LiveKit Project key.",
    },
    {
      field: "apiSecret",
      label: "API secret",
      kind: "secret",
      required: true,
      help: "The LiveKit Project secret.",
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

function agentReceipt(input: {
  readonly name: string;
  readonly platform: "retell" | "livekit";
  readonly projectId?: string;
  readonly platformAgentId?: string | null;
  readonly monitoringKeyPresent?: boolean;
}) {
  return {
    id: AGENT_ID,
    name: input.name,
    projectId: input.projectId ?? PROJECT_ID,
    agentPlatform: input.platform,
    platformAgentId: input.platformAgentId ?? null,
    monitoringKeyPresent: input.monitoringKeyPresent ?? false,
  };
}

function connectionReceipt(input: {
  readonly platform: "retell" | "livekit";
  readonly connectionType: string;
  readonly accessVariant: string;
  readonly modality: "chat" | "voice";
  readonly config: Readonly<Record<string, string>>;
  readonly agentId?: string;
  readonly projectId?: string;
  readonly name?: string;
}) {
  return {
    id: CONNECTION_ID,
    agentId: input.agentId ?? AGENT_ID,
    projectId: input.projectId ?? PROJECT_ID,
    name: input.name ?? "connection-1",
    agentPlatform: input.platform,
    connectionType: input.connectionType,
    accessVariant: input.accessVariant,
    modality: input.modality,
    productLabel: "Connection",
    credentialsHint: "hint",
    config: input.config,
  };
}

async function putLocalAgent(input: {
  readonly platform: "retell" | "livekit";
  readonly connections?: readonly { readonly id: string; readonly name: string }[];
}): Promise<void> {
  const paths = folderPathsIn(workspace.dir);
  const config = await readConfig(paths.config);
  await writeConfig(paths.config, {
    ...config,
    agents: [
      {
        id: AGENT_ID,
        name: "Receptionist",
        platform: input.platform,
        connections: input.connections ?? [],
      },
    ],
  });
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

describe("skills-first Agent commands", () => {
  it("lists LiveKit add flags and credential sources from the server catalog", async () => {
    const io = output();
    const code = await runAgentConnectionOptionsCommand({
      ...base(io),
      platform: "livekit",
      agentId: null,
      fetchImpl: async (input) => {
        expect(new globalThis.URL(String(input)).pathname).toBe(
          "/v1/connection-options",
        );
        return new JsonResponse({ items: [LIVEKIT_TOKEN] });
      },
    });

    const shown = io.out.join("\n");
    expect(code).toBe(0);
    expect(io.fail).toEqual([]);
    expect(shown).toContain(
      "Required flags: --livekit-url, --livekit-agent-name, --livekit-token-endpoint",
    );
    expect(shown).toContain(
      "Credential environment: EGMA_LIVEKIT_TOKEN_ENDPOINT_HEADERS",
    );
    expect(shown).toContain("egma agent connection add --agent '<Egma Agent ID>'");
    expect(shown).not.toContain("egma agent register");
  });

  it("lists Retell Agents once and prints one reusable shape per Connection option", async () => {
    const io = output();
    const fetchImpl: typeof fetch = async (input, init) => {
      const requested = new globalThis.URL(String(input));
      if (requested.pathname === "/v1/connection-options") {
        return new JsonResponse({ items: [RETELL_TEXT, RETELL_PHONE] });
      }
      if (requested.pathname === "/v1/agents:discover") {
        expect(JSON.parse(String(init?.body))).toMatchObject({
          agentPlatform: "retell",
          credentials: { apiKey: RETELL_KEY },
        });
        return new JsonResponse({
          agents: [
            {
              platformAgentId: "agent_first",
              name: "First desk",
              modality: "voice",
              connectionCandidates: [
                {
                  agentPlatform: "retell",
                  connectionType: "retell_text_mode",
                  accessVariant: "retell_text_mode.api_key",
                  modality: "chat",
                  productLabel: "Retell text mode",
                  config: { retellAgentId: "agent_first" },
                },
                {
                  agentPlatform: "retell",
                  connectionType: "phone_number",
                  accessVariant: "phone_number.public_e164",
                  modality: "voice",
                  productLabel: "Retell phone",
                  config: { phoneNumber: "+14155550100" },
                },
              ],
            },
            {
              platformAgentId: "agent_second",
              name: "Second desk",
              modality: "voice",
              connectionCandidates: [],
            },
          ],
        });
      }
      throw new Error(`Unexpected request: ${requested}`);
    };

    const code = await runAgentConnectionOptionsCommand({
      ...base(io),
      platform: "retell",
      agentId: null,
      env: { EGMA_API_KEY: CONTROL_KEY, EGMA_RETELL_API_KEY: RETELL_KEY },
      fetchImpl,
    });

    const shown = io.out.join("\n");
    expect(code).toBe(0);
    expect(io.fail).toEqual([]);
    expect(shown.match(/agent_first/gu)).toHaveLength(1);
    expect(shown.match(/agent_second/gu)).toHaveLength(1);
    expect(shown).toContain("Phone numbers: +14155550100");
    expect(shown.match(/egma agent connection add/gu)).toHaveLength(2);
    expect(shown).toContain("--retell-agent '<Retell Agent ID>'");
    expect(shown).toContain("--retell-phone-number '<Phone number>'");
    expect(shown).not.toContain("egma agent register");
  });

  it("registers only Agent identity and refreshes config.yaml", async () => {
    const io = output();
    const defaultName = path.basename(workspace.dir);
    let registration: Record<string, unknown> | undefined;
    let registrationProject: string | null = null;
    const agent = agentReceipt({ name: defaultName, platform: "retell" });
    const fetchImpl: typeof fetch = async (input, init) => {
      const requested = new globalThis.URL(String(input));
      if (requested.pathname === "/v1/agents" && init?.method === "POST") {
        registrationProject = requested.searchParams.get("projectId");
        registration = JSON.parse(String(init.body)) as Record<string, unknown>;
        return new JsonResponse({ result: "created", agent }, 201);
      }
      if (requested.pathname === "/v1/agents" && (init?.method ?? "GET") === "GET") {
        return new JsonResponse({
          agents: [{ ...agent, connections: [] }],
          nextPageToken: null,
        });
      }
      throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${requested}`);
    };

    const code = await runAgentRegisterCommand({
      ...base(io),
      platform: "retell",
      name: null,
      fetchImpl,
    });

    expect(code).toBe(0);
    expect(registration).toEqual({
      name: defaultName,
      agentPlatform: "retell",
    });
    expect(registrationProject).toBe(PROJECT_ID);
    expect(registration).not.toHaveProperty("connection");
    const config = await readConfig(folderPathsIn(workspace.dir).config);
    expect(config.agents).toEqual([
      {
        id: AGENT_ID,
        name: defaultName,
        platform: "retell",
        connections: [],
      },
    ]);
    expect(io.out.join("\n")).toContain(`Registered Agent ${JSON.stringify(defaultName)}`);
    expect(io.out.join("\n")).not.toContain("status:");
  });

  it("returns 130 when the post-registration refresh is interrupted", async () => {
    const io = output();
    const controller = new AbortController();
    const agent = agentReceipt({ name: "Receptionist", platform: "retell" });
    const code = await runAgentRegisterCommand({
      ...base(io),
      signal: controller.signal,
      platform: "retell",
      name: "Receptionist",
      fetchImpl: async (input, init) => {
        const requested = new globalThis.URL(String(input));
        if (requested.pathname === "/v1/agents" && init?.method === "POST") {
          return new JsonResponse({ result: "created", agent }, 201);
        }
        controller.abort();
        throw new DOMException("The refresh was stopped.", "AbortError");
      },
    });

    expect(code).toBe(130);
    expect(io.out.join("\n")).toContain(`Registered Agent "Receptionist" (${AGENT_ID}).`);
    expect(io.out.join("\n")).not.toContain("Updated egma/config.yaml");
    expect(io.fail.join("\n")).toContain("remote write succeeded");
    expect(io.fail.join("\n")).toContain("interrupted");
    expect((await readConfig(folderPathsIn(workspace.dir).config)).agents).toEqual([]);
  });

  it("does not refresh config when the Agent write is absent from the returned roster", async () => {
    const io = output();
    const agent = agentReceipt({ name: "Receptionist", platform: "retell" });
    const code = await runAgentRegisterCommand({
      ...base(io),
      platform: "retell",
      name: "Receptionist",
      fetchImpl: async (input, init) => {
        const requested = new globalThis.URL(String(input));
        return requested.pathname === "/v1/agents" && init?.method === "POST"
          ? new JsonResponse({ result: "created", agent }, 201)
          : new JsonResponse({ agents: [], nextPageToken: null });
      },
    });

    expect(code).toBe(1);
    expect(io.out.join("\n")).toContain(`Registered Agent "Receptionist" (${AGENT_ID}).`);
    expect(io.out.join("\n")).not.toContain("Updated egma/config.yaml");
    expect(io.fail.join("\n")).toContain("did not contain Agent");
    expect(io.fail.join("\n")).toContain("Run egma pull");
    expect((await readConfig(folderPathsIn(workspace.dir).config)).agents).toEqual([]);
  });

  it("refuses a legacy registration result for an identity-only request", async () => {
    const io = output();
    const agent = agentReceipt({ name: "Receptionist", platform: "retell" });
    const code = await runAgentRegisterCommand({
      ...base(io),
      platform: "retell",
      name: "Receptionist",
      fetchImpl: async (input, init) => {
        const requested = new globalThis.URL(String(input));
        expect(requested.pathname).toBe("/v1/agents");
        expect(init?.method).toBe("POST");
        return new JsonResponse({ result: "reused", agent });
      },
    });

    expect(code).toBe(1);
    expect(io.out).toEqual([]);
    expect(io.fail.join("\n")).toContain(
      "identity-only Agent registration with a legacy result",
    );
  });

  it("does not accept an Agent registration receipt for another Project", async () => {
    const io = output();
    const agent = agentReceipt({
      name: "Receptionist",
      platform: "retell",
      projectId: "prj_somewhere_else",
    });
    let requestCount = 0;
    const code = await runAgentRegisterCommand({
      ...base(io),
      platform: "retell",
      name: "Receptionist",
      fetchImpl: async () => {
        requestCount += 1;
        return new JsonResponse({ result: "created", agent }, 201);
      },
    });

    expect(code).toBe(1);
    expect(requestCount).toBe(1);
    expect(io.out).toEqual([]);
    expect(io.fail.join("\n")).toContain(
      "matching identity-only Agent receipt",
    );
    expect(io.fail.join("\n")).toContain("Run egma pull before retrying");
    expect((await readConfig(folderPathsIn(workspace.dir).config)).agents).toEqual([]);
  });

  it("adds the first Retell Connection with provider identity and JSON stdin credentials", async () => {
    await putLocalAgent({ platform: "retell" });
    const io = output();
    const bare = agentReceipt({ name: "Receptionist", platform: "retell" });
    const bound = agentReceipt({
      name: "Receptionist",
      platform: "retell",
      platformAgentId: "agent_retell",
      monitoringKeyPresent: true,
    });
    const connection = connectionReceipt({
      platform: "retell",
      connectionType: "retell_text_mode",
      accessVariant: "retell_text_mode.api_key",
      modality: "chat",
      name: "Fast text",
      config: { retellAgentId: "agent_retell" },
    });
    let addBody: Record<string, unknown> | undefined;
    const fetchImpl: typeof fetch = async (input, init) => {
      const requested = new globalThis.URL(String(input));
      if (requested.pathname === `/v1/agents/${AGENT_ID}`) {
        expect(requested.searchParams.get("projectId")).toBe(PROJECT_ID);
        return new JsonResponse({ agent: bare, connections: [] });
      }
      if (requested.pathname === "/v1/connection-options") {
        return new JsonResponse({ items: [RETELL_TEXT] });
      }
      if (requested.pathname === "/v1/agents:discover") {
        expect(JSON.parse(String(init?.body))).toMatchObject({
          credentials: { apiKey: RETELL_KEY },
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
      if (requested.pathname === `/v1/agents/${AGENT_ID}/connections`) {
        expect(requested.searchParams.get("projectId")).toBe(PROJECT_ID);
        addBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new JsonResponse({ connection }, 201);
      }
      if (requested.pathname === "/v1/agents") {
        return new JsonResponse({
          agents: [{ ...bound, connections: [connection] }],
          nextPageToken: null,
        });
      }
      throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${requested}`);
    };

    const code = await runAgentConnectionAddCommand({
      ...base(io),
      agentId: AGENT_ID,
      accessMethod: "retell-api-key",
      modality: "chat",
      name: "Fast text",
      retellAgentId: "agent_retell",
      retellPhoneNumber: null,
      livekitUrl: null,
      livekitAgentName: null,
      livekitTokenEndpoint: null,
      credentialsStdin: true,
      stdin: Readable.from([JSON.stringify({ apiKey: RETELL_KEY })]),
      fetchImpl,
    });

    expect(code).toBe(0);
    expect(addBody).toMatchObject({
      name: "Fast text",
      agentPlatform: "retell",
      connectionType: "retell_text_mode",
      accessVariant: "retell_text_mode.api_key",
      modality: "chat",
      platformAgentId: "agent_retell",
      credentials: { apiKey: RETELL_KEY },
    });
    const configText = JSON.stringify(await readConfig(folderPathsIn(workspace.dir).config));
    expect(configText).not.toContain(RETELL_KEY);
    expect(io.out.join("\n")).not.toContain(RETELL_KEY);
    expect(io.fail).toEqual([]);
  });

  it("uses a stored Retell key and ignores replacement credentials", async () => {
    await putLocalAgent({ platform: "retell" });
    const io = output();
    const agent = agentReceipt({
      name: "Receptionist",
      platform: "retell",
      platformAgentId: "agent_retell",
      monitoringKeyPresent: true,
    });
    const connection = connectionReceipt({
      platform: "retell",
      connectionType: "retell_web_call",
      accessVariant: "retell_web_call.api_key",
      modality: "voice",
      name: "Retell web call",
      config: { retellAgentId: "agent_retell" },
    });
    let discoveryBody: Record<string, unknown> | undefined;
    let addBody: Record<string, unknown> | undefined;
    const fetchImpl: typeof fetch = async (input, init) => {
      const requested = new globalThis.URL(String(input));
      if (requested.pathname === `/v1/agents/${AGENT_ID}`) {
        return new JsonResponse({ agent, connections: [] });
      }
      if (requested.pathname === "/v1/connection-options") {
        return new JsonResponse({ items: [RETELL_WEB] });
      }
      if (requested.pathname === "/v1/agents:discover") {
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
      if (requested.pathname === `/v1/agents/${AGENT_ID}/connections`) {
        addBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new JsonResponse({ connection }, 201);
      }
      if (requested.pathname === "/v1/agents") {
        return new JsonResponse({
          agents: [{ ...agent, connections: [connection] }],
          nextPageToken: null,
        });
      }
      throw new Error(`Unexpected request: ${requested}`);
    };

    const code = await runAgentConnectionAddCommand({
      ...base(io),
      agentId: AGENT_ID,
      accessMethod: "retell-api-key",
      modality: "voice",
      name: null,
      retellAgentId: null,
      retellPhoneNumber: null,
      livekitUrl: null,
      livekitAgentName: null,
      livekitTokenEndpoint: null,
      credentialsStdin: true,
      stdin: Readable.from([JSON.stringify({ apiKey: "replacement-secret" })]),
      env: {
        EGMA_API_KEY: CONTROL_KEY,
        EGMA_RETELL_API_KEY: "another-replacement-secret",
      },
      fetchImpl,
    });

    expect(code).toBe(0);
    expect(discoveryBody).toEqual({ agentPlatform: "retell", agentId: AGENT_ID });
    expect(addBody).toMatchObject({ name: "Retell web call" });
    expect(addBody).not.toHaveProperty("credentials");
    expect(JSON.stringify(addBody)).not.toContain("replacement");
  });

  it("adds a LiveKit token-endpoint Connection with structured stdin headers", async () => {
    await putLocalAgent({ platform: "livekit" });
    const io = output();
    const agent = agentReceipt({ name: "Receptionist", platform: "livekit" });
    const connection = connectionReceipt({
      platform: "livekit",
      connectionType: "livekit_room",
      accessVariant: "livekit_room.customer_token_endpoint",
      modality: "voice",
      name: "LiveKit token endpoint",
      config: {
        url: "wss://example.livekit.cloud",
        agentName: "receptionist",
        tokenEndpoint: "https://example.com/livekit/token",
      },
    });
    let addBody: Record<string, unknown> | undefined;
    const fetchImpl: typeof fetch = async (input, init) => {
      const requested = new globalThis.URL(String(input));
      if (requested.pathname === `/v1/agents/${AGENT_ID}`) {
        return new JsonResponse({ agent, connections: [] });
      }
      if (requested.pathname === "/v1/connection-options") {
        return new JsonResponse({ items: [LIVEKIT_TOKEN] });
      }
      if (requested.pathname === `/v1/agents/${AGENT_ID}/connections`) {
        addBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new JsonResponse({ connection }, 201);
      }
      if (requested.pathname === "/v1/agents") {
        return new JsonResponse({
          agents: [{ ...agent, connections: [connection] }],
          nextPageToken: null,
        });
      }
      throw new Error(`Unexpected request: ${requested}`);
    };

    const code = await runAgentConnectionAddCommand({
      ...base(io),
      agentId: AGENT_ID,
      accessMethod: "livekit-token-endpoint",
      modality: "voice",
      name: null,
      retellAgentId: null,
      retellPhoneNumber: null,
      livekitUrl: "wss://example.livekit.cloud",
      livekitAgentName: "receptionist",
      livekitTokenEndpoint: "https://example.com/livekit/token",
      credentialsStdin: true,
      stdin: Readable.from([
        JSON.stringify({ headers: { Authorization: "Bearer secret" } }),
      ]),
      fetchImpl,
    });

    expect(code).toBe(0);
    expect(addBody).toMatchObject({
      connectionType: "livekit_room",
      accessVariant: "livekit_room.customer_token_endpoint",
      config: {
        url: "wss://example.livekit.cloud",
        agentName: "receptionist",
        tokenEndpoint: "https://example.com/livekit/token",
      },
      credentials: {
        headers: JSON.stringify({ Authorization: "Bearer secret" }),
      },
    });
  });

  it("does not refresh config when the Connection write is absent from the returned roster", async () => {
    await putLocalAgent({ platform: "livekit" });
    const io = output();
    const agent = agentReceipt({ name: "Receptionist", platform: "livekit" });
    const connection = connectionReceipt({
      platform: "livekit",
      connectionType: "livekit_room",
      accessVariant: "livekit_room.project_credentials",
      modality: "voice",
      name: "LiveKit project credentials",
      config: {
        url: "wss://example.livekit.cloud",
        agentName: "receptionist",
      },
    });
    const code = await runAgentConnectionAddCommand({
      ...base(io),
      agentId: AGENT_ID,
      accessMethod: "livekit-project-credentials",
      modality: "voice",
      name: null,
      retellAgentId: null,
      retellPhoneNumber: null,
      livekitUrl: "wss://example.livekit.cloud",
      livekitAgentName: "receptionist",
      livekitTokenEndpoint: null,
      credentialsStdin: false,
      env: {
        EGMA_API_KEY: CONTROL_KEY,
        EGMA_LIVEKIT_API_KEY: "livekit-key",
        EGMA_LIVEKIT_API_SECRET: "livekit-secret",
      },
      fetchImpl: async (input, init) => {
        const requested = new globalThis.URL(String(input));
        if (requested.pathname === `/v1/agents/${AGENT_ID}`) {
          return new JsonResponse({ agent, connections: [] });
        }
        if (requested.pathname === "/v1/connection-options") {
          return new JsonResponse({ items: [LIVEKIT_PROJECT] });
        }
        if (requested.pathname === `/v1/agents/${AGENT_ID}/connections`) {
          return new JsonResponse({ connection }, 201);
        }
        if (requested.pathname === "/v1/agents") {
          return new JsonResponse({
            agents: [{ ...agent, connections: [] }],
            nextPageToken: null,
          });
        }
        throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${requested}`);
      },
    });

    expect(code).toBe(1);
    expect(io.out.join("\n")).toContain(
      `Added Connection "LiveKit project credentials" (${CONNECTION_ID}).`,
    );
    expect(io.out.join("\n")).not.toContain("Updated egma/config.yaml");
    expect(io.fail.join("\n")).toContain("did not contain Connection");
    expect(io.fail.join("\n")).toContain("Run egma pull");
    expect(
      (await readConfig(folderPathsIn(workspace.dir).config)).agents[0]?.connections,
    ).toEqual([]);
  });

  it.each([
    {
      label: "another Agent",
      changed: { agentId: "agt_someone_else" },
    },
    {
      label: "another Connection shape",
      changed: { modality: "chat" as const },
    },
  ])("does not accept a Connection receipt for $label", async ({ changed }) => {
    await putLocalAgent({ platform: "livekit" });
    const io = output();
    const agent = agentReceipt({ name: "Receptionist", platform: "livekit" });
    const connection = {
      ...connectionReceipt({
        platform: "livekit",
        connectionType: "livekit_room",
        accessVariant: "livekit_room.project_credentials",
        modality: "voice",
        name: "LiveKit project credentials",
        config: {
          url: "wss://example.livekit.cloud",
          agentName: "receptionist",
        },
      }),
      ...changed,
    };
    let requestCount = 0;
    const code = await runAgentConnectionAddCommand({
      ...base(io),
      agentId: AGENT_ID,
      accessMethod: "livekit-project-credentials",
      modality: "voice",
      name: null,
      retellAgentId: null,
      retellPhoneNumber: null,
      livekitUrl: "wss://example.livekit.cloud",
      livekitAgentName: "receptionist",
      livekitTokenEndpoint: null,
      credentialsStdin: false,
      env: {
        EGMA_API_KEY: CONTROL_KEY,
        EGMA_LIVEKIT_API_KEY: "livekit-key",
        EGMA_LIVEKIT_API_SECRET: "livekit-secret",
      },
      fetchImpl: async (input) => {
        requestCount += 1;
        const requested = new globalThis.URL(String(input));
        if (requested.pathname === `/v1/agents/${AGENT_ID}`) {
          return new JsonResponse({ agent, connections: [] });
        }
        if (requested.pathname === "/v1/connection-options") {
          return new JsonResponse({ items: [LIVEKIT_PROJECT] });
        }
        if (requested.pathname === `/v1/agents/${AGENT_ID}/connections`) {
          return new JsonResponse({ connection }, 201);
        }
        throw new Error("A mismatched Connection receipt must not start a refresh");
      },
    });

    expect(code).toBe(1);
    expect(requestCount).toBe(3);
    expect(io.out).toEqual([]);
    expect(io.fail.join("\n")).toContain("matching Connection receipt");
    expect(io.fail.join("\n")).toContain("Run egma pull before retrying");
    expect(
      (await readConfig(folderPathsIn(workspace.dir).config)).agents[0]?.connections,
    ).toEqual([]);
  });
});
