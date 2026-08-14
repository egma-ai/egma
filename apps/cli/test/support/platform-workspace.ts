/**
 * The two stand-ins every `egma self-host` check needs, in one place.
 *
 * A self-host command talks to exactly two things it cannot have in a test: a
 * running platform, and a container runtime. Everything above those is the real
 * CLI process and the real command modules, which is the point — a suite that
 * started Docker would take minutes and a suite that mocked the command would
 * prove nothing.
 *
 * These lived twice, copied between the files that drive `up`. Two copies of a
 * harness drift, and a drifted harness is two tests that believe they check the
 * same command and do not, so there is one copy and it lives here.
 */

import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { CLI_ENTRY } from "./workspace.ts";

export type FakePlatform = {
  readonly url: string;
  /** Every path asked for, so a test can prove what a command did *not* do. */
  readonly asked: readonly string[];
  close(): Promise<void>;
};

export type FakePlatformOptions = {
  /**
   * What origin the platform reports about itself, given its own address.
   *
   * Its own by default. A test overrides it to build the one disaster `up`
   * exists to catch: a deployment started on one address whose API reports
   * another, which makes every later command in every agent repository fail a
   * directory away from anything that could explain it.
   */
  readonly reports?: (own: string) => string;
  /** Phone readiness, which is reported separately from platform readiness. */
  readonly phone?: { readonly state: string; readonly missing: readonly string[] };
};

/** A stand-in for a running platform, answering only what `self-host` reads. */
export async function startPlatform(
  options: FakePlatformOptions = {},
): Promise<FakePlatform> {
  const phone = options.phone ?? { state: "setup_required", missing: ["the carrier trunk"] };
  const asked: string[] = [];
  const server: Server = createServer((request, answer) => {
    asked.push(`${request.method ?? ""} ${request.url ?? ""}`);
    answer.writeHead(200, { "content-type": "application/json" });
    answer.end(
      JSON.stringify({
        instance_id: "pf_00000000000000000000000001",
        origin: options.reports === undefined ? url : options.reports(url),
        phone: { state: phone.state, missing: phone.missing },
      }),
    );
  });
  await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;
  return {
    url,
    asked,
    close: () =>
      new Promise<void>((closed) => {
        server.close(() => closed());
      }),
  };
}

/**
 * The variables the `docker` stand-in writes down beside the arguments it was
 * given.
 *
 * The environment matters more than the arguments for most of what these
 * commands promise: what a self-host command really has to get right is what
 * compose is *told*, not what the command printed about it. A variable a
 * compose invocation does not carry never reaches a container however it is
 * set.
 */
const RECORDED_VARIABLES = [
  "EGMA_BASE_URL",
  "EGMA_LIVEKIT_API_KEY",
  "EGMA_LIVEKIT_API_SECRET",
] as const;

export type PlatformWorkspace = {
  readonly dir: string;
  readonly binDir: string;
  /** The `docker` stand-in, for a test that needs one that behaves otherwise. */
  readonly dockerShim: string;
  /** Where that stand-in appends what it was asked for. */
  readonly callsFile: string;
  dockerCalls(): Promise<string>;
  /** The platform's own configuration file, whether or not it exists yet. */
  readonly configFile: string;
  /** What egma wrote there, as names and values. */
  storedConfig(): Promise<Record<string, string>>;
};

/**
 * A directory shaped like a platform workspace, with a `docker` on its PATH
 * that succeeds and writes down what it was asked for.
 *
 * Standing in for the container runtime rather than for egma: everything the
 * command does above `docker compose` is the real thing.
 */
export async function makePlatformWorkspace(prefix: string): Promise<PlatformWorkspace> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  await writeFile(path.join(dir, "docker-compose.yml"), "name: egma\nservices: {}\n");
  const binDir = path.join(dir, "bin");
  await mkdir(binDir, { recursive: true });
  const callsFile = path.join(dir, "docker-calls.txt");
  await writeFile(callsFile, "");
  const dockerShim = path.join(binDir, "docker");
  await writeFile(
    dockerShim,
    `#!/bin/sh\necho "ARGS $@" >> "${callsFile}"\n` +
      RECORDED_VARIABLES.map(
        (name) => `echo "${name}=\${${name}}" >> "${callsFile}"\n`,
      ).join("") +
      "exit 0\n",
  );
  await chmod(dockerShim, 0o755);

  const configFile = path.join(dir, ".egma-platform", "platform.env");
  return {
    dir,
    binDir,
    dockerShim,
    callsFile,
    configFile,
    dockerCalls: () => readFile(callsFile, "utf8"),
    storedConfig: async () => {
      const found: Record<string, string> = {};
      for (const line of (await readFile(configFile, "utf8")).split("\n")) {
        const text = line.trim();
        if (text === "" || text.startsWith("#")) continue;
        const split = text.indexOf("=");
        if (split <= 0) continue;
        found[text.slice(0, split)] = text.slice(split + 1);
      }
      return found;
    },
  };
}

export type SelfHostRun = {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
};

/**
 * One `egma self-host …` run, as a person would type it.
 *
 * The workspace is taken structurally — a directory and a `bin` to find
 * `docker` in — so that a check can run the command from somewhere that is
 * deliberately *not* a platform workspace.
 */
export async function runSelfHost(
  workspace: { readonly dir: string; readonly binDir: string },
  argv: readonly string[],
  env: NodeJS.ProcessEnv = {},
): Promise<SelfHostRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_ENTRY, "self-host", ...argv], {
      cwd: workspace.dir,
      env: { ...process.env, PATH: `${workspace.binDir}:${process.env.PATH ?? ""}`, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}
