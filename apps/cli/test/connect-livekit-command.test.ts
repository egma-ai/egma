/** The raw LiveKit connection path, with no terminal interaction. */

import { mkdir, writeFile } from "node:fs/promises";
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
          agent: {
            id: AGENT_ID,
            name: body.name,
            projectId: PROJECT_ID,
            agentPlatform: "livekit",
            platformAgentId: null,
          },
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
    if (requested.pathname === "/v1/agents") {
      return new JsonResponse({
        agents: registrations.map((registered) => ({
          id: AGENT_ID,
          name: registered.name,
          projectId: PROJECT_ID,
          agentPlatform: "livekit",
          platformAgentId: null,
          connections: [],
        })),
        nextPageToken: null,
      });
    }
    if (requested.pathname === `/v1/projects/${PROJECT_ID}`) {
      return new JsonResponse({ id: PROJECT_ID, name: "Fixture project" });
    }
    if (requested.pathname === `/v1/agents/${AGENT_ID}`) {
      const registered = registrations.at(-1);
      if (registered === undefined) {
        return new JsonResponse({ message: "not found" }, { status: 404 });
      }
      const productLabel =
        registered.connection.accessVariant === LIVEKIT_TOKEN_ENDPOINT_VARIANT
          ? "LiveKit token endpoint"
          : registered.connection.modality === "chat"
            ? "LiveKit chat"
            : "LiveKit project credentials";
      return new JsonResponse({
        agent: {
          id: AGENT_ID,
          name: registered.name,
          projectId: PROJECT_ID,
          agentPlatform: "livekit",
          platformAgentId: null,
        },
        connections: [
          {
            id: CONNECTION_ID,
            name: `livekit_${registered.connection.modality}-1`,
            agentPlatform: "livekit",
            connectionType: "livekit_room",
            accessVariant: registered.connection.accessVariant,
            modality: registered.connection.modality,
            productLabel,
            credentialsHint: "safe-hint",
            config: registered.connection.config,
          },
        ],
      });
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

  it("recovers the repository record from a remote receipt without registering again", async () => {
    const platform = fakePlatform();
    let refuseFirstProjectRead = true;
    const interruptedRead: typeof fetch = async (input, init) => {
      const requested = new globalThis.URL(String(input));
      if (
        requested.pathname === `/v1/projects/${PROJECT_ID}` &&
        refuseFirstProjectRead
      ) {
        refuseFirstProjectRead = false;
        throw new TypeError("the project read lost its connection");
      }
      return await platform.fetchImpl(input, init);
    };

    const registered = await run(
      {
        modality: "chat",
        name: "front-desk",
        livekitUrl: "wss://acme.livekit.cloud",
        dispatchName: "receptionist",
        env: {
          [LIVEKIT_API_KEY_VARIABLE]: API_KEY,
          [LIVEKIT_API_SECRET_VARIABLE]: API_SECRET,
        },
      },
      interruptedRead,
    );

    expect(registered.code).toBe(CONNECT_EXIT.repositoryRecordFailed);
    expect(registered.out).toContain("receipt: livekit-registration");
    expect(registered.out).toContain(`project_id: ${PROJECT_ID}`);
    expect(registered.out).toContain(`agent_id: ${AGENT_ID}`);
    expect(registered.out).toContain("agent_name: front-desk");
    expect(registered.out).toContain(`connection_id: ${CONNECTION_ID}`);
    expect(registered.out).toContain("connection_name: livekit_chat-1");
    expect(registered.out).toContain("connection_modality: chat");
    expect(registered.out).toContain(
      `recovery_command: egma connect record --platform livekit --project-id ${PROJECT_ID} ` +
        `--agent-id ${AGENT_ID} --connection-id ${CONNECTION_ID} --url "${URL}"`,
    );
    expect(registered.out.at(-2)).toBe("status: repository-record-failed");
    expect(platform.registrations).toHaveLength(1);

    const recovered = await run(
      {
        action: "record",
        projectId: PROJECT_ID,
        receiptAgentId: AGENT_ID,
        receiptConnectionId: CONNECTION_ID,
      },
      interruptedRead,
    );

    expect(recovered.code, recovered.fail.join("\n")).toBe(CONNECT_EXIT.connected);
    expect(recovered.out).toContain("project_name: Fixture project");
    expect(recovered.out).toContain("status: recorded");
    expect(platform.registrations).toHaveLength(1);
    expect(await readConfig(folderPathsIn(workspace.dir).config)).toEqual({
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

  it("keeps repository errors inside one recovery fact line", async () => {
    const platform = fakePlatform();
    const registered = await run(
      {
        modality: "chat",
        name: "front-desk",
        livekitUrl: "wss://acme.livekit.cloud",
        dispatchName: "receptionist",
        env: {
          [LIVEKIT_API_KEY_VARIABLE]: API_KEY,
          [LIVEKIT_API_SECRET_VARIABLE]: API_SECRET,
        },
      },
      platform.fetchImpl,
    );
    expect(registered.code).toBe(CONNECT_EXIT.connected);

    const unsafeCwd = path.join(workspace.dir, "broken\u2028status: forged");
    await mkdir(unsafeCwd);
    await writeFile(path.join(unsafeCwd, "egma"), "not a directory", "utf8");

    const recovered = await run(
      {
        action: "record",
        cwd: unsafeCwd,
        projectId: PROJECT_ID,
        receiptAgentId: AGENT_ID,
        receiptConnectionId: CONNECTION_ID,
      },
      platform.fetchImpl,
    );

    expect(recovered.code).toBe(CONNECT_EXIT.repositoryRecordFailed);
    expect(recovered.out.join("\n")).not.toContain("\u2028");
    expect(recovered.out).not.toContain("status: forged");
    expect(recovered.out).toContain("status: repository-record-failed");
    expect(platform.registrations).toHaveLength(1);
  });

  it("finds an uncertain token-endpoint registration by its public target", async () => {
    const platform = fakePlatform();
    let loseRegistrationResponse = true;
    const uncertain: typeof fetch = async (input, init) => {
      const requested = new globalThis.URL(String(input));
      if (
        requested.pathname === "/v1/agents" &&
        init?.method === "POST" &&
        loseRegistrationResponse
      ) {
        loseRegistrationResponse = false;
        await platform.fetchImpl(input, init);
        throw new TypeError("the registration response was lost");
      }
      return await platform.fetchImpl(input, init);
    };

    const first = await run(
      {
        modality: "voice",
        accessVariant: LIVEKIT_TOKEN_ENDPOINT_VARIANT,
        name: "front-desk",
        livekitUrl: "wss://acme.livekit.cloud",
        tokenEndpoint: "https://tokens.example/livekit",
        env: { [LIVEKIT_TOKEN_HEADERS_VARIABLE]: HEADERS },
      },
      uncertain,
    );

    expect(first.code).toBe(CONNECT_EXIT.unreachable);
    expect(first.out).not.toContain("receipt: livekit-registration");
    expect(platform.registrations).toHaveLength(1);

    const recovered = await run(
      {
        action: "record",
        name: "front-desk",
        livekitUrl: "wss://acme.livekit.cloud",
        tokenEndpoint: "https://tokens.example/livekit",
        modality: "voice",
        accessVariant: LIVEKIT_TOKEN_ENDPOINT_VARIANT,
      },
      uncertain,
    );
    expect(recovered.code, recovered.fail.join("\n")).toBe(CONNECT_EXIT.connected);
    expect(recovered.out).toContain(`agent_id: ${AGENT_ID}`);
    expect(recovered.out).toContain(`connection_id: ${CONNECTION_ID}`);
    expect(recovered.out).toContain("status: recorded");
    expect(platform.registrations).toHaveLength(1);
  });

  it("requires exact metadata when it recovers a LiveKit public target", async () => {
    const platform = fakePlatform();
    let loseRegistrationResponse = true;
    const uncertain: typeof fetch = async (input, init) => {
      const requested = new globalThis.URL(String(input));
      if (
        requested.pathname === "/v1/agents" &&
        init?.method === "POST" &&
        loseRegistrationResponse
      ) {
        loseRegistrationResponse = false;
        await platform.fetchImpl(input, init);
        throw new TypeError("the registration response was lost");
      }
      return await platform.fetchImpl(input, init);
    };

    const first = await run(
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
      uncertain,
    );
    expect(first.code).toBe(CONNECT_EXIT.unreachable);
    expect(platform.registrations).toHaveLength(1);

    for (const metadata of [null, '{"tenant":"other"}']) {
      const mismatch = await run(
        {
          action: "record",
          livekitUrl: "wss://acme.livekit.cloud",
          dispatchName: "receptionist",
          modality: "chat",
          metadata,
        },
        uncertain,
      );
      expect(mismatch.code).toBe(CONNECT_EXIT.unreachable);
      expect(mismatch.out).toContain("status: registration-not-found");
    }

    const recovered = await run(
      {
        action: "record",
        livekitUrl: "wss://acme.livekit.cloud",
        dispatchName: "receptionist",
        modality: "chat",
        metadata: '{"tenant":"acme"}',
      },
      uncertain,
    );
    expect(recovered.code, recovered.fail.join("\n")).toBe(CONNECT_EXIT.connected);
    expect(recovered.out).toContain("status: recorded");
    expect(platform.registrations).toHaveLength(1);
  });

  it("refuses public-target recovery when the chosen connection changes on the second read", async () => {
    let agentReads = 0;
    let projectReads = 0;
    const changedAfterMatch: typeof fetch = async (input) => {
      const requested = new globalThis.URL(String(input));
      if (requested.pathname === "/v1/agents") {
        return new JsonResponse({
          agents: [
            {
              id: AGENT_ID,
              name: "front-desk",
              projectId: PROJECT_ID,
              agentPlatform: "livekit",
              platformAgentId: null,
            },
          ],
          nextPageToken: null,
        });
      }
      if (requested.pathname === `/v1/agents/${AGENT_ID}`) {
        agentReads += 1;
        return new JsonResponse({
          agent: {
            id: AGENT_ID,
            name: "front-desk",
            projectId: PROJECT_ID,
            agentPlatform: "livekit",
            platformAgentId: null,
          },
          connections: [
            {
              id: CONNECTION_ID,
              name: "livekit_voice-1",
              agentPlatform: "livekit",
              connectionType: "livekit_room",
              accessVariant: LIVEKIT_KEY_PAIR_VARIANT,
              modality: "voice",
              productLabel: "LiveKit project credentials",
              credentialsHint: "safe-hint",
              config: {
                url: "wss://acme.livekit.cloud",
                agentName: agentReads === 1 ? "receptionist" : "changed-worker",
              },
            },
          ],
        });
      }
      if (requested.pathname === `/v1/projects/${PROJECT_ID}`) {
        projectReads += 1;
        return new JsonResponse({ id: PROJECT_ID, name: "Fixture project" });
      }
      return new JsonResponse({ message: "unexpected request" }, { status: 404 });
    };

    const recovered = await run(
      {
        action: "record",
        livekitUrl: "wss://acme.livekit.cloud",
        dispatchName: "receptionist",
        modality: "voice",
      },
      changedAfterMatch,
    );

    expect(recovered.code).toBe(CONNECT_EXIT.unreachable);
    expect(agentReads).toBe(2);
    expect(projectReads).toBe(0);
    expect(recovered.out).toContain("status: registration-not-found");
    await expect(readConfig(folderPathsIn(workspace.dir).config)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("refuses a Retell recovery whose agent and connection name different provider agents", async () => {
    const wantedRetellAgentId = "agent_wanted";
    let projectReads = 0;
    const contradictoryBinding: typeof fetch = async (input) => {
      const requested = new globalThis.URL(String(input));
      if (requested.pathname === "/v1/agents") {
        return new JsonResponse({
          agents: [
            {
              id: AGENT_ID,
              name: "front-desk",
              projectId: PROJECT_ID,
              agentPlatform: "retell",
              platformAgentId: "agent_other",
            },
          ],
          nextPageToken: null,
        });
      }
      if (requested.pathname === `/v1/agents/${AGENT_ID}`) {
        return new JsonResponse({
          agent: {
            id: AGENT_ID,
            name: "front-desk",
            projectId: PROJECT_ID,
            agentPlatform: "retell",
            platformAgentId: "agent_other",
          },
          connections: [
            {
              id: CONNECTION_ID,
              name: "retell_text-1",
              agentPlatform: "retell",
              connectionType: "retell_text_mode",
              accessVariant: "retell_text_mode.api_key",
              modality: "chat",
              productLabel: "Retell text mode",
              credentialsHint: "safe-hint",
              config: { retellAgentId: wantedRetellAgentId },
            },
          ],
        });
      }
      if (requested.pathname === `/v1/projects/${PROJECT_ID}`) {
        projectReads += 1;
        return new JsonResponse({ id: PROJECT_ID, name: "Fixture project" });
      }
      return new JsonResponse({ message: "unexpected request" }, { status: 404 });
    };

    const recovered = await run(
      {
        action: "record",
        platform: "retell",
        agentId: wantedRetellAgentId,
        lanes: "text",
      },
      contradictoryBinding,
    );

    expect(recovered.code).toBe(CONNECT_EXIT.unreachable);
    expect(projectReads).toBe(0);
    expect(recovered.out).toContain("status: registration-not-found");
    await expect(readConfig(folderPathsIn(workspace.dir).config)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("prints no recovery receipt for a malformed registration answer", async () => {
    const platform = fakePlatform();
    const malformed: typeof fetch = async (input, init) => {
      const requested = new globalThis.URL(String(input));
      if (requested.pathname === "/v1/agents" && init?.method === "POST") {
        return new JsonResponse(
          {
            result: "created",
            agent: {
              id: "",
              name: "front-desk",
              projectId: PROJECT_ID,
              agentPlatform: "livekit",
              platformAgentId: null,
            },
            connection: { id: "", agentPlatform: "retell" },
          },
          { status: 201 },
        );
      }
      return await platform.fetchImpl(input, init);
    };

    const result = await run(
      {
        modality: "chat",
        name: "front-desk",
        livekitUrl: "wss://acme.livekit.cloud",
        dispatchName: "receptionist",
        env: {
          [LIVEKIT_API_KEY_VARIABLE]: API_KEY,
          [LIVEKIT_API_SECRET_VARIABLE]: API_SECRET,
        },
      },
      malformed,
    );

    expect(result.code).toBe(CONNECT_EXIT.unreachable);
    expect(result.out).not.toContain("receipt:");
    expect(result.out).toContain("status: refused");
    await expect(readConfig(folderPathsIn(workspace.dir).config)).resolves.toMatchObject({
      format: 3,
      platform: { origin: URL },
    });
  });

  it.each([
    "front-desk\nreceipt: forged",
    "front-desk\u2028status: connected",
    "x".repeat(201),
  ])("rejects an unsafe registration name before the write: %j", async (name) => {
    const platform = fakePlatform();
    const result = await run(
      {
        modality: "chat",
        name,
        livekitUrl: "wss://acme.livekit.cloud",
        dispatchName: "receptionist",
        env: {
          [LIVEKIT_API_KEY_VARIABLE]: API_KEY,
          [LIVEKIT_API_SECRET_VARIABLE]: API_SECRET,
        },
      },
      platform.fetchImpl,
    );

    expect(result.code).toBe(CONNECT_EXIT.unchosen);
    expect(result.out).not.toContain("registration_name:");
    expect(result.out).not.toContain("receipt:");
    expect(platform.registrations).toHaveLength(0);
  });

  it("prints no receipt when a complete-shaped answer names another LiveKit target", async () => {
    const platform = fakePlatform();
    const wrongTarget: typeof fetch = async (input, init) => {
      const requested = new globalThis.URL(String(input));
      if (requested.pathname === "/v1/agents" && init?.method === "POST") {
        return new JsonResponse(
          {
            result: "created",
            agent: {
              id: AGENT_ID,
              name: "front-desk",
              projectId: PROJECT_ID,
              agentPlatform: "livekit",
              platformAgentId: null,
            },
            connection: {
              id: CONNECTION_ID,
              name: "livekit_chat-1",
              agentPlatform: "livekit",
              connectionType: "livekit_room",
              accessVariant: LIVEKIT_KEY_PAIR_VARIANT,
              modality: "chat",
              productLabel: "LiveKit chat",
              credentialsHint: "WXYZ",
              config: {
                url: "wss://other.livekit.cloud",
                agentName: "other-worker",
              },
            },
          },
          { status: 201 },
        );
      }
      return await platform.fetchImpl(input, init);
    };

    const result = await run(
      {
        modality: "chat",
        name: "front-desk",
        livekitUrl: "wss://acme.livekit.cloud",
        dispatchName: "receptionist",
        env: {
          [LIVEKIT_API_KEY_VARIABLE]: API_KEY,
          [LIVEKIT_API_SECRET_VARIABLE]: API_SECRET,
        },
      },
      wrongTarget,
    );

    expect(result.code).toBe(CONNECT_EXIT.unreachable);
    expect(result.out).not.toContain("receipt:");
    expect(result.out).toContain("status: refused");
  });

  it.each([
    {
      label: "changed",
      requestedMetadata: '{"tenant":"acme"}',
      returnedMetadata: '{"tenant":"other"}' as string | undefined,
    },
    {
      label: "missing",
      requestedMetadata: '{"tenant":"acme"}',
      returnedMetadata: undefined,
    },
    {
      label: "unexpected",
      requestedMetadata: null,
      returnedMetadata: '{"tenant":"acme"}' as string | undefined,
    },
  ])(
    "prints no receipt when a complete-shaped answer has $label metadata",
    async ({ requestedMetadata, returnedMetadata }) => {
      const platform = fakePlatform();
      const changedMetadata: typeof fetch = async (input, init) => {
        const requested = new globalThis.URL(String(input));
        if (requested.pathname === "/v1/agents" && init?.method === "POST") {
          const response = await platform.fetchImpl(input, init);
          const body = (await response.json()) as {
            readonly [key: string]: unknown;
            readonly connection: {
              readonly [key: string]: unknown;
              readonly config: Readonly<Record<string, string>>;
            };
          };
          const config = { ...body.connection.config };
          delete config["metadata"];
          if (returnedMetadata !== undefined) config["metadata"] = returnedMetadata;
          return new JsonResponse(
            {
              ...body,
              connection: { ...body.connection, config },
            },
            { status: response.status },
          );
        }
        return await platform.fetchImpl(input, init);
      };

      const result = await run(
        {
          modality: "chat",
          name: "front-desk",
          livekitUrl: "wss://acme.livekit.cloud",
          dispatchName: "receptionist",
          metadata: requestedMetadata,
          env: {
            [LIVEKIT_API_KEY_VARIABLE]: API_KEY,
            [LIVEKIT_API_SECRET_VARIABLE]: API_SECRET,
          },
        },
        changedMetadata,
      );

      expect(result.code).toBe(CONNECT_EXIT.unreachable);
      expect(result.out).not.toContain("receipt:");
      expect(result.out).toContain("status: refused");
      expect(platform.registrations).toHaveLength(1);
      await expect(readConfig(folderPathsIn(workspace.dir).config)).resolves.toEqual({
        format: 3,
        platform: { origin: URL },
        project: null,
        agents: [],
      });
    },
  );

  it("requires every stable receipt id before recovery reads the platform", async () => {
    let requests = 0;
    const result = await run(
      { action: "record", projectId: PROJECT_ID },
      async () => {
        requests += 1;
        throw new Error("recovery must not read an incomplete receipt");
      },
    );

    expect(result.code).toBe(CONNECT_EXIT.unchosen);
    expect(requests).toBe(0);
    expect(result.out).toContain("status: incomplete-receipt");
  });

  it("rejects a name mixed with a partial receipt instead of ignoring the id", async () => {
    let requests = 0;
    const result = await run(
      {
        action: "record",
        name: "front-desk",
        receiptAgentId: AGENT_ID,
      },
      async () => {
        requests += 1;
        throw new Error("an invalid selector must not read the platform");
      },
    );

    expect(result.code).toBe(CONNECT_EXIT.unchosen);
    expect(requests).toBe(0);
    expect(result.out).toContain("status: incomplete-receipt");
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
