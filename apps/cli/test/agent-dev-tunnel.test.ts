/**
 * The cloudflared launcher against a stand-in cloudflared that prints the real
 * log lines: the address and readiness are read from its output, a process
 * that ends or never answers is reported with its last lines, and stop() ends
 * the process even when it ignores SIGTERM.
 */

import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  cloudflaredLauncher,
  findExecutable,
  metricsAddressIn,
  saysRegistered,
  TunnelStartFailure,
  tunnelAddressIn,
} from "../src/dev/tunnel.ts";

vi.setConfig({ testTimeout: 20_000 });

/** Lines copied from cloudflared 2026.9.1's quick-tunnel output. */
const BOX_LINE = "2026-09-23T08:00:39Z INF |  https://street-concert-contracting-decor.trycloudflare.com                                |";
const METRICS_LINE = "2026-09-23T08:00:39Z INF Starting metrics server on 127.0.0.1:20243/metrics";
const REGISTERED_LINE =
  "2026-09-23T08:00:40Z INF Registered tunnel connection connIndex=0 connection=89c9937d-055d-46a6-bcb9-bfe16f99e5c1 event=0 ip=2606:4700:a8::10 location=sjc07 protocol=quic";

const FAKE = `
import { createServer } from "node:http";
import { appendFileSync } from "node:fs";
const mode = process.env.FAKE_MODE;
appendFileSync(process.env.FAKE_ARGS, JSON.stringify(process.argv.slice(2)) + "\\n");
const say = (line) => process.stderr.write(new Date().toISOString() + " INF " + line + "\\n");
say("Thank you for trying Cloudflare Tunnel.");
say("Requesting new quick Tunnel on trycloudflare.com...");
if (mode === "die") {
  process.stderr.write("2026-09-23T08:00:37Z ERR failed to request quick Tunnel: Post \\"https://api.trycloudflare.com/tunnel\\": EOF\\n");
  process.exit(1);
}
if (mode === "silent") {
  setInterval(() => {}, 1000);
} else {
  const ready = { count: 1 };
  const metrics = createServer((q, r) => {
    if (q.url === "/ready") {
      r.writeHead(ready.count > 0 ? 200 : 503, { "content-type": "application/json" });
      r.end(JSON.stringify({ status: ready.count > 0 ? 200 : 503, readyConnections: ready.count, connectorId: "x" }));
    } else { r.writeHead(404); r.end(); }
  });
  metrics.listen(0, "127.0.0.1", () => {
    say("+--------------------------------------------------------------------------------------------+");
    say("|  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |");
    say("|  https://street-concert-contracting-decor.trycloudflare.com                                |");
    say("Starting metrics server on 127.0.0.1:" + metrics.address().port + "/metrics");
    if (mode === "no-edge") return;
    setTimeout(() => {
      say("Registered tunnel connection connIndex=0 event=0 location=sjc07 protocol=quic");
      if (mode === "drop") setTimeout(() => { ready.count = 0; say("ERR Connection terminated connIndex=0"); }, 200);
    }, 100);
  });
  process.on("SIGTERM", () => {
    if (mode === "stubborn") { say("ignoring SIGTERM"); return; }
    say("Initiating graceful shutdown due to signal terminated ...");
    metrics.close();
    process.exit(0);
  });
}
`;

let folder: string;
let script: string;

/** Tests never ask real DNS about the stand-in's hostname. */
const IN_DNS = async (): Promise<boolean> => true;

beforeAll(async () => {
  folder = await mkdtemp(path.join(tmpdir(), "egma-fake-cloudflared-"));
  script = path.join(folder, "fake-cloudflared.mjs");
  await writeFile(script, FAKE, "utf8");
  return async () => rm(folder, { recursive: true, force: true });
});

const stops: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
});

/** A cloudflared on disk that runs the stand-in in one mode. */
async function fakeCloudflared(mode: string): Promise<{ readonly executable: string; readonly args: string }> {
  const directory = path.join(folder, mode);
  await mkdir(directory, { recursive: true });
  const executable = path.join(directory, "cloudflared");
  const args = path.join(directory, "args.jsonl");
  await writeFile(
    executable,
    `#!/bin/sh\nFAKE_MODE='${mode}' FAKE_ARGS='${args}' exec '${process.execPath}' '${script}' "$@"\n`,
    "utf8",
  );
  await chmod(executable, 0o755);
  return { executable, args };
}

describe("reading cloudflared's output", () => {
  it("finds the quick-tunnel address in the boxed line", () => {
    expect(tunnelAddressIn(BOX_LINE)).toBe("https://street-concert-contracting-decor.trycloudflare.com");
    expect(tunnelAddressIn("\u001b[32m|  https://Street-Concert.trycloudflare.com  |\u001b[0m")).toBe(
      "https://street-concert.trycloudflare.com",
    );
  });

  it("does not take the quick-tunnel API or another host for the address", () => {
    expect(tunnelAddressIn('ERR failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel": EOF')).toBeNull();
    expect(tunnelAddressIn("Requesting new quick Tunnel on trycloudflare.com...")).toBeNull();
    expect(tunnelAddressIn("https://a-b.trycloudflare.com.evil.example")).toBeNull();
  });

  it("finds the metrics server and the first edge connection", () => {
    expect(metricsAddressIn(METRICS_LINE)).toBe("127.0.0.1:20243");
    expect(saysRegistered(REGISTERED_LINE)).toBe(true);
    expect(saysRegistered("INF Tunnel connection curve preferences: [X25519MLKEM768]")).toBe(false);
  });
});

describe("finding cloudflared", () => {
  it("finds an executable file on PATH and skips what is not one", async () => {
    const first = path.join(folder, "path-first");
    const second = path.join(folder, "path-second");
    await mkdir(first, { recursive: true });
    await mkdir(second, { recursive: true });
    await writeFile(path.join(first, "cloudflared"), "not executable", { mode: 0o644 });
    await mkdir(path.join(second, "cloudflared-dir"), { recursive: true });
    await writeFile(path.join(second, "cloudflared"), "#!/bin/sh\n", { mode: 0o755 });

    expect(await findExecutable("cloudflared", { PATH: [first, second].join(path.delimiter) }, "darwin")).toBe(
      path.join(second, "cloudflared"),
    );
    expect(await findExecutable("cloudflared", { PATH: first }, "darwin")).toBeNull();
    expect(await findExecutable("cloudflared", {}, "darwin")).toBeNull();
  });
});

describe("the cloudflared launcher", () => {
  it("runs `cloudflared tunnel --no-autoupdate --url <target>` and resolves once connected", async () => {
    const fake = await fakeCloudflared("normal");
    const tunnel = await cloudflaredLauncher(fake.executable, { waitForDns: IN_DNS })({
      target: "http://127.0.0.1:43210",
      signal: new AbortController().signal,
    });
    stops.push(() => tunnel.stop());

    expect(tunnel.url).toBe("https://street-concert-contracting-decor.trycloudflare.com");
    expect((await readFile(fake.args, "utf8")).trim()).toBe(
      JSON.stringify(["tunnel", "--no-autoupdate", "--url", "http://127.0.0.1:43210"]),
    );
    expect(await tunnel.connected()).toBe(true);

    await tunnel.stop();
    const exit = await tunnel.exited;
    expect(exit.code).toBe(0);
    expect(exit.lastLines.at(-1)).toContain("Initiating graceful shutdown");
    expect(await tunnel.connected()).toBe(false);
  });

  it("hands the tunnel out only after its hostname is in public DNS", async () => {
    const fake = await fakeCloudflared("normal");
    let answer: (inDns: boolean) => void = () => undefined;
    const asked: string[] = [];
    const starting = cloudflaredLauncher(fake.executable, {
      waitForDns: (hostname) => {
        asked.push(hostname);
        return new Promise<boolean>((resolve) => {
          answer = resolve;
        });
      },
    })({ target: "http://127.0.0.1:43210", signal: new AbortController().signal });
    let handedOut = false;
    void starting.then(() => {
      handedOut = true;
    });

    await vi.waitFor(() => expect(asked).toEqual(["street-concert-contracting-decor.trycloudflare.com"]));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(handedOut).toBe(false);
    answer(false);
    const tunnel = await starting;
    stops.push(() => tunnel.stop());

    expect(tunnel.inPublicDns).toBe(false);
  });

  it("reports a dropped edge connection through /ready", async () => {
    const fake = await fakeCloudflared("drop");
    const tunnel = await cloudflaredLauncher(fake.executable, { waitForDns: IN_DNS })({
      target: "http://127.0.0.1:43210",
      signal: new AbortController().signal,
    });
    stops.push(() => tunnel.stop());

    await vi.waitFor(async () => expect(await tunnel.connected()).toBe(false), { timeout: 5_000 });
  });

  it("fails with cloudflared's last lines when it ends before the tunnel is ready", async () => {
    const fake = await fakeCloudflared("die");
    const failure = await cloudflaredLauncher(fake.executable, { waitForDns: IN_DNS })({
      target: "http://127.0.0.1:43210",
      signal: new AbortController().signal,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(TunnelStartFailure);
    expect((failure as TunnelStartFailure).message).toBe(
      "cloudflared stopped before the tunnel was ready (exit code 1).",
    );
    expect((failure as TunnelStartFailure).lastLines.at(-1)).toContain("failed to request quick Tunnel");
  });

  it("gives up when no address arrives in time, and ends the process", async () => {
    const fake = await fakeCloudflared("silent");
    const started = Date.now();
    const failure = await cloudflaredLauncher(fake.executable, { addressTimeoutMs: 800, stopTimeoutMs: 500, waitForDns: IN_DNS })({
      target: "http://127.0.0.1:43210",
      signal: new AbortController().signal,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(TunnelStartFailure);
    expect((failure as Error).message).toContain("did not print a trycloudflare.com address");
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("gives up when the address never connects to Cloudflare", async () => {
    const fake = await fakeCloudflared("no-edge");
    const failure = await cloudflaredLauncher(fake.executable, { connectTimeoutMs: 800, waitForDns: IN_DNS })({
      target: "http://127.0.0.1:43210",
      signal: new AbortController().signal,
    }).catch((error: unknown) => error);

    expect((failure as Error).message).toBe(
      "cloudflared made the address https://street-concert-contracting-decor.trycloudflare.com but did not connect to Cloudflare within 1 seconds.",
    );
  });

  it("ends a process that ignores SIGTERM with SIGKILL", async () => {
    const fake = await fakeCloudflared("stubborn");
    const tunnel = await cloudflaredLauncher(fake.executable, { stopTimeoutMs: 300, waitForDns: IN_DNS })({
      target: "http://127.0.0.1:43210",
      signal: new AbortController().signal,
    });

    await tunnel.stop();
    const exit = await tunnel.exited;
    expect(exit.signal).toBe("SIGKILL");
  });

  it("ends the process and rejects when the command is stopped while it starts", async () => {
    const fake = await fakeCloudflared("silent");
    const controller = new AbortController();
    const starting = cloudflaredLauncher(fake.executable, { stopTimeoutMs: 300, waitForDns: IN_DNS })({
      target: "http://127.0.0.1:43210",
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 200);

    await expect(starting).rejects.toThrow("The tunnel was not opened: the command was stopped.");
  });

  it("says cloudflared is missing when the executable is not there", async () => {
    await expect(
      cloudflaredLauncher(path.join(folder, "nowhere", "cloudflared"))({
        target: "http://127.0.0.1:43210",
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("egma agent dev needs cloudflared.");
  });
});
