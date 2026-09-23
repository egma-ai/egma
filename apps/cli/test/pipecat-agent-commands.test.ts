/**
 * Built-CLI proofs for Pipecat agents: register, the two access values, their
 * flags and credential sources, the option listing, and monitoring's handoff.
 */

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createEgmaFolder,
  EMPTY_CONFIG,
  folderPathsIn,
  readConfig,
} from "../src/folder/egma-folder.ts";
import { startPlatform, type Platform } from "./support/fixture-platform/index.ts";
import { CLI_ENTRY, makeWorkspace, type Workspace } from "./support/workspace.ts";

const EGMA_KEY = "egma_sk_pipecat_acceptance";
const PUBLIC_KEY = "pk_fixture0not0a0real0public0key";
const START_HEADER = "Bearer pipecat-start-secret";
const START_URL = "https://bots.lakeside-dental.example/start";

type Result = {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
};

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let platform: Platform;
let workspace: Workspace;

beforeEach(async () => {
  [platform, workspace] = await Promise.all([startPlatform(), makeWorkspace()]);
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
});

afterEach(async () => {
  await Promise.all([platform.close(), workspace.remove()]);
});

async function egma(
  args: readonly string[],
  options: { readonly input?: string; readonly env?: NodeJS.ProcessEnv } = {},
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

function didNotPrint(result: Result, secret: string): void {
  expect(result.stdout).not.toContain(secret);
  expect(result.stderr).not.toContain(secret);
}

async function registered(): Promise<string> {
  const result = await egma(["agent", "register", "--platform", "pipecat", "--name", "Front desk"]);
  expect(result.code, result.stderr).toBe(0);
  return platform.registered.agents[0]?.id ?? "";
}

function lastConnectionWrite(agentId: string) {
  return platform.records.findLast(
    (record) => record.method === "POST" && record.path === `/v1/agents/${agentId}/connections`,
  );
}

describe("a Pipecat agent from the CLI", () => {
  it("registers with --platform pipecat and lists it in config.yaml", async () => {
    const agentId = await registered();

    const registration = platform.records.find(
      (record) => record.method === "POST" && record.path === "/v1/agents",
    );
    expect(registration?.body).toEqual({ name: "Front desk", agentPlatform: "pipecat" });
    expect((await readConfig(folderPathsIn(workspace.dir).config)).agents).toEqual([
      { id: agentId, name: "Front desk", platform: "pipecat", connections: [] },
    ]);
    expect(await readFile(folderPathsIn(workspace.dir).config, "utf8")).toContain(
      "platform: pipecat",
    );
  });

  it("refuses an unknown platform with the three choices", async () => {
    const result = await egma(["agent", "register", "--platform", "vapi"]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      "Choose --platform retell, --platform livekit or --platform pipecat.",
    );
    expect(platform.records.some((record) => record.path === "/v1/agents")).toBe(false);
  });

  it.each(["voice", "chat"] as const)(
    "adds a %s Pipecat Cloud connection with the key from EGMA_PIPECAT_PUBLIC_KEY",
    async (modality) => {
      const agentId = await registered();

      const added = await egma(
        [
          "agent",
          "connection",
          "add",
          "--agent",
          agentId,
          "--access",
          "pipecat-cloud",
          "--modality",
          modality,
          "--pipecat-agent-name",
          "lakeside-front-desk",
        ],
        { env: { EGMA_PIPECAT_PUBLIC_KEY: PUBLIC_KEY } },
      );

      expect(added.code, added.stderr).toBe(0);
      didNotPrint(added, PUBLIC_KEY);
      const name = modality === "voice" ? "Pipecat Cloud" : "Pipecat Cloud chat";
      expect(lastConnectionWrite(agentId)?.body).toEqual({
        name,
        agentPlatform: "pipecat",
        connectionType: "daily_room",
        accessVariant: "daily_room.pipecat_cloud",
        modality,
        config: { agentName: "lakeside-front-desk" },
        credentials: { publicApiKey: PUBLIC_KEY },
      });
      expect(added.stdout).toContain(`Added Connection ${JSON.stringify(name)}`);
      expect(
        (await readConfig(folderPathsIn(workspace.dir).config)).agents[0]?.connections,
      ).toHaveLength(1);
      expect(await readFile(folderPathsIn(workspace.dir).config, "utf8")).not.toContain(PUBLIC_KEY);
    },
  );

  it("reads the Pipecat Cloud key from standard input", async () => {
    const agentId = await registered();

    const added = await egma(
      [
        "agent",
        "connection",
        "add",
        "--agent",
        agentId,
        "--access",
        "pipecat-cloud",
        "--modality",
        "voice",
        "--pipecat-agent-name",
        "lakeside-front-desk",
        "--credentials-stdin",
      ],
      { input: JSON.stringify({ publicApiKey: PUBLIC_KEY }), env: { EGMA_PIPECAT_PUBLIC_KEY: "pk_ignored_when_stdin" } },
    );

    expect(added.code, added.stderr).toBe(0);
    expect(lastConnectionWrite(agentId)?.body?.["credentials"]).toEqual({ publicApiKey: PUBLIC_KEY });
  });

  it.each(["voice", "chat"] as const)(
    "adds a %s self-hosted connection with headers from EGMA_PIPECAT_START_HEADERS",
    async (modality) => {
      const agentId = await registered();
      const headers = JSON.stringify({ Authorization: START_HEADER });

      const added = await egma(
        [
          "agent",
          "connection",
          "add",
          "--agent",
          agentId,
          "--access",
          "pipecat-self-hosted",
          "--modality",
          modality,
          "--pipecat-start-url",
          START_URL,
        ],
        { env: { EGMA_PIPECAT_START_HEADERS: headers } },
      );

      expect(added.code, added.stderr).toBe(0);
      didNotPrint(added, START_HEADER);
      expect(lastConnectionWrite(agentId)?.body).toEqual({
        name: modality === "voice" ? "Pipecat self-hosted" : "Pipecat self-hosted chat",
        agentPlatform: "pipecat",
        connectionType: "daily_room",
        accessVariant: "daily_room.self_hosted",
        modality,
        config: { startUrl: START_URL },
        credentials: { headers },
      });
      expect(platform.registered.connections[0]?.credentialsHint).toBe("Authorization");
    },
  );

  it("reads self-hosted headers from standard input as an object, sent as text", async () => {
    const agentId = await registered();

    const added = await egma(
      [
        "agent",
        "connection",
        "add",
        "--agent",
        agentId,
        "--access",
        "pipecat-self-hosted",
        "--modality",
        "chat",
        "--pipecat-start-url",
        START_URL,
        "--credentials-stdin",
      ],
      { input: JSON.stringify({ headers: { Authorization: START_HEADER } }) },
    );

    expect(added.code, added.stderr).toBe(0);
    expect(lastConnectionWrite(agentId)?.body?.["credentials"]).toEqual({
      headers: JSON.stringify({ Authorization: START_HEADER }),
    });
  });

  it.each([
    {
      name: "a missing agent name",
      args: ["--access", "pipecat-cloud", "--modality", "voice"],
      env: { EGMA_PIPECAT_PUBLIC_KEY: PUBLIC_KEY },
      said: "--pipecat-agent-name is required for this connection.",
    },
    {
      name: "a missing start URL",
      args: ["--access", "pipecat-self-hosted", "--modality", "voice"],
      env: { EGMA_PIPECAT_START_HEADERS: '{"Authorization":"Bearer x"}' },
      said: "--pipecat-start-url is required for this connection.",
    },
    {
      name: "a missing public key",
      args: ["--access", "pipecat-cloud", "--modality", "voice", "--pipecat-agent-name", "desk"],
      env: {},
      said: "EGMA_PIPECAT_PUBLIC_KEY is required for this connection.",
    },
    {
      name: "missing start headers",
      args: ["--access", "pipecat-self-hosted", "--modality", "chat", "--pipecat-start-url", START_URL],
      env: {},
      said: "EGMA_PIPECAT_START_HEADERS is required for this connection.",
    },
    {
      name: "start headers that are not a JSON object",
      args: ["--access", "pipecat-self-hosted", "--modality", "chat", "--pipecat-start-url", START_URL],
      env: { EGMA_PIPECAT_START_HEADERS: "Bearer x" },
      said: "EGMA_PIPECAT_START_HEADERS must be one JSON object.",
    },
    {
      name: "a LiveKit flag",
      args: [
        "--access",
        "pipecat-cloud",
        "--modality",
        "voice",
        "--pipecat-agent-name",
        "desk",
        "--livekit-agent-name",
        "desk",
      ],
      env: { EGMA_PIPECAT_PUBLIC_KEY: PUBLIC_KEY },
      said: "--livekit-agent-name does not apply to this Connection option.",
    },
    {
      name: "the other variant's flag",
      args: [
        "--access",
        "pipecat-cloud",
        "--modality",
        "voice",
        "--pipecat-agent-name",
        "desk",
        "--pipecat-start-url",
        START_URL,
      ],
      env: { EGMA_PIPECAT_PUBLIC_KEY: PUBLIC_KEY },
      said: "--pipecat-start-url does not apply to this Connection option.",
    },
  ])("refuses $name before any write", async ({ args, env, said }) => {
    const agentId = await registered();

    const result = await egma(["agent", "connection", "add", "--agent", agentId, ...args], { env });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(said);
    expect(lastConnectionWrite(agentId)).toBeUndefined();
  });

  it("relays the platform's refusal of a private key", async () => {
    const agentId = await registered();

    const result = await egma(
      [
        "agent",
        "connection",
        "add",
        "--agent",
        agentId,
        "--access",
        "pipecat-cloud",
        "--modality",
        "voice",
        "--pipecat-agent-name",
        "desk",
      ],
      { env: { EGMA_PIPECAT_PUBLIC_KEY: "sk_private0key0value" } },
    );

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("a private key (sk_) is never needed");
    didNotPrint(result, "sk_private0key0value");
  });

  it("keeps Pipecat flags off a LiveKit agent", async () => {
    const register = await egma(["agent", "register", "--platform", "livekit", "--name", "Receptionist"]);
    expect(register.code, register.stderr).toBe(0);
    const agentId = platform.registered.agents[0]?.id ?? "";

    const result = await egma(
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
        "--livekit-agent-name",
        "receptionist",
        "--livekit-token-endpoint",
        "https://tokens.example.com/egma",
        "--pipecat-agent-name",
        "receptionist",
      ],
      { env: { EGMA_LIVEKIT_TOKEN_ENDPOINT_HEADERS: '{"Authorization":"Bearer x"}' } },
    );

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("--pipecat-agent-name does not apply to this Connection option.");
  });

  it("lists the Pipecat options with their flags, credential sources and egma agent dev", async () => {
    const listed = await egma(["agent", "connection", "options", "--platform", "pipecat"]);

    expect(listed.code, listed.stderr).toBe(0);
    expect(listed.stdout).toContain("Pipecat connection options");
    for (const line of [
      "Pipecat Cloud (voice)",
      "Pipecat Cloud chat (chat)",
      "Pipecat self-hosted (voice)",
      "Pipecat self-hosted chat (chat)",
      "  Access: pipecat-cloud",
      "  Access: pipecat-self-hosted",
      "  --pipecat-agent-name (required): As in pcc-deploy.toml.",
      "  --pipecat-start-url (required): Public HTTPS URL of your bot starter.",
      "  Credential field publicApiKey (required): Starts with pk_.",
      "  Credential field headers (required): Sent with every start request.",
      "  Credential environment: EGMA_PIPECAT_PUBLIC_KEY",
      "  Credential environment: EGMA_PIPECAT_START_HEADERS",
      "egma agent connection add --agent '<Egma Agent ID>' --access pipecat-cloud --modality voice --pipecat-agent-name '<Pipecat Cloud agent name>'",
      "egma agent connection add --agent '<Egma Agent ID>' --access pipecat-self-hosted --modality chat --pipecat-start-url '<Start URL>'",
      "egma agent dev --agent '<Egma Agent ID>' --port 7860",
    ]) {
      expect(listed.stdout, line).toContain(line);
    }
    expect(listed.stdout).not.toContain("Credential guidance");
    expect(listed.stdout).not.toContain("livekit");
  });

  it("still lists LiveKit options alone when the catalog also holds Pipecat", async () => {
    const listed = await egma(["agent", "connection", "options", "--platform", "livekit"]);

    expect(listed.code, listed.stderr).toBe(0);
    expect(listed.stdout).toContain("LiveKit connection options");
    expect(listed.stdout).not.toContain("pipecat");
    expect(listed.stdout).not.toContain("Pipecat");
  });

  it("hands Pipecat monitoring to the integrate-egma skill, as LiveKit's", async () => {
    const agentId = await registered();

    for (const action of ["setup", "stop"] as const) {
      const result = await egma(["agent", "monitoring", action, "--agent", agentId, "--platform", "pipecat"]);
      expect(result.code).toBe(1);
      expect(result.stdout).toContain(
        `Egma CLI does not perform Pipecat monitoring ${action === "setup" ? "setup" : "removal"}.`,
      );
      expect(result.stdout).toContain("npx --yes skills add egma-ai/egma --skill integrate-egma");
    }
  });
});
