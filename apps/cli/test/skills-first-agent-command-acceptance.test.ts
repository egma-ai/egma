/** Small built-CLI proofs for the skills-first Agent and Connection contract. */

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";

import { expect, it, vi } from "vitest";

import {
  createEgmaFolder,
  EMPTY_CONFIG,
  folderPathsIn,
  readConfig,
} from "../src/folder/egma-folder.ts";
import { startPlatform, type Platform } from "./support/fixture-platform/index.ts";
import {
  CLI_ENTRY,
  makeWorkspace,
  type Workspace,
} from "./support/workspace.ts";

const EGMA_KEY = "egma_sk_agent_acceptance";
const RETELL_KEY = "retell-agent-acceptance-secret";
const TOKEN_HEADER = "Bearer livekit-token-endpoint-secret";

type Result = {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
};

async function egma(
  workspace: Workspace,
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
  expect(result.stdout).not.toContain(secret);
  expect(result.stderr).not.toContain(secret);
}

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

it("registers Agent identity, lists Retell Agents, and adds a separate Connection", async () => {
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
      "Front desk",
    ]);
    expect(registered.code, registered.stderr).toBe(0);
    const agentId = platform.registered.agents[0]?.id ?? "";
    const registration = platform.records.find(
      (record) => record.method === "POST" && record.path === "/v1/agents",
    );
    expect(registration?.body).toEqual({
      name: "Front desk",
      agentPlatform: "retell",
    });
    expect(registration?.body).not.toHaveProperty("connection");

    platform.registered.retellAccount(RETELL_KEY, [
      {
        id: "retell_agent_front_desk",
        name: "Front desk",
        modality: "voice",
        phoneNumbers: ["+14155550100"],
      },
    ]);
    const listed = await egma(
      workspace,
      ["agent", "connection", "options", "--platform", "retell"],
      { env: { EGMA_RETELL_API_KEY: RETELL_KEY } },
    );
    expect(listed.code, listed.stderr).toBe(0);
    expect(listed.stdout).toContain("Front desk (retell_agent_front_desk)");
    expect(listed.stdout).toContain("Phone numbers: +14155550100");
    expect(listed.stdout).toContain("egma agent connection add");
    didNotPrint(listed, RETELL_KEY);

    const added = await egma(
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
        "--retell-agent",
        "retell_agent_front_desk",
        "--credentials-stdin",
      ],
      { input: JSON.stringify({ apiKey: RETELL_KEY }) },
    );
    expect(added.code, added.stderr).toBe(0);
    didNotPrint(added, RETELL_KEY);

    const write = platform.records.find(
      (record) =>
        record.method === "POST" &&
        record.path === `/v1/agents/${agentId}/connections`,
    );
    expect(write?.body).toMatchObject({
      agentPlatform: "retell",
      connectionType: "retell_text_mode",
      accessVariant: "retell_text_mode.api_key",
      modality: "chat",
      platformAgentId: "retell_agent_front_desk",
      credentials: { apiKey: RETELL_KEY },
    });
    expect(
      (await readConfig(folderPathsIn(workspace.dir).config)).agents[0]
        ?.connections,
    ).toHaveLength(1);
    expect(await readFile(folderPathsIn(workspace.dir).config, "utf8")).not.toContain(
      RETELL_KEY,
    );
  } finally {
    await Promise.all([platform.close(), workspace.remove()]);
  }
});

it.each(["voice", "chat"] as const)(
  "adds a %s LiveKit token-endpoint Connection without a LiveKit URL",
  async (modality) => {
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
      const name = `Token ${modality}`;

      const added = await egma(
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
          modality,
          "--name",
          name,
          "--livekit-agent-name",
          "receptionist",
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
      expect(added.code, added.stderr).toBe(0);
      didNotPrint(added, TOKEN_HEADER);

      const write = platform.records.find(
        (record) =>
          record.method === "POST" &&
          record.path === `/v1/agents/${agentId}/connections`,
      );
      expect(write?.body).toMatchObject({
        name,
        agentPlatform: "livekit",
        connectionType: "livekit_room",
        accessVariant: "livekit_room.customer_token_endpoint",
        modality,
        config: {
          tokenEndpoint: "https://tokens.example.com/egma/livekit",
          agentName: "receptionist",
        },
      });
      expect(write?.body?.["config"]).not.toHaveProperty("url");
      expect(write?.body?.["credentials"]).toEqual({
        headers: JSON.stringify({ Authorization: TOKEN_HEADER }),
      });
    } finally {
      await Promise.all([platform.close(), workspace.remove()]);
    }
  },
);
