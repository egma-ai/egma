/**
 * `egma monitoring` as a coding agent runs it: the built command, in a real
 * subprocess, against a fixture of egma's public HTTP API.
 *
 * Nothing here is a terminal and nothing here answers a question, because the
 * whole promise of the verb is that neither is needed. What is asserted is the
 * two things something driving it can act on — the lines it prints and the
 * number it exits with — and, where a secret is involved, where that secret
 * did and did not land.
 *
 * There is no fake Retell in this file. Egma opens the Retell account on the
 * server side, so the terminal never speaks to Retell on this path.
 */

import { execFile, spawn } from "node:child_process";
import { chmod, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  MONITORING_EXIT,
  runMonitoringCommand,
} from "../src/commands/monitoring.ts";
import {
  createEgmaFolder,
  EMPTY_CONFIG,
  folderPathsIn,
  readConfig,
  serializeConfig,
} from "../src/folder/egma-folder.ts";
import { ENV_FILE_NAME } from "../src/monitoring/env-file.ts";
import { wireLiveKitMonitoring } from "../src/monitoring/livekit-lane.ts";
import { startPlatform, type Platform } from "./support/fixture-platform/index.ts";
import { CLI_ENTRY, MANIFEST, makeWorkspace, type Workspace } from "./support/workspace.ts";

const run = promisify(execFile);

const KEY = "key_3b8e5c1a7f2d9046b3c8";
const PLATFORM_AGENT = "agent_0001";

let platform: Platform;
let workspace: Workspace;

beforeEach(async () => {
  platform = await startPlatform();
  workspace = await makeWorkspace({ "package.json": MANIFEST });
  await workspace.signIn(platform.url, platform.device.mint());
  platform.monitoring.account(KEY, [{ id: PLATFORM_AGENT, name: "order-line" }]);
});

afterEach(async () => {
  await platform.close();
  await workspace.remove();
});

type Result = { stdout: string; stderr: string; code: number };

function egma(
  args: readonly string[],
  options: { readonly stdin?: string } = {},
): Promise<Result> {
  const child = spawn(process.execPath, [CLI_ENTRY, "--url", platform.url, ...args], {
    cwd: workspace.dir,
    env: workspace.env(),
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

/** Every line printed under one name, for the facts a verb repeats. */
function every(stdout: string, name: string): string[] {
  return stdout
    .trimEnd()
    .split("\n")
    .flatMap((line) => (line.startsWith(`${name}: `) ? [line.slice(name.length + 2)] : []));
}

/**
 * An onboarded repository, as connect or the wizard leaves one behind.
 *
 * The whole folder, made the way `egma init` makes it, because a partial one is
 * refused before a platform is even selected — a repository that names a
 * platform and cannot be read whole is a repository egma will not send
 * identifiers from.
 */
async function onboarded(agent: { id: string; name: string }): Promise<void> {
  await createEgmaFolder({
    repository: workspace.dir,
    config: {
      ...EMPTY_CONFIG,
      platform: { origin: platform.url },
      project: { name: "Fixture project", id: platform.projectId },
      agents: [{ name: agent.name, id: agent.id, connections: [] }],
    },
  });
}

/** A repository Git will keep a `.env` out of. */
async function gitRepository(ignoring: readonly string[]): Promise<void> {
  await run("git", ["init", "--quiet"], { cwd: workspace.dir });
  await writeFile(
    path.join(workspace.dir, ".gitignore"),
    `${ignoring.join("\n")}\n`,
    "utf8",
  );
}

/** Keep the folder readable while making its final atomic config write fail. */
async function lockEgmaFolder(): Promise<() => Promise<void>> {
  await createEgmaFolder({
    repository: workspace.dir,
    config: {
      ...EMPTY_CONFIG,
      platform: { origin: platform.url },
    },
  });
  const root = path.join(workspace.dir, "egma");
  const config = path.join(root, "config.yaml");
  await chmod(config, 0o400);
  await chmod(root, 0o500);
  return async () => {
    await chmod(root, 0o700);
    await chmod(config, 0o600);
  };
}

/** An ordinary roster row, with no monitoring setup behind it. */
async function unmonitoredAgent(
  agentPlatform: "retell" | "livekit",
  name: string,
): Promise<{ readonly id: string; readonly name: string }> {
  const created = await fetch(`${platform.url}/v1/agents`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${platform.device.keys[0] ?? ""}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ name, agentPlatform }),
  });
  const body = (await created.json()) as {
    agent: { readonly id: string; readonly name: string };
  };
  return body.agent;
}

type WireOptions = {
  readonly fetchImpl?: typeof fetch;
  readonly key?: string;
  readonly signal?: AbortSignal;
  readonly platformSignal?: AbortSignal;
} & (
  | {
      readonly agent: { readonly id: string; readonly name: string };
      readonly agentName?: never;
    }
  | { readonly agent?: never; readonly agentName: string }
);

/** The common local and platform wiring shared by every LiveKit lane case. */
function wireLiveKit(
  options: WireOptions,
): ReturnType<typeof wireLiveKitMonitoring> {
  const signal = options.signal ?? new AbortController().signal;
  return wireLiveKitMonitoring({
    platform: {
      url: platform.url,
      key: options.key ?? platform.device.keys[0] ?? "",
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      ...(options.platformSignal === undefined
        ? {}
        : { signal: options.platformSignal }),
    },
    cwd: workspace.dir,
    signal,
    ...(options.agent === undefined ? {} : { agentId: options.agent.id }),
    agentName:
      options.agent === undefined ? options.agentName : options.agent.name,
    say: () => undefined,
  });
}

async function expectNoRepositoryConfig(): Promise<void> {
  await expect(
    readFile(folderPathsIn(workspace.dir).config, "utf8"),
  ).rejects.toMatchObject({ code: "ENOENT" });
}

async function expectNoEnvironmentFile(): Promise<void> {
  await expect(
    readFile(path.join(workspace.dir, ENV_FILE_NAME), "utf8"),
  ).rejects.toMatchObject({ code: "ENOENT" });
}

describe("egma monitoring enable, on Retell", () => {
  /**
   * The whole verb in one run: the key arrives on standard input, Egma opens
   * the account with it, and one commit registers the agent and starts
   * watching. Nothing was asked and nothing was typed.
   */
  it("takes the key on standard input and starts watching, asking nothing", async () => {
    const result = await egma(["monitoring", "enable", "--platform", "retell"], {
      stdin: `${KEY}\n`,
    });

    expect(result.code).toBe(MONITORING_EXIT.done);
    const said = facts(result.stdout);
    expect(said.url).toBe(platform.url);
    expect(said.platform).toBe("retell");
    expect(said.platform_agent_id).toBe(PLATFORM_AGENT);
    expect(said.agent_registration).toBe("created");
    expect(said.pull_production_calls).toBe("on");
    expect(said.first_conversation).toBe("none-yet");
    expect(said.status).toBe("watching");

    expect(platform.registered.agents).toHaveLength(1);
    expect(platform.registered.agents[0]).toMatchObject({
      agentPlatform: "retell",
      platformAgentId: PLATFORM_AGENT,
      pullProductionCalls: true,
    });
    expect(platform.monitoring.monitoringKeys).toEqual([KEY]);

    // Nothing the developer or a log could read afterwards holds the key.
    expect(result.stdout).not.toContain(KEY);
    expect(result.stderr).not.toContain(KEY);
  });

  it("keeps the remote success receipt when the local target record fails", async () => {
    const unlock = await lockEgmaFolder();
    let result: Result;
    try {
      result = await egma(["monitoring", "enable", "--platform", "retell"], {
        stdin: `${KEY}\n`,
      });
    } finally {
      await unlock();
    }

    expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(
      MONITORING_EXIT.repositoryRecordFailed,
    );
    const said = facts(result.stdout);
    expect(said.agent_id).toBe(platform.registered.agents[0]?.id);
    expect(said.platform_agent_id).toBe(PLATFORM_AGENT);
    expect(said.pull_production_calls).toBe("on");
    expect(said.status).toBe("repository-record-failed");
    expect(said.reason).toContain("remote monitoring setup");
    expect(said.reason).toContain(`egma monitoring record --agent ${said.agent_id ?? ""}`);
    expect(said.reason).toContain(`--url ${platform.url}`);
    expect(result.stderr).toContain("The remote setup remains active.");
    expect(result.stdout.indexOf("agent_id:")).toBeLessThan(
      result.stdout.indexOf("status: repository-record-failed"),
    );
    expect(platform.registered.agents[0]).toMatchObject({
      platformAgentId: PLATFORM_AGENT,
      pullProductionCalls: true,
    });

    const recovered = await egma(["monitoring", "record", "--agent", said.agent_id ?? ""]);
    expect(recovered.code, `${recovered.stdout}\n${recovered.stderr}`).toBe(
      MONITORING_EXIT.done,
    );
    expect(facts(recovered.stdout).status).toBe("recorded");
    const recoveredConfig = await readConfig(folderPathsIn(workspace.dir).config);
    expect(recoveredConfig.agents[0]?.id).toBe(said.agent_id);
    expect(platform.registered.agents).toHaveLength(1);
  });

  /**
   * A repository that has already been tested holds an agent row, and a second
   * row for one voice agent would split its history in half. The verb watches
   * from the row that is there.
   */
  it("watches from the agent this repository already names", async () => {
    const created = await fetch(`${platform.url}/v1/agents`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${platform.device.keys[0] ?? ""}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: "order-line", agentPlatform: "retell" }),
    });
    const body = (await created.json()) as { agent: { id: string; name: string } };
    await onboarded(body.agent);

    const result = await egma(["monitoring", "enable", "--platform", "retell"], {
      stdin: `${KEY}\n`,
    });

    expect(result.code).toBe(MONITORING_EXIT.done);
    expect(facts(result.stdout).agent_id).toBe(body.agent.id);
    expect(facts(result.stdout).agent_registration).toBe("reused");
    expect(platform.registered.agents).toHaveLength(1);
  });

  /**
   * Every refusal says two things and keeps them apart: what to do about it,
   * and the platform's own sentence for whatever is reading. The exit is
   * nonzero, because the deliverable is that watching is really on.
   */
  it("explains a refusal in plain words, relays the platform's, and exits nonzero", async () => {
    platform.monitoring.refuseStart(PLATFORM_AGENT, "contested");

    const result = await egma(["monitoring", "enable", "--platform", "retell"], {
      stdin: `${KEY}\n`,
    });

    expect(result.code).toBe(MONITORING_EXIT.refused);
    expect(facts(result.stdout).refusal).toBe("contested");
    expect(facts(result.stdout).status).toBe("refused");
    const reasons = every(result.stdout, "reason");
    expect(reasons).toHaveLength(2);
    expect(reasons[0]).toContain("One Egma agent watches one platform agent");
    expect(reasons[1]).toContain("another agent already watches this Retell agent");
    expect(platform.registered.agents).toHaveLength(0);
  });

  it("refuses a key that arrived in no way at all", async () => {
    const result = await egma(["monitoring", "enable", "--platform", "retell"]);

    expect(result.code).toBe(MONITORING_EXIT.noKey);
    expect(facts(result.stdout).status).toBe("no-key");
    expect(result.stderr).toContain("standard input");
    expect(platform.registered.agents).toHaveLength(0);
  });

  it("refuses a key Egma could not open the account with", async () => {
    const result = await egma(["monitoring", "enable", "--platform", "retell"], {
      stdin: "key_not_one_this_account_knows\n",
    });

    expect(result.code).toBe(MONITORING_EXIT.invalidKey);
    expect(facts(result.stdout).status).toBe("invalid-key");
    expect(platform.registered.agents).toHaveLength(0);
  });

  /**
   * More than one agent on the account is a choice only the caller can make,
   * and it is made in the command or not at all.
   */
  it("names the account's agents and refuses when nobody said which", async () => {
    platform.monitoring.account(KEY, [
      { id: PLATFORM_AGENT, name: "order-line" },
      { id: "agent_0002", name: "after-hours" },
    ]);

    const result = await egma(["monitoring", "enable", "--platform", "retell"], {
      stdin: `${KEY}\n`,
    });

    expect(result.code).toBe(MONITORING_EXIT.unchosen);
    expect(every(result.stdout, "monitoring_agent")).toHaveLength(2);
    expect(result.stderr).toContain("--platform-agent");
    expect(platform.registered.agents).toHaveLength(0);

    const chosen = await egma(
      ["monitoring", "enable", "--platform", "retell", "--platform-agent", "agent_0002"],
      { stdin: `${KEY}\n` },
    );
    expect(chosen.code).toBe(MONITORING_EXIT.done);
    expect(facts(chosen.stdout).platform_agent_id).toBe("agent_0002");
  });
});

describe("egma monitoring enable, on LiveKit", () => {
  it("mints through the hosted key contract before the caller records locally", async () => {
    await gitRepository([ENV_FILE_NAME]);
    let keyBody: Record<string, unknown> | null = null;
    const fetchImpl: typeof fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (request.method === "POST" && new URL(request.url).pathname === "/v1/keys") {
        keyBody = (await request.clone().json()) as Record<string, unknown>;
      }
      return fetch(input, init);
    };

    const outcome = await wireLiveKit({ fetchImpl, agentName: "hosted-contract" });

    expect(outcome).toMatchObject({ kind: "wired" });
    expect(keyBody).toMatchObject({
      projectId: platform.projectId,
      monitoringAgentId: platform.registered.agents[0]?.id,
      name: expect.stringMatching(/\[[a-f0-9]{16}\]$/u),
    });
    expect(keyBody).not.toHaveProperty("activeNamePrefix");
    await expectNoRepositoryConfig();
  });

  it("reports an artificial mint transport failure without claiming cleanup", async () => {
    const agent = await unmonitoredAgent("livekit", "interruptible-livekit-agent");
    const controller = new AbortController();
    const fetchImpl: typeof fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (request.method === "POST" && new URL(request.url).pathname === "/v1/keys") {
        controller.abort("test interrupt");
        throw new DOMException("This operation was aborted", "AbortError");
      }
      return fetch(input, init);
    };

    const outcome = await wireLiveKit({
      agent,
      fetchImpl,
      signal: controller.signal,
      platformSignal: controller.signal,
    });

    expect(outcome).toMatchObject({
      kind: "failed",
      reason: expect.stringContaining("did not answer"),
    });
    expect(platform.keys.minted).toHaveLength(0);
  });

  it.each([
    {
      caseName: "its response is lost",
      answer: async (response: Response): Promise<Response> => {
        await response.arrayBuffer();
        throw new TypeError("fixture dropped the committed response");
      },
    },
    {
      caseName: "a proxy answers 502",
      answer: async (response: Response): Promise<Response> => {
        await response.arrayBuffer();
        return new Response(
          JSON.stringify({
            error: "bad_gateway",
            message: "the proxy lost the committed response",
          }),
          { status: 502, headers: { "content-type": "application/json" } },
        );
      },
    },
    {
      caseName: "its 201 receipt is malformed",
      answer: async (response: Response): Promise<Response> => {
        await response.arrayBuffer();
        return new Response(JSON.stringify({}), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      },
    },
  ])("warns when registration commits but $caseName", async ({ answer }) => {
    const fetchImpl: typeof fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const response = await fetch(input, init);
      if (
        request.method === "POST" &&
        new URL(request.url).pathname === "/v1/agents"
      ) {
        return answer(response);
      }
      return response;
    };

    const agentName = "uncertain-registration";
    const outcome = await wireLiveKit({ fetchImpl, agentName });

    expect(outcome).toMatchObject({
      kind: "failed",
      reason: expect.stringContaining(`may have created an agent named "${agentName}"`),
    });
    expect(platform.registered.agents).toHaveLength(1);
    expect(platform.keys.minted).toHaveLength(0);
    await expectNoRepositoryConfig();
  });

  it("keeps the fresh agent id when the parent command stops after registration", async () => {
    const controller = new AbortController();
    const fetchImpl: typeof fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const response = await fetch(input, init);
      if (
        request.method !== "POST" ||
        new URL(request.url).pathname !== "/v1/agents"
      ) {
        return response;
      }
      const body = await response.arrayBuffer();
      controller.abort("test interrupt after registration");
      if (request.signal.aborted) {
        throw new DOMException("This operation was aborted", "AbortError");
      }
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    };

    const outcome = await wireLiveKit({
      fetchImpl,
      agentName: "stopped-after-registration",
      signal: controller.signal,
      platformSignal: controller.signal,
    });

    expect(outcome).toEqual({
      kind: "interrupted",
      retryTarget: { agentId: platform.registered.agents[0]?.id },
    });
    expect(platform.registered.agents).toHaveLength(1);
    expect(platform.keys.minted).toHaveLength(0);
    await expectNoRepositoryConfig();
  });

  it("revokes a response-confirmed key whose one-time secret is missing", async () => {
    const agent = await unmonitoredAgent("livekit", "missing-secret");
    const fetchImpl: typeof fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const response = await fetch(input, init);
      if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/keys") {
        return response;
      }
      const body = (await response.json()) as Record<string, unknown>;
      delete body["secret"];
      return new Response(JSON.stringify(body), {
        status: response.status,
        headers: response.headers,
      });
    };

    const outcome = await wireLiveKit({ agent, fetchImpl });

    const minted = platform.keys.minted[0]!;
    expect(outcome).toMatchObject({
      kind: "failed",
      reason: expect.stringContaining(`minted key ${minted.id}`),
    });
    expect(minted.revokedAt).not.toBeNull();
    expect(JSON.stringify(outcome)).not.toContain(minted.secret);
    await expectNoEnvironmentFile();
  });

  it("warns when key mint commits but its response is lost", async () => {
    const agent = await unmonitoredAgent("livekit", "uncertain-mint");
    const fetchImpl: typeof fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const response = await fetch(input, init);
      if (request.method === "POST" && new URL(request.url).pathname === "/v1/keys") {
        await response.arrayBuffer();
        throw new TypeError("fixture dropped the committed response");
      }
      return response;
    };

    const outcome = await wireLiveKit({ agent, fetchImpl });

    const minted = platform.keys.minted[0]!;
    expect(outcome).toMatchObject({
      kind: "failed",
      reason: expect.stringContaining("may still have completed"),
    });
    if (outcome.kind !== "failed") throw new Error("expected uncertain mint");
    expect(outcome.reason).toContain(minted.name ?? "");
    expect(outcome.reason).toContain(agent.id);
    expect(minted.revokedAt).not.toBeNull();
    await expectNoEnvironmentFile();
  });

  it("does not revoke a concurrent setup when its own mint never committed", async () => {
    await gitRepository([ENV_FILE_NAME]);
    const agent = await unmonitoredAgent("livekit", "concurrent-uncertain-mint");
    let competing: Awaited<ReturnType<typeof wireLiveKitMonitoring>> | null = null;
    let intercepted = false;
    const fetchImpl: typeof fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (
        !intercepted &&
        request.method === "POST" &&
        new URL(request.url).pathname === "/v1/keys"
      ) {
        intercepted = true;
        competing = await wireLiveKit({ agent });
        throw new TypeError("fixture dropped the request before commit");
      }
      return fetch(input, init);
    };

    const uncertain = await wireLiveKit({ agent, fetchImpl });

    expect(competing).toMatchObject({ kind: "wired" });
    expect(uncertain).toMatchObject({
      kind: "failed",
      reason: expect.stringContaining("found no active key from this attempt"),
    });
    expect(platform.keys.minted).toHaveLength(1);
    expect(platform.keys.minted[0]?.revokedAt).toBeNull();
    const environment = await readFile(
      path.join(workspace.dir, ENV_FILE_NAME),
      "utf8",
    );
    expect(environment).toContain(
      `EGMA_API_KEY=${platform.keys.minted[0]?.secret ?? ""}`,
    );
  });

  it("revokes a bound key when the parent command is stopped after mint", async () => {
    await platform.close();
    platform = await startPlatform();
    const terminalKey = platform.device.mint();
    const agent = await unmonitoredAgent("livekit", "stopped-after-mint");
    const controller = new AbortController();
    const fetchImpl: typeof fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const response = await fetch(input, init);
      if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/keys") {
        return response;
      }
      const body = await response.arrayBuffer();
      controller.abort("test interrupt after mint");
      if (request.signal.aborted) {
        throw new DOMException("This operation was aborted", "AbortError");
      }
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    };

    const outcome = await wireLiveKit({
      agent,
      key: terminalKey,
      fetchImpl,
      signal: controller.signal,
      platformSignal: controller.signal,
    });

    expect(outcome).toEqual({ kind: "interrupted" });
    expect(platform.keys.minted).toHaveLength(1);
    expect(platform.keys.minted[0]?.revokedAt).not.toBeNull();
    await expectNoEnvironmentFile();
  });

  it("prints the non-secret key id when unusable-key cleanup cannot finish", async () => {
    const terminalKey = platform.device.mint();
    const agent = await unmonitoredAgent("livekit", "cleanup-refused");
    const fetchImpl: typeof fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const response = await fetch(input, init);
      if (
        request.method !== "POST" ||
        new URL(request.url).pathname !== "/v1/keys"
      ) {
        return response;
      }
      const body = (await response.json()) as Record<string, unknown>;
      delete body["secret"];
      platform.device.reject(terminalKey);
      return new Response(JSON.stringify(body), {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    };

    const outcome = await wireLiveKit({ agent, key: terminalKey, fetchImpl });

    const minted = platform.keys.minted[0]!;
    expect(outcome).toMatchObject({
      kind: "failed",
      reason: expect.stringContaining(
        `could not confirm that key ${minted.id} was revoked`,
      ),
    });
    expect(outcome).toMatchObject({
      reason: expect.not.stringContaining(minted.secret),
    });
    expect(minted.revokedAt).toBeNull();
    expect(platform.device.keys).toContain(minted.secret);
    await expectNoEnvironmentFile();
  });

  it.each([
    {
      answer: {
        status: 404,
        body: { error: "not_found", message: "nothing serves this route" },
      },
      caseName: "a generic 404",
    },
    {
      answer: {
        status: 200,
        body: { id: "key_wrong", revokedAt: null },
      },
      caseName: "a malformed 200",
    },
  ])("does not call $caseName confirmed key cleanup", async ({ answer }) => {
    const terminalKey = platform.device.mint();
    const agent = await unmonitoredAgent("livekit", "cleanup-not-confirmed");
    const fetchImpl: typeof fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (
        request.method === "POST" &&
        new URL(request.url).pathname === "/v1/keys"
      ) {
        const response = await fetch(input, init);
        const body = (await response.json()) as Record<string, unknown>;
        delete body["secret"];
        return new Response(JSON.stringify(body), {
          status: response.status,
          headers: response.headers,
        });
      }
      if (
        request.method === "POST" &&
        new URL(request.url).pathname.endsWith("/revoke")
      ) {
        return new Response(JSON.stringify(answer.body), {
          status: answer.status,
          headers: { "content-type": "application/json" },
        });
      }
      return fetch(input, init);
    };

    const outcome = await wireLiveKit({ agent, key: terminalKey, fetchImpl });

    const minted = platform.keys.minted[0]!;
    expect(outcome).toMatchObject({
      kind: "failed",
      reason: expect.stringContaining(
        `could not confirm that key ${minted.id} was revoked`,
      ),
    });
    expect(minted.revokedAt).toBeNull();
    expect(platform.device.keys).toContain(minted.secret);
  });

  it("mints a project key, writes the two lines, and prints them", async () => {
    await gitRepository([ENV_FILE_NAME]);

    const result = await egma([
      "monitoring",
      "enable",
      "--platform",
      "livekit",
      "--name",
      "front-desk",
    ]);

    expect(result.code).toBe(MONITORING_EXIT.done);
    const said = facts(result.stdout);
    expect(said.platform).toBe("livekit");
    expect(said.agent_name).toBe("front-desk");
    expect(said.agent_registration).toBe("created");
    expect(said.env_file).toBe(ENV_FILE_NAME);
    expect(said.status).toBe("wired");

    expect(platform.registered.agents).toHaveLength(1);
    expect(platform.registered.agents[0]).toMatchObject({
      name: "front-desk",
      agentPlatform: "livekit",
      pullProductionCalls: false,
    });
    expect(platform.registered.connections).toHaveLength(0);

    const minted = platform.keys.minted[0]!;
    expect(minted.scope).toBe("project");
    const env = await readFile(path.join(workspace.dir, ENV_FILE_NAME), "utf8");
    expect(env.trimEnd().split("\n")).toEqual([
      `EGMA_URL=${platform.url}`,
      `EGMA_API_KEY=${minted.secret}`,
    ]);
    // The lines are the deliverable, so they are printed for the deployment.
    expect(every(result.stdout, "env")).toEqual([
      `export EGMA_URL=${platform.url}`,
      `export EGMA_API_KEY=${minted.secret}`,
    ]);
  });

  it("keeps the LiveKit key receipt when the final local record fails", async () => {
    const unlock = await lockEgmaFolder();
    let result: Result;
    try {
      result = await egma(["monitoring", "enable", "--platform", "livekit"]);
    } finally {
      await unlock();
    }

    expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(
      MONITORING_EXIT.repositoryRecordFailed,
    );
    const said = facts(result.stdout);
    expect(said.status).toBe("repository-record-failed");
    expect(said.monitoring_key_id).toBe(platform.keys.minted[0]?.id);
    expect(result.stderr).toContain("egma monitoring record --agent");
    expect(result.stderr).toContain(
      `--monitoring-key-id ${said.monitoring_key_id ?? ""}`,
    );
    expect(every(result.stdout, "env")).toHaveLength(2);
    expect(platform.registered.agents).toHaveLength(1);
    expect(platform.keys.minted).toHaveLength(1);

    const agent = platform.registered.agents[0];
    if (agent === undefined) throw new Error("expected the registered agent");
    agent.name = "renamed-after-receipt";

    const wrong = await egma([
      "monitoring",
      "record",
      "--agent",
      agent.id,
      "--monitoring-key-id",
      "key_wrong",
    ]);
    expect(wrong.code).toBe(MONITORING_EXIT.refused);
    expect(facts(wrong.stdout).status).toBe("no-monitoring-setup");

    const recovered = await egma([
      "monitoring",
      "record",
      "--agent",
      agent.id,
      "--monitoring-key-id",
      said.monitoring_key_id ?? "",
    ]);
    expect(recovered.code, `${recovered.stdout}\n${recovered.stderr}`).toBe(
      MONITORING_EXIT.done,
    );
    expect(facts(recovered.stdout).status).toBe("recorded");
    expect(facts(recovered.stdout).agent_name).toBe("renamed-after-receipt");
    expect(platform.registered.agents).toHaveLength(1);
    expect(platform.keys.minted).toHaveLength(1);
  });

  it("does not rotate an already configured worker during ordinary enable", async () => {
    await gitRepository([ENV_FILE_NAME]);
    await writeFile(
      path.join(workspace.dir, ENV_FILE_NAME),
      "OTHER=kept\n",
      "utf8",
    );

    const first = await egma(["monitoring", "enable", "--platform", "livekit"]);
    expect(first.code).toBe(MONITORING_EXIT.done);
    const agent = platform.registered.agents[0]!;
    await onboarded({ id: agent.id, name: agent.name });

    const second = await egma(["monitoring", "enable", "--platform", "livekit"]);
    expect(second.code).toBe(MONITORING_EXIT.refused);
    expect(facts(second.stdout).agent_registration).toBe("reused");
    expect(facts(second.stdout).status).toBe("already-configured");
    expect(second.stderr).toContain(
      "No key was rotated and no environment file was changed",
    );

    // One row, one key, one file, and the developer's own line untouched.
    expect(platform.registered.agents).toHaveLength(1);
    const env = (await readFile(path.join(workspace.dir, ENV_FILE_NAME), "utf8"))
      .trimEnd()
      .split("\n");
    expect(env).toHaveLength(3);
    expect(env[0]).toBe("OTHER=kept");
    expect(env.filter((line) => line.startsWith("EGMA_URL="))).toHaveLength(1);
    expect(env[2]).toBe(`EGMA_API_KEY=${platform.keys.minted[0]?.secret ?? ""}`);
    expect(platform.keys.minted).toHaveLength(1);
    expect(platform.keys.minted[0]?.revokedAt).toBeNull();
  });

  it("refuses an archived LiveKit agent even while its worker key is active", async () => {
    await gitRepository([ENV_FILE_NAME]);
    const first = await egma(["monitoring", "enable", "--platform", "livekit"]);
    expect(first.code).toBe(MONITORING_EXIT.done);

    const agent = platform.registered.agents[0];
    if (agent === undefined) throw new Error("expected the registered agent");
    agent.archivedAt = new Date("2026-08-27T12:00:00.000Z").toISOString();

    const second = await egma(["monitoring", "enable", "--platform", "livekit"]);

    expect(second.code).toBe(MONITORING_EXIT.refused);
    expect(facts(second.stdout).status).toBe("no-monitoring-setup");
    expect(facts(second.stdout).repository_record).toBeUndefined();
    expect(second.stderr).toContain("is archived");
    expect(platform.keys.minted).toHaveLength(1);
  });

  it("honors a project-wide active key even when this member cannot list it", async () => {
    const agent = await unmonitoredAgent("livekit", "another-members-worker-key");
    await onboarded({ id: agent.id, name: agent.name });
    const terminalKey = platform.device.keys[0] ?? "";
    const activeNamePrefix = `Egma monitoring ${agent.id} — `;
    const seeded = await fetch(`${platform.url}/v1/keys`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${terminalKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: `${activeNamePrefix}${agent.name} [another-member]`,
        projectId: platform.projectId,
      }),
    });
    expect(seeded.status).toBe(201);

    const fetchImpl: typeof fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (request.method === "GET" && new URL(request.url).pathname === "/v1/keys") {
        return new Response(JSON.stringify({ keys: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return fetch(input, init);
    };
    const outcome = await wireLiveKit({ agent, key: terminalKey, fetchImpl });

    expect(outcome).toMatchObject({
      kind: "already-configured",
      keyId: null,
      reason: expect.stringContaining("another project member"),
    });
    expect(platform.keys.minted).toHaveLength(1);
    expect(platform.keys.minted[0]?.revokedAt).toBeNull();
    await expectNoEnvironmentFile();
  });

  it("records another member's active worker and retries the local write", async () => {
    const agent = await unmonitoredAgent("livekit", "another-members-worker");
    const seeded = await wireLiveKit({ agent });
    expect(seeded).toMatchObject({ kind: "wired" });

    const fetchImpl: typeof fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (request.method === "GET" && new URL(request.url).pathname === "/v1/keys") {
        return new Response(JSON.stringify({ keys: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return fetch(input, init);
    };
    const runHiddenMember = async (): Promise<Result> => {
      const stdout: string[] = [];
      const stderr: string[] = [];
      const code = await runMonitoringCommand({
        access: {
          url: platform.url,
          credentialsFile: workspace.credentialsFile,
        },
        cwd: workspace.dir,
        action: "enable",
        agent: null,
        platform: "livekit",
        platformAgentId: null,
        name: agent.name,
        signal: new AbortController().signal,
        out: (line) => stdout.push(line),
        fail: (line) => stderr.push(line),
        fetchImpl,
      });
      return {
        code,
        stdout: `${stdout.join("\n")}\n`,
        stderr: `${stderr.join("\n")}\n`,
      };
    };

    const unlock = await lockEgmaFolder();
    let failed: Result;
    try {
      failed = await runHiddenMember();
    } finally {
      await unlock();
    }
    expect(failed.code).toBe(MONITORING_EXIT.repositoryRecordFailed);
    expect(failed.stderr).toContain(
      "run the same egma monitoring enable command again",
    );
    expect(failed.stderr).not.toContain("egma monitoring record --agent");

    const recovered = await runHiddenMember();
    expect(recovered.code).toBe(MONITORING_EXIT.refused);
    expect(facts(recovered.stdout).repository_record).toBe("recorded");
    expect(facts(recovered.stdout).status).toBe("already-configured");
    expect((await readConfig(folderPathsIn(workspace.dir).config)).agents).toEqual([
      { id: agent.id, name: agent.name, connections: [] },
    ]);
    expect(platform.keys.minted).toHaveLength(1);
  });

  it("refuses an unsafe duplicate-key state instead of choosing one", async () => {
    const agent = await unmonitoredAgent("livekit", "duplicate-worker-keys");
    await onboarded({ id: agent.id, name: agent.name });
    const terminalKey = platform.device.keys[0] ?? "";
    const prefix = `Egma monitoring ${agent.id} — `;
    for (const attempt of ["first", "second"]) {
      const response = await fetch(`${platform.url}/v1/keys`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${terminalKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          name: `${prefix}${agent.name} [${attempt}]`,
          projectId: platform.projectId,
        }),
      });
      expect(response.status).toBe(201);
    }

    const result = await egma(["monitoring", "enable", "--platform", "livekit"]);

    expect(result.code).toBe(MONITORING_EXIT.unreachable);
    expect(facts(result.stdout).status).toBe("failed");
    expect(facts(result.stdout).reason).toContain("2 active project keys");
    expect(platform.keys.minted).toHaveLength(2);
    expect(platform.keys.minted.every((key) => key.revokedAt === null)).toBe(true);
  });

  /**
   * A `.env` a shell sources is written `export NAME=…`, and a rotation that
   * quietly dropped the word would leave a file whose values stop reaching the
   * process. The line keeps the shape it already had — and a file Egma creates
   * lands readable only by its owner, because it holds a live credential.
   */
  it("keeps the form a line was already written in, and creates the file private", async () => {
    await gitRepository([ENV_FILE_NAME]);
    await writeFile(
      path.join(workspace.dir, ENV_FILE_NAME),
      "export EGMA_URL=https://stale.example\n",
      "utf8",
    );

    const first = await egma(["monitoring", "enable", "--platform", "livekit"]);
    expect(first.code).toBe(MONITORING_EXIT.done);

    const env = (await readFile(path.join(workspace.dir, ENV_FILE_NAME), "utf8"))
      .trimEnd()
      .split("\n");
    expect(env[0]).toBe(`export EGMA_URL=${platform.url}`);
    expect(env[1]).toBe(`EGMA_API_KEY=${platform.keys.minted[0]?.secret ?? ""}`);
    const mode = (await stat(path.join(workspace.dir, ENV_FILE_NAME))).mode & 0o777;
    expect(mode & 0o077).toBe(0);
  });

  it("refuses to write the file Git does not ignore, and prints the lines", async () => {
    await gitRepository(["node_modules"]);

    const result = await egma(["monitoring", "enable", "--platform", "livekit"]);

    expect(result.code).toBe(MONITORING_EXIT.done);
    expect(facts(result.stdout).env_file).toBe("none");
    expect(facts(result.stdout).reason).toContain("Git does not ignore");
    expect(every(result.stdout, "env")).toHaveLength(2);
    await expectNoEnvironmentFile();
  });
});

describe("which platform runs this agent", () => {
  /**
   * Inference is from the repository's own binding. Every registration writes
   * one now, so the verb's "Egma cannot tell" refusal stands as armor against
   * a platform speaking words this build does not know, not as a path any
   * registered agent can reach.
   */
  it("is read from the agent's own binding when it has one", async () => {
    await egma(["monitoring", "enable", "--platform", "livekit", "--name", "front-desk"]);
    const agent = platform.registered.agents[0]!;
    await onboarded({ id: agent.id, name: agent.name });

    const result = await egma(["monitoring", "enable"]);

    expect(result.code).toBe(MONITORING_EXIT.refused);
    expect(facts(result.stdout).platform).toBe("livekit");
    expect(facts(result.stdout).status).toBe("already-configured");
  });
  it("names the two it knows when the command said something else", async () => {
    const result = await egma(["monitoring", "enable", "--platform", "vapi"]);

    expect(result.code).toBe(MONITORING_EXIT.unchosen);
    expect(result.stderr).toContain("--platform retell");
  });
});

describe("egma monitoring status and disable", () => {
  it("requires the stable receipt id before record-only recovery", async () => {
    const result = await egma(["monitoring", "record"]);

    expect(result.code).toBe(MONITORING_EXIT.unchosen);
    expect(facts(result.stdout).status).toBe("unchosen-agent");
    expect(result.stderr).toContain("stable Egma agent id");
    expect(platform.registered.agents).toHaveLength(0);
    expect(platform.keys.minted).toHaveLength(0);
  });

  it.each([
    {
      agentPlatform: "retell" as const,
      name: "ordinary-retell-agent",
      reason: "active Retell monitoring setup",
    },
    {
      agentPlatform: "livekit" as const,
      name: "ordinary-livekit-agent",
      reason: "--monitoring-key-id",
    },
  ])("refuses to record an unmonitored $agentPlatform agent", async ({
    agentPlatform,
    name,
    reason,
  }) => {
    const agent = await unmonitoredAgent(agentPlatform, name);

    const result = await egma(["monitoring", "record", "--agent", agent.id]);

    expect(result.code).toBe(MONITORING_EXIT.refused);
    expect(facts(result.stdout).status).toBe("no-monitoring-setup");
    expect(result.stderr).toContain(reason);
    await expectNoRepositoryConfig();
    expect(platform.registered.agents).toHaveLength(1);
    expect(platform.keys.minted).toHaveLength(0);
  });

  it("refuses to recover an archived LiveKit target", async () => {
    await gitRepository([ENV_FILE_NAME]);
    const setup = await egma([
      "monitoring",
      "enable",
      "--platform",
      "livekit",
      "--name",
      "archived-livekit-agent",
    ]);
    expect(setup.code, `${setup.stdout}\n${setup.stderr}`).toBe(
      MONITORING_EXIT.done,
    );

    const agent = platform.registered.agents[0];
    if (agent === undefined) throw new Error("expected the registered agent");
    agent.archivedAt = new Date("2026-08-27T12:00:00.000Z").toISOString();
    await writeFile(
      folderPathsIn(workspace.dir).config,
      serializeConfig({
        ...EMPTY_CONFIG,
        platform: { origin: platform.url },
        project: { name: "Fixture project", id: platform.projectId },
      }),
      "utf8",
    );

    const result = await egma([
      "monitoring",
      "record",
      "--agent",
      agent.id,
      "--monitoring-key-id",
      facts(setup.stdout).monitoring_key_id ?? "",
    ]);

    expect(result.code).toBe(MONITORING_EXIT.refused);
    expect(facts(result.stdout).status).toBe("no-monitoring-setup");
    expect(result.stderr).toContain("is archived");
    expect((await readConfig(folderPathsIn(workspace.dir).config)).agents).toEqual(
      [],
    );
    expect(platform.keys.minted).toHaveLength(1);
  });

  /**
   * Status is a read and says everything a person would open the browser for:
   * the switch, what it is bound to, which key it spends, and whether anything
   * has ever arrived.
   */
  it("reports the switch, the binding, the key hint and the last arrival", async () => {
    await egma(["monitoring", "enable", "--platform", "retell"], { stdin: `${KEY}\n` });
    const agent = platform.registered.agents[0]!;
    await onboarded({ id: agent.id, name: agent.name });
    platform.registered.received(agent.id, new Date("2026-08-24T09:00:00.000Z"));

    const result = await egma(["monitoring", "status"]);

    expect(result.code).toBe(MONITORING_EXIT.done);
    const said = facts(result.stdout);
    expect(said.agent_id).toBe(agent.id);
    expect(said.pull_production_calls).toBe("on");
    expect(said.agent_platform).toBe("retell");
    expect(said.platform_agent_id).toBe(PLATFORM_AGENT);
    expect(said.monitoring_key).toBe(KEY.slice(-4));
    expect(said.last_received_at).toBe("2026-08-24T09:00:00.000Z");
    expect(said.status).toBe("read");
    // A hint is a hint: enough to tell one key from another, never the key.
    expect(result.stdout).not.toContain(KEY);
  });

  /** Turning it off keeps every stored thing, which is what the lines say. */
  it("turns the switch off and keeps the binding and the key", async () => {
    await egma(["monitoring", "enable", "--platform", "retell"], { stdin: `${KEY}\n` });
    const agent = platform.registered.agents[0]!;
    await onboarded({ id: agent.id, name: agent.name });

    const result = await egma(["monitoring", "disable"]);

    expect(result.code).toBe(MONITORING_EXIT.done);
    const said = facts(result.stdout);
    expect(said.pull_production_calls).toBe("off");
    expect(said.agent_platform).toBe("retell");
    expect(said.platform_agent_id).toBe(PLATFORM_AGENT);
    expect(said.monitoring_key).toBe(KEY.slice(-4));
    expect(said.status).toBe("disabled");

    // Stored means stored: the row keeps its binding and its sealed key.
    expect(platform.registered.agents[0]).toMatchObject({
      pullProductionCalls: false,
      agentPlatform: "retell",
      monitoringApiKeyHint: KEY.slice(-4),
    });

    // And reading it back says the same thing.
    expect(facts((await egma(["monitoring", "status"])).stdout).pull_production_calls).toBe(
      "off",
    );
  });

  it("says there is nothing here when the repository names no agent", async () => {
    const result = await egma(["monitoring", "status"]);

    expect(result.code).toBe(MONITORING_EXIT.nothingHere);
    expect(facts(result.stdout).status).toBe("no-agent");
    expect(result.stderr).toContain("egma/config.yaml");
  });

  it("refuses a subcommand it does not have", async () => {
    const result = await egma(["monitoring", "pause"]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("enable, disable, status, record");
  });
});

describe("the key, while the command is running", () => {
  /**
   * A key in an argument is readable by every process on the machine and is
   * kept in shell history besides, so the verb takes it on standard input and
   * refuses an argument that names one outright.
   */
  it("never appears in the process table", async () => {
    const child = spawn(
      process.execPath,
      [CLI_ENTRY, "--url", platform.url, "monitoring", "enable", "--platform", "retell"],
      { cwd: workspace.dir, env: workspace.env() },
    );
    child.stdin.end(`${KEY}\n`);

    let seen = "";
    let running = true;
    const sweep = (async () => {
      while (running) {
        const listed = await run("ps", ["-eo", "args="]).catch(() => ({ stdout: "" }));
        seen += listed.stdout;
      }
    })();

    const code = await new Promise<number>((resolve) => {
      child.on("close", (value) => resolve(value ?? 0));
    });
    running = false;
    await sweep;

    expect(code).toBe(MONITORING_EXIT.done);
    expect(seen).toContain("monitoring");
    expect(seen).not.toContain(KEY);
  });

  it("refuses an argument that would have carried it", async () => {
    const result = await egma(["monitoring", "enable", "--api-key", KEY]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("standard input");
    expect(result.stderr).not.toContain(KEY);
    expect(platform.registered.agents).toHaveLength(0);
  });
});
