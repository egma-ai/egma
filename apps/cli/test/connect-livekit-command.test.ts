/** The raw LiveKit connection path, with no terminal interaction. */

import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CONNECT_EXIT,
  runConnectCommand,
  type ConnectCommandOptions,
} from "../src/commands/connect.ts";
import {
  LIVEKIT_API_KEY_VARIABLE,
  LIVEKIT_API_SECRET_VARIABLE,
  LIVEKIT_TOKEN_HEADERS_VARIABLE,
} from "../src/commands/connect-livekit.ts";
import { folderPathsIn, readConfig } from "../src/folder/egma-folder.ts";
import {
  LIVEKIT_KEY_PAIR_VARIANT,
  LIVEKIT_TOKEN_ENDPOINT_VARIANT,
} from "../src/livekit/connect.ts";
import { makeWorkspace, type Workspace } from "./support/workspace.ts";

const URL = "https://egma.example";
const PROJECT_ID = "prj_01K3XQ7M4E8YB2FVN0H9TZQWER";
const AGENT_ID = "agt_01K3XQ7M4E8YB2FVN0H9TZQWER";
const CONNECTION_ID = "con_01K3XQ7M4E8YB2FVN0H9TZQWER";
const API_KEY = "APIhx4bmvHnLcWXYZ";
const API_SECRET = "livekit-secret-E5F6G7H8QRST";
const HEADERS = '{"Authorization":"Bearer private-token","x-workspace":"acme"}';

let workspace: Workspace;

class JsonResponse extends Response {
  constructor(body: unknown, init: ResponseInit = {}) {
    const headers = new Headers(init.headers);
    headers.set("content-type", "application/json");
    super(JSON.stringify(body), { ...init, headers });
  }
}

const CATALOG = {
  items: [
    {
      agentPlatform: "livekit",
      agentPlatformLabel: "LiveKit",
      connectionType: "livekit_room",
      accessVariant: LIVEKIT_KEY_PAIR_VARIANT,
      accessVariantLabel: "LiveKit project credentials [Recommended]",
      modality: "voice",
      productLabel: "LiveKit project credentials",
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
          label: "LiveKit agent name",
          kind: "text",
          required: true,
          help: "The dispatch name.",
          afterCredentials: false,
        },
        {
          key: "metadata",
          label: "Agent metadata",
          kind: "json",
          required: false,
          help: "Room metadata.",
          afterCredentials: true,
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
          help: "The public half.",
        },
        {
          field: "apiSecret",
          label: "API secret",
          kind: "secret",
          required: true,
          help: "The secret half.",
        },
      ],
    },
    {
      agentPlatform: "livekit",
      agentPlatformLabel: "LiveKit",
      connectionType: "livekit_room",
      accessVariant: LIVEKIT_KEY_PAIR_VARIANT,
      accessVariantLabel: "LiveKit project credentials [Recommended]",
      modality: "chat",
      productLabel: "LiveKit chat",
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
          label: "LiveKit agent name",
          kind: "text",
          required: true,
          help: "The dispatch name.",
          afterCredentials: false,
        },
        {
          key: "metadata",
          label: "Agent metadata",
          kind: "json",
          required: false,
          help: "Room metadata.",
          afterCredentials: true,
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
          help: "The public half.",
        },
        {
          field: "apiSecret",
          label: "API secret",
          kind: "secret",
          required: true,
          help: "The secret half.",
        },
      ],
    },
    {
      agentPlatform: "livekit",
      agentPlatformLabel: "LiveKit",
      connectionType: "livekit_room",
      accessVariant: LIVEKIT_TOKEN_ENDPOINT_VARIANT,
      accessVariantLabel: "Customer token endpoint [Advanced]",
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
          help: "One JSON object.",
        },
      ],
    },
  ],
};

type RegistrationBody = {
  readonly name: string;
  readonly agentPlatform: "livekit";
  readonly connection: {
    readonly agentPlatform: "livekit";
    readonly connectionType: "livekit_room";
    readonly accessVariant:
      | typeof LIVEKIT_KEY_PAIR_VARIANT
      | typeof LIVEKIT_TOKEN_ENDPOINT_VARIANT;
    readonly modality: "chat" | "voice";
    readonly config: Readonly<Record<string, string>>;
    readonly credentials: Readonly<Record<string, string>>;
  };
};

function fakePlatform(onRegister?: (body: RegistrationBody) => void | Promise<void>): {
  readonly fetchImpl: typeof fetch;
  readonly registrations: RegistrationBody[];
} {
  const registrations: RegistrationBody[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const requested = new globalThis.URL(String(input));
    if (requested.pathname === "/v1/connection-options") {
      return new JsonResponse(CATALOG);
    }
    if (requested.pathname === "/v1/agents" && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as RegistrationBody;
      registrations.push(body);
      await onRegister?.(body);
      const productLabel =
        body.connection.accessVariant === LIVEKIT_TOKEN_ENDPOINT_VARIANT
          ? "LiveKit token endpoint"
          : body.connection.modality === "chat"
            ? "LiveKit chat"
            : "LiveKit project credentials";
      return new JsonResponse(
        {
          result: "created",
          agent: { id: AGENT_ID, name: body.name, projectId: PROJECT_ID },
          connection: {
            id: CONNECTION_ID,
            name: `livekit_${body.connection.modality}-1`,
            agentPlatform: "livekit",
            connectionType: "livekit_room",
            accessVariant: body.connection.accessVariant,
            modality: body.connection.modality,
            productLabel,
            credentialsHint: "safe-hint",
            config: body.connection.config,
          },
        },
        { status: 201 },
      );
    }
    if (requested.pathname === `/v1/projects/${PROJECT_ID}`) {
      return new JsonResponse({ id: PROJECT_ID, name: "Fixture project" });
    }
    return new JsonResponse({ message: "unexpected request" }, { status: 404 });
  };
  return { fetchImpl, registrations };
}

async function run(
  overrides: Partial<ConnectCommandOptions>,
  fetchImpl: typeof fetch,
): Promise<{ readonly code: number; readonly out: string[]; readonly fail: string[] }> {
  const out: string[] = [];
  const fail: string[] = [];
  const code = await runConnectCommand({
    access: { url: URL, credentialsFile: workspace.credentialsFile },
    cwd: workspace.dir,
    agentId: null,
    lanes: null,
    phoneNumber: null,
    repoPrompt: null,
    platform: "livekit",
    showContext: false,
    modality: null,
    accessVariant: null,
    livekitUrl: null,
    dispatchName: null,
    tokenEndpoint: null,
    metadata: null,
    name: null,
    env: {},
    signal: new AbortController().signal,
    out: (line) => out.push(line),
    fail: (line) => fail.push(line),
    fetchImpl,
    ...overrides,
  });
  return { code, out, fail };
}

beforeEach(async () => {
  workspace = await makeWorkspace();
  await workspace.signIn(URL);
});

afterEach(async () => workspace.remove());

describe("egma connect --platform livekit", () => {
  it("registers project credentials from env and records the target", async () => {
    let boundBeforeRegistration = false;
    const platform = fakePlatform(async () => {
      const config = await readConfig(folderPathsIn(workspace.dir).config);
      boundBeforeRegistration = config.platform?.origin === URL;
    });

    const result = await run(
      {
        modality: "chat",
        name: "front-desk",
        livekitUrl: "wss://acme.livekit.cloud",
        dispatchName: "receptionist",
        metadata: '{"tenant":"acme"}',
        env: {
          [LIVEKIT_API_KEY_VARIABLE]: API_KEY,
          [LIVEKIT_API_SECRET_VARIABLE]: API_SECRET,
        },
      },
      platform.fetchImpl,
    );

    expect(result.code, result.fail.join("\n")).toBe(CONNECT_EXIT.connected);
    expect(boundBeforeRegistration).toBe(true);
    expect(platform.registrations).toHaveLength(1);
    expect(platform.registrations[0]?.connection).toMatchObject({
      accessVariant: LIVEKIT_KEY_PAIR_VARIANT,
      modality: "chat",
      config: {
        url: "wss://acme.livekit.cloud",
        agentName: "receptionist",
        metadata: '{"tenant":"acme"}',
      },
      credentials: { apiKey: API_KEY, apiSecret: API_SECRET },
    });
    expect(result.out).toContain("modality_option: chat");
    expect(result.out).toContain(
      `access_variant_option: ${LIVEKIT_KEY_PAIR_VARIANT} LiveKit project credentials [Recommended]`,
    );
    expect(result.out).toContain(`agent_id: ${AGENT_ID}`);
    expect(result.out).toContain(`connection_id: ${CONNECTION_ID}`);
    expect(result.out).toContain("status: connected");
    expect(result.out.join("\n")).not.toContain(API_KEY);
    expect(result.out.join("\n")).not.toContain(API_SECRET);
    expect(await readConfig(path.join(workspace.dir, "egma", "config.yaml"))).toEqual({
      format: 3,
      platform: { origin: URL },
      project: { id: PROJECT_ID, name: "Fixture project" },
      agents: [
        {
          id: AGENT_ID,
          name: "front-desk",
          connections: [
            {
              id: CONNECTION_ID,
              name: "livekit_chat-1",
              modality: "chat",
            },
          ],
        },
      ],
    });
  });

  it("registers a customer token endpoint with only its env headers", async () => {
    const platform = fakePlatform();
    const result = await run(
      {
        modality: "voice",
        accessVariant: LIVEKIT_TOKEN_ENDPOINT_VARIANT,
        name: "front-desk",
        livekitUrl: "wss://acme.livekit.cloud",
        tokenEndpoint: "https://tokens.example/livekit",
        env: { [LIVEKIT_TOKEN_HEADERS_VARIABLE]: HEADERS },
      },
      platform.fetchImpl,
    );

    expect(result.code, result.fail.join("\n")).toBe(CONNECT_EXIT.connected);
    expect(platform.registrations[0]?.connection).toEqual({
      agentPlatform: "livekit",
      connectionType: "livekit_room",
      accessVariant: LIVEKIT_TOKEN_ENDPOINT_VARIANT,
      modality: "voice",
      config: {
        url: "wss://acme.livekit.cloud",
        tokenEndpoint: "https://tokens.example/livekit",
      },
      credentials: { headers: HEADERS },
    });
    expect(result.out).toContain(
      `access_variant_option: ${LIVEKIT_TOKEN_ENDPOINT_VARIANT} Customer token endpoint [Advanced]`,
    );
    expect(result.out.join("\n")).not.toContain("private-token");
    expect(result.out.at(-1)).toBe("status: connected");
  });

  it("lists the server-owned voice choices and refuses to guess", async () => {
    const platform = fakePlatform();
    const result = await run(
      { modality: "voice" },
      platform.fetchImpl,
    );

    expect(result.code).toBe(CONNECT_EXIT.unchosen);
    expect(result.out).toContain(
      `access_variant_option: ${LIVEKIT_KEY_PAIR_VARIANT} LiveKit project credentials [Recommended]`,
    );
    expect(result.out).toContain(
      `access_variant_option: ${LIVEKIT_TOKEN_ENDPOINT_VARIANT} Customer token endpoint [Advanced]`,
    );
    expect(result.out).toContain("status: unchosen-access-variant");
    expect(platform.registrations).toEqual([]);
    await expect(readConfig(folderPathsIn(workspace.dir).config)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("names missing env secrets and writes no repository folder", async () => {
    const platform = fakePlatform();
    const result = await run(
      {
        modality: "chat",
        name: "front-desk",
        livekitUrl: "wss://acme.livekit.cloud",
        dispatchName: "receptionist",
      },
      platform.fetchImpl,
    );

    expect(result.code).toBe(CONNECT_EXIT.noKey);
    expect(result.out).toContain(`required_secret: ${LIVEKIT_API_KEY_VARIABLE}`);
    expect(result.out).toContain(`required_secret: ${LIVEKIT_API_SECRET_VARIABLE}`);
    expect(result.out).toContain("status: no-credentials");
    expect(platform.registrations).toEqual([]);
    await expect(readConfig(folderPathsIn(workspace.dir).config)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("refuses a LiveKit secret in an argument before any platform request", async () => {
    const platform = fakePlatform();
    const result = await run(
      {
        argv: ["--livekit-api-secret", API_SECRET],
        env: {
          [LIVEKIT_API_KEY_VARIABLE]: API_KEY,
          [LIVEKIT_API_SECRET_VARIABLE]: API_SECRET,
        },
      },
      platform.fetchImpl,
    );

    expect(result.code).toBe(CONNECT_EXIT.noKey);
    expect(result.fail.join("\n")).toContain("readable by every process");
    expect(`${result.out.join("\n")}${result.fail.join("\n")}`).not.toContain(API_SECRET);
    expect(platform.registrations).toEqual([]);
    await expect(readConfig(folderPathsIn(workspace.dir).config)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
