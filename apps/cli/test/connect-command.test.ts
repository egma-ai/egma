/**
 * `egma connect` as a coding agent runs it: the built command, in a real
 * subprocess, against a fixture of egma's public HTTP API and a fake Retell.
 *
 * Nothing here is a terminal and nothing here answers a question, because the
 * whole promise of the verb is that neither is needed. What is asserted is the
 * two things something driving it can act on — the lines it prints and the
 * number it exits with — plus the one thing a developer cares about more than
 * either: that the key never appears in the process table.
 */

import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CONNECT_EXIT,
  runConnectCommand,
  type ConnectCommandOptions,
} from "../src/commands/connect.ts";
import { folderPathsIn, readConfig } from "../src/folder/egma-folder.ts";
import { addConnection, readAgent } from "../src/platform/agents.ts";
import { ConnectionCredentials } from "../src/platform/connection-credentials.ts";
import { readProject } from "../src/platform/projects.ts";
import { DRIFT_LINE } from "../src/retell/prompt-drift.ts";
import { startFakeRetell, type FakeRetell, type FakeRetellScript } from "./support/fake-retell.ts";
import { startPlatform, type Platform } from "./support/fixture-platform/index.ts";
import { CLI_ENTRY, MANIFEST, makeWorkspace, type Workspace } from "./support/workspace.ts";

const KEY = "key_1f4c9b7e2a6d0538c1e7";
const LIVEKIT_API_KEY = "APIhx4bmvHnLcWXYZ";
const LIVEKIT_API_SECRET = "livekit-secret-E5F6G7H8QRST";
const PROMPT = "You answer the order line.\nNever quote a price.\n";
const DIALLED = "+14155550111";

const ONE_AGENT: FakeRetellScript = {
  keys: [KEY],
  agents: [
    {
      agent_id: "agent_0001",
      agent_name: "order-line",
      voice_id: "11labs-Adrian",
      response_engine: { type: "retell-llm", llm_id: "llm_0001" },
    },
  ],
  llms: [{ llm_id: "llm_0001", general_prompt: PROMPT, general_tools: [{ type: "end_call" }] }],
  numbers: [
    {
      phone_number: DIALLED,
      nickname: "order line",
      inbound_agents: [{ agent_id: "agent_0001" }],
    },
  ],
};

const VOICE_AGENT: FakeRetellScript = {
  ...ONE_AGENT,
  agents: ONE_AGENT.agents.map((agent) => ({ ...agent, channel: "voice" as const })),
};

const TWO_AGENTS: FakeRetellScript = {
  keys: [KEY],
  agents: [
    { agent_id: "agent_0001", agent_name: "order-line", response_engine: { type: "retell-llm", llm_id: "llm_0001" } },
    { agent_id: "agent_0002", agent_name: "after-hours", response_engine: { type: "retell-llm", llm_id: "llm_0001" } },
  ],
  llms: [{ llm_id: "llm_0001", general_prompt: PROMPT }],
};

let platform: Platform;
let workspace: Workspace;
let retell: FakeRetell | undefined;

beforeEach(async () => {
  platform = await startPlatform();
  workspace = await makeWorkspace({ "package.json": MANIFEST });
  await workspace.signIn(platform.url, platform.device.mint());
});

afterEach(async () => {
  await retell?.close();
  retell = undefined;
  await platform.close();
  await workspace.remove();
});

type Result = { stdout: string; stderr: string; code: number };

/**
 * The built command, with everything it is allowed to read set on purpose.
 *
 * The platform is named on every invocation, because a flag on the command is
 * the one way to name one. Both key variables are cleared unless a check sets
 * one, so a machine that happens to have a real Retell key in its environment
 * cannot make a check about a missing key pass.
 */
function egma(
  args: readonly string[],
  options: { readonly env?: NodeJS.ProcessEnv; readonly stdin?: string } = {},
): Promise<Result> {
  const env = workspace.env({
    ...(retell === undefined ? {} : { EGMA_RETELL_URL: retell.url }),
    // Every check written before there was a choice is about the connection
    // egma made then, and that is the text one. The checks that are about the
    // choice itself say so in their own arguments, which win over this.
    EGMA_LANES: "text",
    ...options.env,
  });

  const child = spawn(process.execPath, [CLI_ENTRY, "--url", platform.url, ...args], {
    cwd: workspace.dir,
    env,
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

  child.stdin.end(options.stdin ?? "");

  return new Promise((resolve) => {
    child.on("close", (code) => resolve({ stdout, stderr, code: code ?? 0 }));
  });
}

/** The printed lines, read the way something driving the command reads them. */
function facts(stdout: string): Record<string, string> {
  const read: Record<string, string> = {};
  for (const line of stdout.trimEnd().split("\n")) {
    const at = line.indexOf(": ");
    if (at > 0) read[line.slice(0, at)] = line.slice(at + 2);
  }
  return read;
}

async function runDirect(
  overrides: Partial<ConnectCommandOptions>,
  fetchImpl: typeof fetch,
): Promise<{ readonly code: number; readonly out: string[]; readonly fail: string[] }> {
  const out: string[] = [];
  const fail: string[] = [];
  const code = await runConnectCommand({
    access: { url: platform.url, credentialsFile: workspace.credentialsFile },
    cwd: workspace.dir,
    agentId: null,
    lanes: "phone",
    phoneNumber: DIALLED,
    repoPrompt: null,
    platform: "retell",
    action: null,
    showContext: false,
    env: { EGMA_RETELL_API_KEY: KEY },
    signal: new AbortController().signal,
    retell: retell === undefined ? undefined : { url: retell.url },
    out: (line) => out.push(line),
    fail: (line) => fail.push(line),
    fetchImpl,
    ...overrides,
  });
  return { code, out, fail };
}

/** Put one same-name Retell row on Egma without a connection or provider binding. */
async function createEmptyRetellAgent(): Promise<{ readonly id: string }> {
  const created = await fetch(`${platform.url}/v1/agents`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${platform.device.keys[0] ?? ""}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ name: "order-line", agentPlatform: "retell" }),
  });
  expect(created.status).toBe(201);
  const body = await created.json() as {
    readonly agent: { readonly id: string };
  };
  return body.agent;
}

describe("platform receipts used by connect", () => {
  it("refuses a project read whose receipt names a different project ID", async () => {
    const wrongProject: typeof fetch = async () => new Response(
      JSON.stringify({ id: "prj_answered", name: "Other project" }),
      { status: 200, headers: { "content-type": "application/json" } },
    );

    await expect(
      readProject(
        { url: platform.url, key: platform.device.mint() },
        "prj_requested",
        wrongProject,
      ),
    ).rejects.toThrow("different project ID");
  });

  it("refuses an agent read whose receipt names a different agent ID", async () => {
    const wrongAgent: typeof fetch = async () => new Response(
      JSON.stringify({
        agent: {
          id: "agt_answered",
          name: "front-desk",
          projectId: "prj_safe",
          agentPlatform: "livekit",
          platformAgentId: null,
        },
        connections: [],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );

    const result = await readAgent("agt_requested", {
      url: platform.url,
      key: platform.device.mint(),
      fetchImpl: wrongAgent,
    });

    expect(result).toEqual({
      kind: "refused",
      reason: expect.stringContaining("different agent ID"),
    });
  });

  it("refuses an agent read without a connection list", async () => {
    const missingConnections: typeof fetch = async () => new Response(
      JSON.stringify({
        agent: {
          id: "agt_requested",
          name: "front-desk",
          projectId: "prj_safe",
          agentPlatform: "livekit",
          platformAgentId: null,
        },
        connections: null,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );

    const result = await readAgent("agt_requested", {
      url: platform.url,
      key: platform.device.mint(),
      fetchImpl: missingConnections,
    });

    expect(result).toEqual({
      kind: "refused",
      reason: expect.stringContaining("complete connection list"),
    });
  });

  it.each([
    {
      field: "agent",
      agentId: "agt_safe;touch_owned",
      projectId: "prj_safe",
      connectionId: "con_safe",
    },
    {
      field: "project",
      agentId: "agt_safe",
      projectId: "prj unsafe",
      connectionId: "con_safe",
    },
    {
      field: "connection",
      agentId: "agt_safe",
      projectId: "prj_safe",
      connectionId: "con_$(touch_owned)",
    },
  ])("prints no recovery command for an unsafe platform $field ID", async ({
    agentId,
    projectId,
    connectionId,
  }) => {
    retell = await startFakeRetell(VOICE_AGENT);
    const unsafeReceipt: typeof fetch = async (input, init) => {
      const requested = new globalThis.URL(String(input));
      if (requested.pathname === "/v1/agents" && init?.method === "POST") {
        return new Response(
          JSON.stringify({
            result: "created",
            agent: {
              id: agentId,
              name: "order-line",
              projectId,
              agentPlatform: "retell",
              platformAgentId: "agent_0001",
            },
            connection: {
              id: connectionId,
              name: "retell_text_mode-1",
              agentPlatform: "retell",
              connectionType: "retell_text_mode",
              accessVariant: "retell_text_mode.api_key",
              modality: "chat",
              productLabel: "Retell text mode",
              credentialsHint: "safe",
              config: { retellAgentId: "agent_0001" },
            },
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        );
      }
      if (requested.pathname.endsWith("/connections") && init?.method === "POST") {
        throw new TypeError("the later lane did not answer");
      }
      return await fetch(input, init);
    };

    const result = await runDirect(
      { lanes: "text,web-call", phoneNumber: null },
      unsafeReceipt,
    );

    expect(result.code).toBe(CONNECT_EXIT.unreachable);
    expect(result.out).not.toContain("receipt: retell-registration");
    expect(result.out.some((line) => line.startsWith("recovery_command:"))).toBe(false);
  });
});

describe("egma connect", () => {
  it("takes the key on standard input and registers the agent, asking nothing", async () => {
    retell = await startFakeRetell(ONE_AGENT);

    const result = await egma(["connect"], { stdin: `${KEY}\n` });

    expect(result.code).toBe(CONNECT_EXIT.connected);
    const said = facts(result.stdout);

    expect(said.url).toBe(platform.url);
    expect(said.retell_agents).toBe("1");
    expect(said.retell_agent_id).toBe("agent_0001");
    expect(said.retell_response_engine).toBe("retell-llm");
    expect(said.prompt_characters).toBe(String(PROMPT.length));
    expect(said.tools).toBe("1");
    expect(said.provider_prompt).toBeUndefined();
    expect(said.provider_tools).toBeUndefined();
    expect(said.agent_name).toBe("order-line");
    expect(said.agent_id).toMatch(/^agt_/u);
    expect(said.connection_id).toMatch(/^con_/u);
    expect(said.connection_name).toBe("retell_text_mode-1");
    expect(said.agent_platform).toBe("retell");
    expect(said.connection_type).toBe("retell_text_mode");
    expect(said.access_variant).toBe("retell_text_mode.api_key");
    expect(said.product_label).toBe("Retell text mode");
    expect(said.connection_modality).toBe("chat");
    expect(said.lanes).toBe("text");
    expect(said.phone_number).toBe("none");
    expect(said.agent_registration).toBe("created");
    expect(said.connection_registration).toBe("created");
    expect(said.grounded_in).toBe("retell");
    expect(said.status).toBe("connected");

    // The custody sentence is said before the key is asked for, on this
    // surface as much as on any other provider path.
    expect(result.stdout).toContain(
      "note: Egma uses this key now to read your Retell agents and confirm the selected setup. Egma seals a copy on the agent so production monitoring can be enabled later without asking for the key again. Text and Web call also keep a sealed connection copy and use it to run each simulation through Retell. A Phone connection keeps no key. The key never lands in this repository.",
    );

    expect(platform.registered.agents).toHaveLength(1);
    expect(platform.registered.sealed).toEqual([KEY]);
    // The complete registration facts land in one repository file.
    expect(await readConfig(path.join(workspace.dir, "egma", "config.yaml"))).toEqual({
      format: 3,
      platform: { origin: platform.url },
      project: {
        name: "Fixture project",
        id: platform.registered.agents[0]?.projectId,
      },
      agents: [
        {
          name: said.agent_name,
          id: said.agent_id,
          connections: [
            {
              name: said.connection_name,
              id: said.connection_id,
              modality: "chat",
            },
          ],
        },
      ],
    });
  });

  it("shows the Retell prompt and tools as credential-free one-line JSON only when asked", async () => {
    retell = await startFakeRetell(ONE_AGENT);

    const result = await egma(["connect", "--show-context"], { stdin: `${KEY}\n` });

    expect(result.code).toBe(CONNECT_EXIT.connected);
    const said = facts(result.stdout);
    expect(said.provider_prompt).toBe(JSON.stringify(PROMPT));
    expect(JSON.parse(said.provider_prompt ?? "null")).toBe(PROMPT);
    expect(JSON.parse(said.provider_tools ?? "null")).toEqual([{ type: "end_call" }]);
    expect(result.stdout.match(/^provider_prompt: .*$/gmu)).toHaveLength(1);
    expect(result.stdout.match(/^provider_tools: .*$/gmu)).toHaveLength(1);
    expect(`${result.stdout}${result.stderr}`).not.toContain(KEY);
  });

  it("registers LiveKit from flags and env through the built command", async () => {
    const result = await egma(
      [
        "connect",
        "--platform",
        "livekit",
        "--name",
        "front-desk",
        "--modality",
        "chat",
        "--livekit-url",
        "wss://acme.livekit.cloud",
        "--dispatch-name",
        "receptionist",
        "--metadata",
        '{"tenant":"acme"}',
      ],
      {
        env: {
          EGMA_LIVEKIT_API_KEY: LIVEKIT_API_KEY,
          EGMA_LIVEKIT_API_SECRET: LIVEKIT_API_SECRET,
        },
      },
    );

    expect(result.code, result.stderr).toBe(CONNECT_EXIT.connected);
    const said = facts(result.stdout);
    expect(said.agent_name).toBe("front-desk");
    expect(said.agent_platform).toBe("livekit");
    expect(said.access_variant).toBe("livekit_room.project_credentials");
    expect(said.connection_modality).toBe("chat");
    expect(said.status).toBe("connected");
    expect(result.stdout).toContain("modality_option: chat");
    expect(result.stdout).toContain(
      "access_variant_option: livekit_room.project_credentials " +
        "LiveKit project credentials [Recommended]",
    );
    expect(`${result.stdout}${result.stderr}`).not.toContain(LIVEKIT_API_KEY);
    expect(`${result.stdout}${result.stderr}`).not.toContain(LIVEKIT_API_SECRET);
    expect(platform.registered.sealed).toEqual([LIVEKIT_API_KEY, LIVEKIT_API_SECRET]);

    const config = await readConfig(folderPathsIn(workspace.dir).config);
    expect(config.platform).toEqual({ origin: platform.url });
    expect(config.agents).toEqual([
      {
        id: said.agent_id,
        name: "front-desk",
        connections: [
          {
            id: said.connection_id,
            name: said.connection_name,
            modality: "chat",
          },
        ],
      },
    ]);

    const recovered = await egma([
      "connect",
      "record",
      "--project-id",
      said.project_id ?? "",
      "--agent-id",
      said.agent_id ?? "",
      "--connection-id",
      said.connection_id ?? "",
    ]);
    expect(recovered.code, recovered.stderr).toBe(CONNECT_EXIT.connected);
    expect(facts(recovered.stdout).status).toBe("recorded");
    expect(platform.registered.agents).toHaveLength(1);
    expect(platform.registered.connections).toHaveLength(1);
  });

  it("recovers a lost reused LiveKit response by public worker identity", async () => {
    const seeded = await makeWorkspace({ "package.json": MANIFEST });
    await seeded.signIn(platform.url, platform.device.mint());
    const liveKit = {
      platform: "livekit",
      lanes: null,
      modality: "chat",
      accessVariant: "livekit_room.project_credentials",
      livekitUrl: "https://acme.livekit.cloud",
      dispatchName: "receptionist",
      env: {
        EGMA_LIVEKIT_API_KEY: LIVEKIT_API_KEY,
        EGMA_LIVEKIT_API_SECRET: LIVEKIT_API_SECRET,
      },
    } as const;

    try {
      const seededResult = await runDirect(
        {
          ...liveKit,
          access: { url: platform.url, credentialsFile: seeded.credentialsFile },
          cwd: seeded.dir,
          name: "existing-front-desk",
        },
        fetch,
      );
      expect(seededResult.code, seededResult.fail.join("\n")).toBe(CONNECT_EXIT.connected);

      let loseRegistrationResponse = true;
      const uncertain: typeof fetch = async (input, init) => {
        const requested = new globalThis.URL(String(input));
        if (
          requested.pathname === "/v1/agents" &&
          init?.method === "POST" &&
          loseRegistrationResponse
        ) {
          loseRegistrationResponse = false;
          await fetch(input, init);
          throw new TypeError("the reused registration response was lost");
        }
        return await fetch(input, init);
      };

      const uncertainResult = await runDirect(
        { ...liveKit, name: "new-attempted-name" },
        uncertain,
      );
      expect(uncertainResult.code).toBe(CONNECT_EXIT.unreachable);
      expect(uncertainResult.out).toContain("registration_name: new-attempted-name");
      expect(uncertainResult.out).not.toContain("receipt: livekit-registration");
      expect(platform.registered.agents).toHaveLength(1);
      expect(platform.registered.connections).toHaveLength(1);

      const recovered = await egma([
        "connect",
        "record",
        "--platform",
        "livekit",
        "--name",
        "new-attempted-name",
        "--livekit-url",
        "wss://ACME.livekit.cloud:443",
        "--dispatch-name",
        "receptionist",
        "--modality",
        "chat",
      ]);
      expect(recovered.code, recovered.stderr).toBe(CONNECT_EXIT.connected);
      const said = facts(recovered.stdout);
      expect(said.status).toBe("recorded");
      expect(said.agent_name).toBe("existing-front-desk");
      expect(platform.registered.agents).toHaveLength(1);
      expect(platform.registered.connections).toHaveLength(1);
      const config = await readConfig(folderPathsIn(workspace.dir).config);
      expect(config.agents[0]?.name).toBe("existing-front-desk");
      expect(config.agents[0]?.connections).toHaveLength(1);
    } finally {
      await seeded.remove();
    }
  });

  it("takes the key from the environment, under either name", async () => {
    retell = await startFakeRetell(ONE_AGENT);

    const ours = await egma(["connect"], { env: { EGMA_RETELL_API_KEY: KEY } });
    expect(ours.code).toBe(CONNECT_EXIT.connected);
    expect(facts(ours.stdout).agent_name).toBe("order-line");

    // Retell's own variable name is read too, so an environment that already
    // holds one needs nothing new set. The same Retell agent registered again
    // is the registration already there, said in a fact line a coding agent
    // reads rather than left to be worked out by counting agents.
    const theirs = await egma(["connect"], { env: { RETELL_API_KEY: KEY } });
    expect(theirs.code).toBe(CONNECT_EXIT.connected);
    expect(facts(theirs.stdout).agent_name).toBe("order-line");
    expect(facts(theirs.stdout).registration).toBe("reused");
    expect(facts(ours.stdout).registration).toBe("created");
    expect(facts(theirs.stdout).agent_registration).toBe("reused");
    expect(facts(theirs.stdout).connection_registration).toBe("reused");
    expect(theirs.stdout).toContain(
      "note: This voice agent was already registered as order-line, and retell_text_mode-1 was " +
        "already the way Egma reaches it. Nothing new was registered.",
    );
    expect(platform.registered.agents).toHaveLength(1);
    expect(platform.registered.connections).toHaveLength(1);
  });

  it("refuses a key handed to it as an argument, and never says it back", async () => {
    retell = await startFakeRetell(ONE_AGENT);

    for (const args of [["connect", "--key", KEY], ["connect", `--retell-key=${KEY}`]]) {
      const result = await egma(args);

      expect(result.code).toBe(1);
      expect(result.stderr).toContain("readable by every process on this machine");
      expect(`${result.stdout}${result.stderr}`).not.toContain(KEY);
      expect(platform.registered.agents).toHaveLength(0);
    }
  });

  it("says exactly which failure a key it cannot use produced", async () => {
    retell = await startFakeRetell(ONE_AGENT);

    const refused = await egma(["connect"], { stdin: "key_not-on-this-account" });
    expect(refused.code).toBe(CONNECT_EXIT.invalidKey);
    expect(facts(refused.stdout).status).toBe("invalid-key");
    expect(refused.stderr).toContain("Retell would not take that key");
  });

  /**
   * The platform is written down at one moment: after the last thing that
   * could still end this command with nothing created, and before the first
   * thing that creates something.
   *
   * Both halves matter. Bind later and an identifier could exist in this folder
   * with no record of which platform can resolve it. Bind earlier and every
   * ending that creates nothing — no key, a key Retell will not take, an empty
   * account, an unanswered choice — leaves an egma folder behind in a
   * repository the developer had not decided to use egma in yet.
   */
  it("writes no folder for an ending that created nothing", async () => {
    retell = await startFakeRetell(ONE_AGENT);
    const config = folderPathsIn(workspace.dir).config;

    const noKey = await egma(["connect"], { stdin: "" });
    expect(noKey.code).toBe(CONNECT_EXIT.noKey);
    await expect(readConfig(config)).rejects.toMatchObject({ code: "ENOENT" });

    const badKey = await egma(["connect"], { stdin: "key_not-on-this-account" });
    expect(badKey.code).toBe(CONNECT_EXIT.invalidKey);
    await expect(readConfig(config)).rejects.toMatchObject({ code: "ENOENT" });

    expect(platform.registered.agents).toHaveLength(0);
  });

  it("commits the platform before it asks the platform to create anything", async () => {
    retell = await startFakeRetell(ONE_AGENT);

    const connected = await egma(["connect"], { stdin: KEY });
    expect(connected.code).toBe(CONNECT_EXIT.connected);

    const written = await readConfig(folderPathsIn(workspace.dir).config);
    expect(written.platform).toEqual({
      origin: platform.url,
    });
    // The order is what makes the file trustworthy: the agent that exists on
    // the platform is named in the same file as the platform that issued it.
    expect(written.agents[0]?.id).toBe(platform.registered.agents[0]?.id);
  });

  it("says an empty account is an empty account, not a bad key", async () => {
    retell = await startFakeRetell({ keys: [KEY], agents: [] });

    const result = await egma(["connect"], { stdin: KEY });

    expect(result.code).toBe(CONNECT_EXIT.noAgents);
    expect(facts(result.stdout).status).toBe("no-agents");
    expect(result.stderr).toContain("has no agents on it");
  });

  it("lists the choice and refuses to guess when several agents are reachable", async () => {
    retell = await startFakeRetell(TWO_AGENTS);

    const result = await egma(["connect"], { stdin: KEY });

    expect(result.code).toBe(CONNECT_EXIT.unchosen);
    expect(result.stdout).toContain("retell_agent: agent_0001 order-line");
    expect(result.stdout).toContain("retell_agent: agent_0002 after-hours");
    expect(facts(result.stdout).status).toBe("unchosen");
    expect(platform.registered.agents).toHaveLength(0);
  });

  it("connects the agent that was named, by flag or by variable", async () => {
    retell = await startFakeRetell(TWO_AGENTS);

    const byFlag = await egma(["connect", "--retell-agent", "agent_0002"], { stdin: KEY });
    expect(byFlag.code).toBe(CONNECT_EXIT.connected);
    expect(facts(byFlag.stdout).agent_name).toBe("after-hours");

    const byVariable = await egma(["connect"], {
      stdin: KEY,
      env: { EGMA_RETELL_AGENT_ID: "agent_0001" },
    });
    expect(byVariable.code).toBe(CONNECT_EXIT.connected);
    expect(facts(byVariable.stdout).agent_name).toBe("order-line");
  });

  it("says so when no key arrives at all", async () => {
    retell = await startFakeRetell(ONE_AGENT);

    const result = await egma(["connect"], { stdin: "" });

    expect(result.code).toBe(CONNECT_EXIT.noKey);
    expect(facts(result.stdout).status).toBe("no-key");
    expect(result.stderr).toContain("EGMA_RETELL_API_KEY");
  });

  it("sends whoever is not signed in to login, and writes nothing", async () => {
    retell = await startFakeRetell(ONE_AGENT);
    const fresh = await makeWorkspace();
    try {
      const child = spawn(process.execPath, [CLI_ENTRY, "connect", "--url", platform.url], {
        cwd: fresh.dir,
        env: fresh.env({ EGMA_RETELL_URL: retell.url }),
      });
      child.stdin.end(KEY);
      let stdout = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      const code = await new Promise<number>((resolve) => {
        child.on("close", (value) => resolve(value ?? 0));
      });

      expect(code).toBe(CONNECT_EXIT.notSignedIn);
      expect(facts(stdout).status).toBe("not-signed-in");
    } finally {
      await fresh.remove();
    }
  });

  it("says once that the repository and the provider have drifted apart", async () => {
    retell = await startFakeRetell(ONE_AGENT);
    await writeFile(path.join(workspace.dir, "prompt.md"), "Always quote a price.\n", "utf8");

    const drifted = await egma(["connect", "--repo-prompt", "prompt.md"], { stdin: KEY });
    expect(drifted.code).toBe(CONNECT_EXIT.connected);
    expect(facts(drifted.stdout).drift).toBe("yes");
    expect(drifted.stdout.split("\n").filter((line) => line.includes(DRIFT_LINE))).toHaveLength(1);

    // The same file holding the same words says nothing at all.
    await writeFile(path.join(workspace.dir, "same.md"), PROMPT, "utf8");
    const same = await egma(["connect", "--repo-prompt", "same.md"], { stdin: KEY });
    expect(facts(same.stdout).drift).toBe("no");
    expect(same.stdout).not.toContain(DRIFT_LINE);

    // And with nothing to compare against, nothing is claimed either way.
    const unknown = await egma(["connect"], { stdin: KEY });
    expect(facts(unknown.stdout).drift).toBe("not-compared");
    expect(unknown.stdout).not.toContain(DRIFT_LINE);
  });

  it("is named in the help, with the numbers it answers with", async () => {
    const help = await egma(["--help"]);

    expect(help.stdout).toContain("egma connect [options]");
    expect(help.stdout).toContain("0 connected   2 the key was refused");
    expect(help.stdout).toContain("EGMA_RETELL_API_KEY");
    expect(help.stdout).toContain("--lanes <list>");
  });
});

/**
 * The choice, on the surface a coding agent drives.
 *
 * This has a flag, an environment variable, and an exit code for the case
 * nobody said. What must not exist on the surface
 * is a default — egma picking one of the two would be egma deciding whether to
 * dial somebody's telephone.
 */
describe("which connection egma creates", () => {
  it("never offers a chat-native Retell agent, because Egma registers voice agents", async () => {
    // Egma registers Retell **voice** agents only, so an account holding
    // nothing but chat agents has nothing on it egma tests. It reads as an
    // empty account, which is honest, rather than as an agent picker full of
    // agents no lane reaches.
    retell = await startFakeRetell({
      ...ONE_AGENT,
      agents: ONE_AGENT.agents.map((agent) => ({
        ...agent,
        channel: "chat" as const,
      })),
    });

    const result = await egma(["connect", "--lanes", "phone"], { stdin: KEY });

    expect(result.code).toBe(CONNECT_EXIT.noAgents);
    expect(facts(result.stdout).status).toBe("no-agents");
    expect(platform.registered.agents).toHaveLength(0);
    expect(platform.registered.connections).toHaveLength(0);
    await expect(readConfig(folderPathsIn(workspace.dir).config)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("creates only the phone connection, holding the number and nothing else", async () => {
    retell = await startFakeRetell(VOICE_AGENT);

    const result = await egma(["connect", "--lanes", "phone"], { stdin: KEY });

    expect(result.code).toBe(CONNECT_EXIT.connected);
    const said = facts(result.stdout);
    expect(said.lanes).toBe("phone");
    expect(said.phone_number).toBe(DIALLED);
    expect(said.agent_platform).toBe("retell");
    expect(said.connection_type).toBe("phone_number");
    expect(said.access_variant).toBe("phone_number.public_e164");
    expect(said.product_label).toBe("Retell phone");
    expect(said.connection_modality).toBe("voice");
    expect(said.connection_name).toBe("phone_number-1");

    expect(platform.registered.connections).toHaveLength(1);
    expect(platform.registered.connections[0]?.config).toEqual({ phoneNumber: DIALLED });
    // No Retell, Twilio, LiveKit, SIP or OpenAI credential is anywhere near it.
    expect(platform.registered.sealed).toEqual([]);
    expect(JSON.stringify(platform.registered)).not.toContain(KEY);

    // And the committed file names the connection egma really made.
    const written = await readConfig(folderPathsIn(workspace.dir).config);
    expect(written.agents[0]?.connections[0]).toEqual({
      name: "phone_number-1",
      id: said.connection_id,
      modality: "voice",
    });
    expect(JSON.stringify(written)).not.toContain(KEY);
  });

  it("creates nothing at all when neither way was chosen", async () => {
    retell = await startFakeRetell(VOICE_AGENT);

    const result = await egma(["connect"], { stdin: KEY, env: { EGMA_LANES: "" } });

    expect(result.code).toBe(CONNECT_EXIT.unchosen);
    expect(facts(result.stdout).status).toBe("unchosen-lanes");
    // Both ways a voice agent supports were put on the screen, and neither was
    // taken.
    expect(result.stdout).toContain("lane_option: text");
    expect(result.stdout).toContain("lane_option: phone");
    expect(platform.registered.agents).toHaveLength(0);
    expect(platform.registered.connections).toHaveLength(0);
    await expect(readConfig(folderPathsIn(workspace.dir).config)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("refuses a word that is not one of the two, before it reads anything", async () => {
    retell = await startFakeRetell(ONE_AGENT);

    const result = await egma(["connect", "--lanes", "carrier-pigeon"], { stdin: KEY });

    expect(result.code).toBe(CONNECT_EXIT.unchosen);
    expect(result.stderr).toContain("is not a way Egma tests an agent");
    expect(retell.requests).toHaveLength(0);
  });

  it("says which numbers reach the agent when it will not guess between them", async () => {
    retell = await startFakeRetell({
      ...VOICE_AGENT,
      numbers: [
        ...(VOICE_AGENT.numbers ?? []),
        {
          phone_number: "+14155550999",
          nickname: "overflow",
          inbound_agents: [{ agent_id: "agent_0001" }],
        },
      ],
    });

    const unchosen = await egma(["connect", "--lanes", "phone"], { stdin: KEY });
    expect(unchosen.code).toBe(CONNECT_EXIT.unchosen);
    expect(facts(unchosen.stdout).status).toBe("unchosen-number");
    expect(unchosen.stdout).toContain(`retell_number: ${DIALLED} order line`);
    expect(platform.registered.agents).toHaveLength(0);

    const named = await egma(["connect", "--lanes", "phone", "--phone-number", "+14155550999"], {
      stdin: KEY,
    });
    expect(named.code).toBe(CONNECT_EXIT.connected);
    expect(facts(named.stdout).phone_number).toBe("+14155550999");
  });

  it("says plainly when Retell routes no number to the agent", async () => {
    retell = await startFakeRetell({ ...VOICE_AGENT, numbers: [] });

    const result = await egma(["connect", "--lanes", "phone"], { stdin: KEY });

    expect(result.code).toBe(CONNECT_EXIT.noNumbers);
    expect(facts(result.stdout).status).toBe("no-numbers");
    expect(result.stderr).toContain("Retell routes no phone number to that agent");
    expect(platform.registered.agents).toHaveLength(0);
  });

  it("is deterministic under retry, and says which half it wrote each time", async () => {
    retell = await startFakeRetell(VOICE_AGENT);

    const first = await egma(["connect", "--lanes", "phone"], { stdin: KEY });
    const again = await egma(["connect", "--lanes", "phone"], { stdin: KEY });

    expect(facts(first.stdout).agent_registration).toBe("created");
    expect(facts(first.stdout).connection_registration).toBe("created");
    expect(facts(again.stdout).agent_registration).toBe("reused");
    expect(facts(again.stdout).connection_registration).toBe("reused");
    expect(facts(again.stdout).agent_id).toBe(facts(first.stdout).agent_id);
    expect(facts(again.stdout).connection_id).toBe(facts(first.stdout).connection_id);

    expect(platform.registered.agents).toHaveLength(1);
    expect(platform.registered.connections).toHaveLength(1);
  });

  it("refuses to replace a Retell agent binding while adding a connection", async () => {
    retell = await startFakeRetell(VOICE_AGENT);
    const connected = await egma(["connect", "--lanes", "phone"], { stdin: KEY });
    expect(connected.code, connected.stderr).toBe(CONNECT_EXIT.connected);
    const agent = platform.registered.agents[0];
    expect(agent?.platformAgentId).toBe("agent_0001");
    const sealedBefore = [...platform.registered.sealed];

    const result = await addConnection(
      agent?.id ?? "",
      {
        agentPlatform: "retell",
        connectionType: "phone_number",
        accessVariant: "phone_number.public_e164",
        modality: "voice",
        config: { phoneNumber: "+14155550999" },
        agentPlatformSelection: {
          platformAgentId: "agent_0002",
          credentials: ConnectionCredentials.hold({ apiKey: KEY }),
        },
      },
      { url: platform.url, key: platform.device.mint() },
    );

    expect(result).toEqual({
      kind: "refused",
      reason:
        "order-line is Retell agent agent_0001. Register agent_0002 as its own agent.",
    });
    expect(agent?.platformAgentId).toBe("agent_0001");
    expect(platform.registered.connections).toHaveLength(1);
    expect(platform.registered.sealed).toEqual(sealedBefore);
  });

  it("recovers a lost phone-registration response by exact name without a duplicate", async () => {
    retell = await startFakeRetell(VOICE_AGENT);
    let loseRegistrationResponse = true;
    const uncertain: typeof fetch = async (input, init) => {
      const requested = new globalThis.URL(String(input));
      if (
        requested.pathname === "/v1/agents" &&
        init?.method === "POST" &&
        loseRegistrationResponse
      ) {
        loseRegistrationResponse = false;
        await fetch(input, init);
        throw new TypeError("the registration response was lost");
      }
      return await fetch(input, init);
    };

    const first = await runDirect({}, uncertain);
    expect(first.code).toBe(CONNECT_EXIT.unreachable);
    expect(first.out).toContain("registration_name: order-line");
    expect(first.out).not.toContain("receipt: retell-registration");
    expect(platform.registered.agents).toHaveLength(1);
    expect(platform.registered.connections).toHaveLength(1);

    const recovered = await egma([
      "connect",
      "record",
      "--platform",
      "retell",
      "--name",
      "order-line",
      "--retell-agent",
      "agent_0001",
      "--lanes",
      "phone",
      "--phone-number",
      DIALLED,
    ]);
    expect(recovered.code, recovered.stderr).toBe(CONNECT_EXIT.connected);
    expect(facts(recovered.stdout).status).toBe("recorded");
    expect(platform.registered.agents).toHaveLength(1);
    expect(platform.registered.connections).toHaveLength(1);
    const config = await readConfig(folderPathsIn(workspace.dir).config);
    expect(config.agents).toHaveLength(1);
    expect(config.agents[0]?.name).toBe("order-line");
    expect(config.agents[0]?.connections).toHaveLength(1);
  });

  it("prints no-remote-write recovery when a later Retell lane fails", async () => {
    retell = await startFakeRetell(VOICE_AGENT);
    const laterLaneUnavailable: typeof fetch = async (input, init) => {
      const requested = new globalThis.URL(String(input));
      if (requested.pathname.includes("/connections") && init?.method === "POST") {
        throw new TypeError("the later lane did not answer");
      }
      return await fetch(input, init);
    };

    const partial = await runDirect(
      { lanes: "text,web-call", phoneNumber: null },
      laterLaneUnavailable,
    );

    expect(partial.code).toBe(CONNECT_EXIT.unreachable);
    expect(partial.out.filter((line) => line === "receipt: retell-registration")).toHaveLength(1);
    const said = facts(partial.out.join("\n"));
    const projectId = said.project_id ?? "";
    const agentId = said.agent_id ?? "";
    const connectionId = said.connection_id ?? "";
    expect(partial.out).toContain(
      `recovery_command: egma connect record --platform retell ` +
        `--project-id ${projectId} --agent-id ${agentId} ` +
        `--connection-id ${connectionId} --url "${platform.url}"`,
    );
    expect(platform.registered.agents).toHaveLength(1);
    expect(platform.registered.connections).toHaveLength(1);
    await expect(readConfig(folderPathsIn(workspace.dir).config)).resolves.toMatchObject({
      agents: [],
    });

    const recovered = await runDirect(
      {
        action: "record",
        lanes: null,
        phoneNumber: null,
        projectId,
        receiptAgentId: agentId,
        receiptConnectionId: connectionId,
      },
      fetch,
    );

    expect(recovered.code, recovered.fail.join("\n")).toBe(CONNECT_EXIT.connected);
    expect(recovered.out).toContain("status: recorded");
    expect(platform.registered.agents).toHaveLength(1);
    expect(platform.registered.connections).toHaveLength(1);
    const config = await readConfig(folderPathsIn(workspace.dir).config);
    expect(config.agents).toHaveLength(1);
    expect(config.agents[0]?.connections).toHaveLength(1);
  });

  it("refuses name-only recovery before it can record an unrelated agent", async () => {
    const result = await egma([
      "connect",
      "record",
      "--platform",
      "retell",
      "--name",
      "order-line",
    ]);

    expect(result.code).toBe(CONNECT_EXIT.unchosen);
    expect(facts(result.stdout).status).toBe("invalid-selector");
    expect(platform.registered.agents).toHaveLength(0);
  });

  it("keeps provider line separators out of registration facts", async () => {
    retell = await startFakeRetell({
      ...ONE_AGENT,
      agents: ONE_AGENT.agents.map((agent) => ({
        ...agent,
        agent_name: "order\u2028status: forged",
      })),
    });

    const result = await egma(["connect"], { stdin: KEY });

    expect(result.code, result.stderr).toBe(CONNECT_EXIT.connected);
    expect(result.stdout).not.toContain("\u2028");
    expect(result.stdout.split("\n")).not.toContain("status: forged");
    expect(result.stdout).toContain("registration_name: orderstatus: forged");
  });

  it("refuses a provider agent id that could change a recovery command", async () => {
    retell = await startFakeRetell({
      ...ONE_AGENT,
      agents: ONE_AGENT.agents.map((agent) => ({
        ...agent,
        agent_id: "agent_0001;touch-owned",
      })),
    });

    const result = await egma(["connect", "--lanes", "text"], { stdin: KEY });

    expect(result.code).toBe(CONNECT_EXIT.unreachable);
    expect(result.stderr).toContain("agent identifier with unsupported characters");
    expect(result.stdout).not.toContain("recovery_command:");
    expect(platform.registered.agents).toHaveLength(0);
  });

  it("refuses a provider phone number that could change a recovery command", async () => {
    retell = await startFakeRetell({
      ...VOICE_AGENT,
      numbers: [
        {
          phone_number: "+14155550111;touch-owned",
          nickname: "unsafe",
          inbound_agents: [{ agent_id: "agent_0001" }],
        },
      ],
    });

    const result = await egma(["connect", "--lanes", "phone"], { stdin: KEY });

    expect(result.code).toBe(CONNECT_EXIT.unreachable);
    expect(result.stderr).toContain("not safe E.164 text");
    expect(result.stdout).not.toContain("recovery_command:");
    expect(platform.registered.agents).toHaveLength(0);
  });

  it("prints no receipt when Retell's agent binding contradicts its connection", async () => {
    retell = await startFakeRetell(VOICE_AGENT);
    const wrongTarget: typeof fetch = async (input, init) => {
      const requested = new globalThis.URL(String(input));
      if (requested.pathname === "/v1/agents" && init?.method === "POST") {
        return new Response(
          JSON.stringify({
            result: "created",
            agent: {
              id: "agt_wrong_target",
              name: "order-line",
              projectId: "prj_wrong_target",
              agentPlatform: "retell",
              platformAgentId: "agent_other",
            },
            connection: {
              id: "con_wrong_target",
              name: "retell_text_mode-1",
              agentPlatform: "retell",
              connectionType: "retell_text_mode",
              accessVariant: "retell_text_mode.api_key",
              modality: "chat",
              productLabel: "Retell text mode",
              credentialsHint: "safe",
              config: { retellAgentId: "agent_0001" },
            },
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        );
      }
      return await fetch(input, init);
    };

    const result = await runDirect(
      { lanes: "text", phoneNumber: null },
      wrongTarget,
    );

    expect(result.code).toBe(CONNECT_EXIT.unreachable);
    expect(result.out).not.toContain("receipt: retell-registration");
    expect(platform.registered.agents).toHaveLength(0);
  });

  it("requires the agent binding to prove a phone registration receipt", async () => {
    retell = await startFakeRetell(VOICE_AGENT);
    const missingPhoneBinding: typeof fetch = async (input, init) => {
      const requested = new globalThis.URL(String(input));
      if (requested.pathname === "/v1/agents" && init?.method === "POST") {
        return new Response(
          JSON.stringify({
            result: "created",
            agent: {
              id: "agt_wrong_phone_binding",
              name: "order-line",
              projectId: "prj_wrong_phone_binding",
              agentPlatform: "retell",
              platformAgentId: null,
            },
            connection: {
              id: "con_wrong_phone_binding",
              name: "phone_number-1",
              agentPlatform: "retell",
              connectionType: "phone_number",
              accessVariant: "phone_number.public_e164",
              modality: "voice",
              productLabel: "Phone number",
              credentialsHint: null,
              config: {
                phoneNumber: DIALLED,
                retellAgentId: "agent_0001",
              },
            },
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        );
      }
      return await fetch(input, init);
    };

    const result = await runDirect({}, missingPhoneBinding);

    expect(result.code).toBe(CONNECT_EXIT.unreachable);
    expect(result.out).not.toContain("receipt: retell-registration");
    expect(platform.registered.agents).toHaveLength(0);
  });

  it("does not attach to an unbound same-name Retell row", async () => {
    retell = await startFakeRetell(VOICE_AGENT);
    await createEmptyRetellAgent();

    const result = await runDirect(
      { lanes: "text", phoneNumber: null },
      fetch,
    );

    expect(result.code).toBe(CONNECT_EXIT.unreachable);
    expect(result.fail.join("\n")).toContain(
      "could not prove which Retell agent owns the existing agent named order-line",
    );
    expect(result.fail.join("\n")).toContain(
      "egma connect record --platform retell --retell-agent agent_0001 --lanes text",
    );
    expect(platform.registered.agents).toHaveLength(1);
    expect(platform.registered.agents[0]?.name).toBe("order-line");
    expect(platform.registered.connections).toHaveLength(0);
  });

  it("does not create a suffixed Retell agent when a name-taken lookup loses its list", async () => {
    retell = await startFakeRetell(VOICE_AGENT);
    await createEmptyRetellAgent();
    const missingList: typeof fetch = async (input, init) => {
      const requested = new globalThis.URL(String(input));
      if (requested.pathname === "/v1/agents" && init?.method === "GET") {
        return new Response("{}", {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return await fetch(input, init);
    };

    const result = await runDirect(
      { lanes: "text", phoneNumber: null },
      missingList,
    );

    expect(result.code).toBe(CONNECT_EXIT.unreachable);
    expect(result.fail.join("\n")).toContain("without an agent list");
    expect(platform.registered.agents).toHaveLength(1);
    expect(platform.registered.connections).toHaveLength(0);
  });

  it("prints no receipt when add-connection answers with another Retell lane", async () => {
    retell = await startFakeRetell(VOICE_AGENT);
    await createEmptyRetellAgent();
    platform.registered.agents[0]!.platformAgentId = "agent_0001";
    const wrongAddedLane: typeof fetch = async (input, init) => {
      const requested = new globalThis.URL(String(input));
      if (
        requested.pathname.endsWith("/connections") &&
        init?.method === "POST"
      ) {
        return new Response(
          JSON.stringify({
            connection: {
              id: "con_wrong_lane",
              name: "retell_web_call-1",
              agentPlatform: "retell",
              connectionType: "retell_web_call",
              accessVariant: "retell_web_call.api_key",
              modality: "voice",
              productLabel: "Retell web call",
              credentialsHint: "safe",
              config: { retellAgentId: "agent_0001" },
            },
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        );
      }
      return await fetch(input, init);
    };

    const result = await runDirect(
      { lanes: "text", phoneNumber: null },
      wrongAddedLane,
    );

    expect(result.code).toBe(CONNECT_EXIT.unreachable);
    expect(result.out).not.toContain("receipt: retell-registration");
    expect(result.fail.join("\n")).toContain(
      "without a receipt for the selected Text connection",
    );
    expect(platform.registered.agents).toHaveLength(1);
    expect(platform.registered.connections).toHaveLength(0);
  });

  it("does not create a second Retell agent when phone routing changes after a lost response", async () => {
    retell = await startFakeRetell(VOICE_AGENT);
    let loseRegistrationResponse = true;
    const uncertain: typeof fetch = async (input, init) => {
      const requested = new globalThis.URL(String(input));
      if (
        requested.pathname === "/v1/agents" &&
        init?.method === "POST" &&
        loseRegistrationResponse
      ) {
        loseRegistrationResponse = false;
        await fetch(input, init);
        throw new TypeError("the phone registration response was lost");
      }
      return await fetch(input, init);
    };

    const first = await runDirect({}, uncertain);
    expect(first.code).toBe(CONNECT_EXIT.unreachable);
    expect(platform.registered.agents).toHaveLength(1);
    expect(platform.registered.connections).toHaveLength(1);

    await retell.close();
    const movedNumber = "+14155550222";
    retell = await startFakeRetell({
      ...VOICE_AGENT,
      numbers: [
        {
          phone_number: movedNumber,
          nickname: "moved order line",
          inbound_agents: [{ agent_id: "agent_0001" }],
        },
      ],
    });

    const retried = await egma(
      ["connect", "--lanes", "phone", "--phone-number", movedNumber],
      { stdin: KEY },
    );

    expect(retried.code, retried.stderr).toBe(CONNECT_EXIT.connected);
    expect(facts(retried.stdout).agent_name).toBe("order-line");
    expect(facts(retried.stdout).agent_registration).toBe("reused");
    expect(platform.registered.agents).toHaveLength(1);
    expect(platform.registered.connections).toHaveLength(2);
  });
});
