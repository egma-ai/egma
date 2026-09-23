/**
 * `egma agent dev` with a fake tunnel launcher and the fixture platform: the
 * first start creates this machine's two connections, a later start updates
 * them, a second machine gets its own, the guard behind the tunnel takes only
 * the secret written into them, and the session survives a tunnel that ends.
 */

import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runAgentDevCommand, machineNameOf, type AgentDevCommandOptions } from "../src/commands/agent-dev.ts";
import { DEV_SECRET_HEADER } from "../src/dev/guard.ts";
import { TunnelStartFailure, type RunningTunnel, type TunnelExit, type TunnelLauncher } from "../src/dev/tunnel.ts";
import { createEgmaFolder, EMPTY_CONFIG, folderPathsIn, readConfig } from "../src/folder/egma-folder.ts";
import { startPlatform, type Platform } from "./support/fixture-platform/index.ts";
import { makeWorkspace, type Workspace } from "./support/workspace.ts";

const EGMA_KEY = "egma_sk_agent_dev";
const HOSTNAME = "Test-Laptop.local";
const MACHINE = "test-laptop-local";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

type FakeTunnel = RunningTunnel & {
  readonly target: string;
  stopped: boolean;
  isConnected: boolean | undefined;
  /** End the process as a crash would. */
  crash(): void;
};

function fakeTunnels(options: { readonly failFirst?: number } = {}) {
  const opened: FakeTunnel[] = [];
  let failures = options.failFirst ?? 0;
  const launch: TunnelLauncher = async ({ target, signal }) => {
    if (signal.aborted) throw new TunnelStartFailure("stopped", []);
    if (failures > 0) {
      failures -= 1;
      throw new TunnelStartFailure("cloudflared stopped before the tunnel was ready (exit code 1).", [
        "ERR failed to request quick Tunnel: Post https://api.trycloudflare.com/tunnel: EOF",
      ]);
    }
    let end: (exit: TunnelExit) => void = () => undefined;
    const exited = new Promise<TunnelExit>((resolve) => {
      end = resolve;
    });
    const tunnel: FakeTunnel = {
      url: `https://fake-tunnel-${String(opened.length + 1)}.trycloudflare.com`,
      target,
      exited,
      stopped: false,
      isConnected: true,
      async connected() {
        return tunnel.isConnected;
      },
      async stop() {
        tunnel.stopped = true;
        end({ code: 0, signal: null, lastLines: [] });
      },
      crash() {
        end({ code: 1, signal: null, lastLines: ["ERR Connection terminated"] });
      },
    };
    opened.push(tunnel);
    return tunnel;
  };
  return { launch, opened };
}

type Session = {
  readonly controller: AbortController;
  readonly out: string[];
  readonly fail: string[];
  readonly code: Promise<number>;
  /** Resolves once the output contains the line. */
  said(text: string, count?: number): Promise<void>;
  stop(): Promise<number>;
};

let platform: Platform;
let workspace: Workspace;
let starter: { readonly port: number; readonly seen: { method: string; url: string; headers: Record<string, unknown>; body: string }[]; close(): Promise<void> };

async function startStarter(): Promise<typeof starter> {
  const seen: (typeof starter)["seen"] = [];
  const server: Server = createServer((incoming, outgoing) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("end", () => {
      seen.push({
        method: incoming.method ?? "",
        url: incoming.url ?? "",
        headers: incoming.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      outgoing.writeHead(200, { "content-type": "application/json" });
      outgoing.end(JSON.stringify({ dailyRoom: "https://example.daily.co/room" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as AddressInfo).port,
    seen,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

beforeEach(async () => {
  [platform, workspace, starter] = await Promise.all([startPlatform(), makeWorkspace(), startStarter()]);
  platform.signedInWith(EGMA_KEY);
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
  await Promise.all([platform.close(), workspace.remove(), starter.close()]);
});

function pipecatAgent(name = "Front desk"): string {
  const response = platform.registered.agents.find((agent) => agent.name === name);
  if (response !== undefined) return response.id;
  throw new Error(`no agent ${name}`);
}

async function register(platformName: "pipecat" | "livekit" = "pipecat", name = "Front desk"): Promise<string> {
  const answer = await fetch(`${platform.url}/v1/agents`, {
    method: "POST",
    headers: { authorization: `Bearer ${EGMA_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ name, agentPlatform: platformName }),
  });
  expect(answer.status).toBe(201);
  return pipecatAgent(name);
}

function start(
  agentId: string,
  launch: TunnelLauncher,
  overrides: Partial<AgentDevCommandOptions> & { readonly egmaHome?: string } = {},
): Session {
  const controller = new AbortController();
  const out: string[] = [];
  const fail: string[] = [];
  const waiting: { text: string; count: number; resolve: () => void }[] = [];
  const check = (): void => {
    const all = [...out, ...fail].join("\n");
    for (const wait of [...waiting]) {
      if (all.split(wait.text).length - 1 >= wait.count) {
        waiting.splice(waiting.indexOf(wait), 1);
        wait.resolve();
      }
    }
  };
  const { egmaHome, ...options } = overrides;
  const code = runAgentDevCommand({
    access: { url: platform.url, credentialsFile: workspace.credentialsFile },
    cwd: workspace.dir,
    env: { EGMA_API_KEY: EGMA_KEY, EGMA_HOME: egmaHome ?? workspace.egmaFolder },
    signal: controller.signal,
    out: (line) => {
      out.push(line);
      check();
    },
    fail: (line) => {
      fail.push(line);
      check();
    },
    agentId,
    port: String(starter.port),
    findCloudflared: async () => "/fake/bin/cloudflared",
    launchTunnel: launch,
    hostname: HOSTNAME,
    supervision: { checkEveryMs: 20, replaceAfterMs: 100, retryDelaysMs: [10], exitGraceMs: 10 },
    ...options,
  });
  return {
    controller,
    out,
    fail,
    code,
    said(text, count = 1) {
      return new Promise<void>((resolve) => {
        waiting.push({ text, count, resolve });
        check();
      });
    },
    async stop() {
      controller.abort("interrupt");
      return await code;
    },
  };
}

function sealedSecret(connectionId: string): string {
  const sealed = platform.registered.sealedOn(connectionId);
  const headers = JSON.parse(sealed?.["headers"] ?? "{}") as Record<string, string>;
  expect(Object.keys(headers)).toEqual([DEV_SECRET_HEADER]);
  return headers[DEV_SECRET_HEADER] as string;
}

function devConnections(agentId: string) {
  return platform.registered.connections.filter(
    (connection) => connection.agentId === agentId && connection.archivedAt === null,
  );
}

async function memory(home = workspace.egmaFolder): Promise<unknown> {
  return JSON.parse(await readFile(path.join(home, "dev-connections.json"), "utf8")) as unknown;
}

function post(
  target: string,
  headers: Record<string, string>,
  body: string,
): Promise<{ readonly status: number; readonly body: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(`${target}/start`);
    const outgoing = httpRequest(
      { host: url.hostname, port: url.port, method: "POST", path: url.pathname, headers },
      (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
        incoming.on("end", () =>
          resolve({ status: incoming.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
        );
      },
    );
    outgoing.on("error", reject);
    outgoing.end(body);
  });
}

describe("egma agent dev", () => {
  it("names a machine's connections from its hostname", () => {
    expect(machineNameOf("Test-Laptop.local")).toBe("test-laptop-local");
    expect(machineNameOf("Nischal's MacBook Pro")).toBe("nischal-s-macbook-pro");
    expect(machineNameOf("a".repeat(60))).toBe("a".repeat(40));
    expect(machineNameOf("...")).toBe("machine");
  });

  it("creates this machine's voice and chat connections on the first start", async () => {
    const agentId = await register();
    const tunnels = fakeTunnels();
    const session = start(agentId, tunnels.launch);
    await session.said("Press Ctrl-C to stop.");

    const made = devConnections(agentId);
    expect(made.map((connection) => [connection.name, connection.modality, connection.accessVariant])).toEqual([
      [`dev-${MACHINE}-voice`, "voice", "daily_room.self_hosted"],
      [`dev-${MACHINE}-chat`, "chat", "daily_room.self_hosted"],
    ]);
    for (const connection of made) {
      expect(connection.agentPlatform).toBe("pipecat");
      expect(connection.connectionType).toBe("daily_room");
      expect(connection.config).toEqual({ startUrl: "https://fake-tunnel-1.trycloudflare.com/start" });
      expect(sealedSecret(connection.id)).toMatch(/^[A-Za-z0-9_-]{43}$/u);
      expect(connection.credentialsHint).toBe(DEV_SECRET_HEADER);
    }
    expect(sealedSecret(made[0]!.id)).toBe(sealedSecret(made[1]!.id));
    expect(tunnels.opened[0]?.target).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);

    expect(await memory()).toEqual({
      format: 1,
      connections: [
        { platformUrl: platform.url, agentId, modality: "voice", connectionId: made[0]!.id },
        { platformUrl: platform.url, agentId, modality: "chat", connectionId: made[1]!.id },
      ],
    });
    expect(await readFile(folderPathsIn(workspace.dir).config, "utf8")).not.toContain(sealedSecret(made[0]!.id));
    expect((await readConfig(folderPathsIn(workspace.dir).config)).agents[0]?.connections.map((one) => one.id).sort()).toEqual(
      made.map((one) => one.id).sort(),
    );

    const said = session.out.join("\n");
    expect(said).toContain("Tunnel: https://fake-tunnel-1.trycloudflare.com");
    expect(said).toContain(`Created Connection "dev-${MACHINE}-voice" (${made[0]!.id}) for voice simulations.`);
    expect(said).toContain(`Created Connection "dev-${MACHINE}-chat" (${made[1]!.id}) for chat simulations.`);
    expect(said).toContain("Start URL: https://fake-tunnel-1.trycloudflare.com/start");
    expect(said).toContain(`egma run create <suite-directory> --agent ${agentId} --connection ${made[0]!.id}`);
    expect(said).toContain(`egma run create <suite-directory> --agent ${agentId} --connection ${made[1]!.id}`);
    expect(said).not.toContain(sealedSecret(made[0]!.id));
    expect(session.fail).toEqual([]);

    expect(await session.stop()).toBe(0);
    expect(tunnels.opened[0]?.stopped).toBe(true);
    expect(session.out.at(-1)).toContain("Stopped. The tunnel is closed.");
    await expect(post(tunnels.opened[0]!.target, {}, "{}")).rejects.toThrow();
  });

  it("lets through only the secret written into the connections, header stripped", async () => {
    const agentId = await register();
    const tunnels = fakeTunnels();
    const session = start(agentId, tunnels.launch);
    await session.said("Press Ctrl-C to stop.");
    const target = tunnels.opened[0]!.target;
    const secret = sealedSecret(devConnections(agentId)[0]!.id);
    const body = JSON.stringify({ createDailyRoom: true, transport: "daily", body: { egma: { simulation_id: "sim_1" } } });

    const without = await post(target, { "content-type": "application/json" }, body);
    const wrong = await post(target, { [DEV_SECRET_HEADER]: `${secret.slice(1)}A` }, body);
    const right = await post(target, { [DEV_SECRET_HEADER]: secret, "content-type": "application/json" }, body);

    expect(without).toEqual({
      status: 401,
      body: '{"error":"egma agent dev refused a request without its secret header"}',
    });
    expect(wrong.status).toBe(401);
    expect(right.status).toBe(200);
    expect(starter.seen).toHaveLength(1);
    expect(starter.seen[0]?.url).toBe("/start");
    expect(starter.seen[0]?.body).toBe(body);
    expect(starter.seen[0]?.headers).not.toHaveProperty("x-egma-dev-secret");
    await session.said("POST /start: 200");
    expect(session.out.join("\n")).toContain(`POST /start: refused, the ${DEV_SECRET_HEADER} header was missing or wrong.`);

    await session.stop();
  });

  it("writes the new start URL and a new secret into the same connections on a later start", async () => {
    const agentId = await register();
    const tunnels = fakeTunnels();
    const first = start(agentId, tunnels.launch);
    await first.said("Press Ctrl-C to stop.");
    const made = devConnections(agentId);
    const firstSecret = sealedSecret(made[0]!.id);
    await first.stop();
    const writesBefore = platform.records.filter((record) => record.method === "POST" && record.path.endsWith("/connections")).length;

    const second = start(agentId, tunnels.launch);
    await second.said("Press Ctrl-C to stop.");

    const now = devConnections(agentId);
    expect(now.map((connection) => connection.id)).toEqual(made.map((connection) => connection.id));
    for (const connection of now) {
      expect(connection.config).toEqual({ startUrl: "https://fake-tunnel-2.trycloudflare.com/start" });
    }
    expect(sealedSecret(now[0]!.id)).not.toBe(firstSecret);
    expect(sealedSecret(now[1]!.id)).toBe(sealedSecret(now[0]!.id));
    expect(platform.records.filter((record) => record.method === "POST" && record.path.endsWith("/connections"))).toHaveLength(writesBefore);
    const edits = platform.records.filter((record) => record.method === "PATCH");
    expect(edits.map((record) => record.path)).toEqual(
      made.map((connection) => `/v1/agents/${agentId}/connections/${connection.id}`),
    );
    expect(edits[0]?.body).toEqual({
      config: { startUrl: "https://fake-tunnel-2.trycloudflare.com/start" },
      credentials: { headers: JSON.stringify({ [DEV_SECRET_HEADER]: sealedSecret(now[0]!.id) }) },
    });
    expect(second.out.join("\n")).toContain(`Updated Connection "dev-${MACHINE}-voice" (${made[0]!.id}) for voice simulations.`);
    expect(second.out.join("\n")).toContain(`--connection ${made[1]!.id}`);

    await second.stop();
  });

  it("gives a second machine its own connections and leaves the first's alone", async () => {
    const agentId = await register();
    const tunnels = fakeTunnels();
    const first = start(agentId, tunnels.launch);
    await first.said("Press Ctrl-C to stop.");
    const firstMade = devConnections(agentId);

    const otherHome = path.join(workspace.dir, "other-machine-home");
    const second = start(agentId, tunnels.launch, { egmaHome: otherHome });
    await second.said("Press Ctrl-C to stop.");

    const all = devConnections(agentId);
    expect(all).toHaveLength(4);
    const secondMade = all.filter((connection) => !firstMade.some((one) => one.id === connection.id));
    expect(secondMade.map((connection) => connection.name)).toEqual([
      `dev-${MACHINE}-voice-2`,
      `dev-${MACHINE}-chat-2`,
    ]);
    for (const connection of firstMade) {
      expect(connection.config).toEqual({ startUrl: "https://fake-tunnel-1.trycloudflare.com/start" });
    }
    for (const connection of secondMade) {
      expect(connection.config).toEqual({ startUrl: "https://fake-tunnel-2.trycloudflare.com/start" });
    }
    expect(await memory(otherHome)).toMatchObject({
      connections: [{ connectionId: secondMade[0]!.id }, { connectionId: secondMade[1]!.id }],
    });
    expect(await memory()).toMatchObject({
      connections: [{ connectionId: firstMade[0]!.id }, { connectionId: firstMade[1]!.id }],
    });

    await Promise.all([first.stop(), second.stop()]);
  });

  it("replaces a remembered connection that was archived or is gone", async () => {
    const agentId = await register();
    const tunnels = fakeTunnels();
    const first = start(agentId, tunnels.launch);
    await first.said("Press Ctrl-C to stop.");
    await first.stop();
    const [voice, chat] = devConnections(agentId);
    platform.registered.archiveConnection(voice!.id);
    platform.registered.forgetConnection(chat!.id);

    const second = start(agentId, tunnels.launch);
    await second.said("Press Ctrl-C to stop.");

    const now = devConnections(agentId);
    expect(now.map((connection) => connection.name)).toEqual([`dev-${MACHINE}-voice`, `dev-${MACHINE}-chat`]);
    expect(now.map((connection) => connection.id)).not.toContain(voice!.id);
    expect(now.map((connection) => connection.id)).not.toContain(chat!.id);
    expect(platform.records.filter((record) => record.method === "PATCH")).toHaveLength(0);
    expect(await memory()).toEqual({
      format: 1,
      connections: [
        { platformUrl: platform.url, agentId, modality: "voice", connectionId: now[0]!.id },
        { platformUrl: platform.url, agentId, modality: "chat", connectionId: now[1]!.id },
      ],
    });

    await second.stop();
  });

  it("refuses an agent that is not a Pipecat agent, before any tunnel", async () => {
    const agentId = await register("livekit", "Receptionist");
    const tunnels = fakeTunnels();
    const session = start(agentId, tunnels.launch);

    expect(await session.code).toBe(1);
    expect(session.fail).toEqual([`egma agent dev works with Pipecat agents; ${agentId} is a LiveKit agent.`]);
    expect(tunnels.opened).toHaveLength(0);
  });

  it("refuses to start without cloudflared, and says how to install it", async () => {
    const agentId = await register();
    const tunnels = fakeTunnels();
    const session = start(agentId, tunnels.launch, { findCloudflared: async () => null });

    expect(await session.code).toBe(1);
    expect(session.fail).toEqual([
      "egma agent dev needs cloudflared. Install it with brew install cloudflared, or see https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/",
    ]);
    expect(tunnels.opened).toHaveLength(0);
    expect(platform.records.filter((record) => record.path.startsWith("/v1/agents/"))).toHaveLength(0);
  });

  it("warns, and still starts, when nothing listens on the port", async () => {
    const agentId = await register();
    await starter.close();
    const tunnels = fakeTunnels();
    const session = start(agentId, tunnels.launch);
    await session.said("Press Ctrl-C to stop.");

    expect(session.fail).toContain(
      `Nothing is listening on port ${String(starter.port)} yet. Start your bot's development runner (for example python bot.py -t daily), then run a simulation.`,
    );
    const secret = sealedSecret(devConnections(agentId)[0]!.id);
    const answer = await post(tunnels.opened[0]!.target, { [DEV_SECRET_HEADER]: secret }, "{}");
    expect(answer.status).toBe(502);
    await session.said(`POST /start: 502, egma agent dev could not reach port ${String(starter.port)}: nothing is listening there.`);

    await session.stop();
  });

  it("stops with cloudflared's last lines when the tunnel does not open, and writes nothing", async () => {
    const agentId = await register();
    const tunnels = fakeTunnels({ failFirst: 1 });
    const session = start(agentId, tunnels.launch);

    expect(await session.code).toBe(1);
    expect(session.fail).toContain("cloudflared stopped before the tunnel was ready (exit code 1).");
    expect(session.fail).toContain("  ERR failed to request quick Tunnel: Post https://api.trycloudflare.com/tunnel: EOF");
    expect(devConnections(agentId)).toHaveLength(0);
  });

  it("opens a new tunnel when cloudflared ends, and points the same connections at it", async () => {
    const agentId = await register();
    const tunnels = fakeTunnels();
    const session = start(agentId, tunnels.launch);
    await session.said("Press Ctrl-C to stop.");
    const made = devConnections(agentId);
    const secret = sealedSecret(made[0]!.id);

    tunnels.opened[0]!.crash();
    await session.said("Ready again.");

    expect(session.fail.join("\n")).toContain("cloudflared stopped (exit code 1). Opening a new tunnel");
    expect(tunnels.opened).toHaveLength(2);
    expect(tunnels.opened[1]?.target).toBe(tunnels.opened[0]?.target);
    const now = devConnections(agentId);
    expect(now.map((connection) => connection.id)).toEqual(made.map((connection) => connection.id));
    for (const connection of now) {
      expect(connection.config).toEqual({ startUrl: "https://fake-tunnel-2.trycloudflare.com/start" });
    }
    expect(sealedSecret(now[0]!.id)).toBe(secret);

    expect(await session.stop()).toBe(0);
    expect(tunnels.opened[1]?.stopped).toBe(true);
  });

  it("replaces a tunnel that stays without a Cloudflare connection, retrying a failed open", async () => {
    const agentId = await register();
    const tunnels = fakeTunnels();
    const session = start(agentId, tunnels.launch);
    await session.said("Press Ctrl-C to stop.");

    tunnels.opened[0]!.isConnected = false;
    await session.said("Ready again.");

    expect(tunnels.opened[0]?.stopped).toBe(true);
    expect(session.fail.join("\n")).toContain("has had no connection to Cloudflare");
    for (const connection of devConnections(agentId)) {
      expect(connection.config).toEqual({ startUrl: "https://fake-tunnel-2.trycloudflare.com/start" });
    }

    await session.stop();
  });

  it("keeps a tunnel whose connection state cannot be read", async () => {
    const agentId = await register();
    const tunnels = fakeTunnels();
    const session = start(agentId, tunnels.launch);
    await session.said("Press Ctrl-C to stop.");

    tunnels.opened[0]!.isConnected = undefined;
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(tunnels.opened).toHaveLength(1);
    await session.stop();
  });

  it("refuses a dev-connections file it cannot read, and leaves it as it was", async () => {
    const agentId = await register();
    await mkdir(workspace.egmaFolder, { recursive: true });
    const file = path.join(workspace.egmaFolder, "dev-connections.json");
    await writeFile(file, "{ not json", "utf8");
    const tunnels = fakeTunnels();
    const session = start(agentId, tunnels.launch);

    expect(await session.code).toBe(1);
    expect(session.fail[0]).toContain(`Egma could not read ${file}`);
    expect(await readFile(file, "utf8")).toBe("{ not json");
    expect(tunnels.opened).toHaveLength(0);
  });

  it.each(["0", "65536", "http", "78.6"])("refuses --port %s", async (port) => {
    const agentId = await register();
    const tunnels = fakeTunnels();
    const session = start(agentId, tunnels.launch, { port });

    expect(await session.code).toBe(1);
    expect(session.fail[0]).toContain("--port is the port your bot's development runner listens on");
  });

  it("stops before the tunnel is ready when Ctrl-C comes first", async () => {
    const agentId = await register();
    let release: () => void = () => undefined;
    const slow: TunnelLauncher = ({ signal }) =>
      new Promise((_resolve, reject) => {
        release = () => reject(new TunnelStartFailure("The tunnel was not opened: the command was stopped.", []));
        signal.addEventListener("abort", () => release(), { once: true });
      });
    const session = start(agentId, slow);
    await session.said("Opening a Cloudflare quick tunnel.");

    expect(await session.stop()).toBe(130);
    expect(session.fail).toContain("The command was stopped before the tunnel was ready.");
    expect(devConnections(agentId)).toHaveLength(0);
  });
});
