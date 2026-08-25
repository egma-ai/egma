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

import { BOOTSTRAP_VARIABLES } from "../../src/self-host/workspace.ts";
import { CLI_ENTRY } from "./workspace.ts";

/** The key this stand-in accepts, and the only one it accepts. */
export const OWNER_KEY = "egma_ak_the-owner-of-this-fake-platform";

export type FakePlatform = {
  readonly url: string;
  /** Every path asked for, so a test can prove what a command did *not* do. */
  readonly asked: readonly string[];
  close(): Promise<void>;
};

/**
 * A stand-in for the one platform endpoint `self-host up` reads.
 */
export async function startPlatform(): Promise<FakePlatform> {
  const asked: string[] = [];
  const server: Server = createServer((request, answer) => {
    asked.push(`${request.method ?? ""} ${request.url ?? ""}`);
    const send = (status: number, body: unknown): void => {
      answer.writeHead(status, { "content-type": "application/json" });
      answer.end(JSON.stringify(body));
    };

    if (request.url === "/api/health") {
      send(200, { status: "ok" });
      return;
    }

    send(404, { error: "not_found", message: "not found" });
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
  ...BOOTSTRAP_VARIABLES,
  // Recorded so checks can prove the carrier route reaches Compose literally
  // but does not enter the bootstrap file.
  "EGMA_PHONE_TRUNK_ADDRESS",
  "EGMA_PHONE_SOURCE_NUMBER",
  "EGMA_PHONE_TRUNK_USERNAME",
  "EGMA_PHONE_TRUNK_PASSWORD",
] as const;

export type PlatformWorkspace = {
  readonly dir: string;
  readonly binDir: string;
  /** The `docker` stand-in, for a test that needs one that behaves otherwise. */
  readonly dockerShim: string;
  /** Where that stand-in appends what it was asked for. */
  readonly callsFile: string;
  dockerCalls(): Promise<string>;
  /** The workspace's bootstrap variables, whether or not the file exists yet. */
  readonly configFile: string;
  /** What egma wrote there, as names and values. */
  storedConfig(): Promise<Record<string, string>>;
  /**
   * Where this run's keys live, so that a check never reads or writes the
   * credentials of whoever is running the suite.
   */
  readonly egmaHome: string;
  /** Hand this machine an owner's key for a platform, as `egma login` would. */
  signIn(platform: { readonly url: string }): Promise<void>;
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
      `case "$*" in *"config --environment"*)\n` +
      `  if [ -f .env ]; then\n` +
      `    node -e 'const fs=require("node:fs"); const u=require("node:util"); for (const [n,v] of Object.entries(u.parseEnv(fs.readFileSync(".env","utf8")))) process.stdout.write(n+"="+v+"\\n")'\n` +
      `  fi\n` +
      `  env\n` +
      `  exit 0\n` +
      `;; esac\n` +
      `case "$*" in *"volume ls"*) exit 0 ;; esac\n` +
      RECORDED_VARIABLES.map(
        (name) => `echo "${name}=\${${name}}" >> "${callsFile}"\n`,
      ).join("") +
      "exit 0\n",
  );
  await chmod(dockerShim, 0o755);

  const configFile = path.join(dir, ".egma-platform", "platform.env");
  const egmaHome = path.join(dir, "egma-home");
  await mkdir(egmaHome, { recursive: true });
  return {
    dir,
    binDir,
    dockerShim,
    callsFile,
    configFile,
    egmaHome,
    signIn: async (platform) => {
      await writeFile(
        path.join(egmaHome, "credentials"),
        JSON.stringify({ platforms: { [platform.url]: { key: OWNER_KEY } } }),
      );
    },
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
  workspace: {
    readonly dir: string;
    readonly binDir: string;
    readonly egmaHome?: string;
  },
  argv: readonly string[],
  env: NodeJS.ProcessEnv = {},
): Promise<SelfHostRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_ENTRY, "self-host", ...argv], {
      cwd: workspace.dir,
      env: {
        ...process.env,
        PATH: `${workspace.binDir}:${process.env.PATH ?? ""}`,
        // Named outright rather than by moving HOME, so a check can be certain
        // it neither reads nor writes the keys of whoever is running the suite.
        ...(workspace.egmaHome === undefined ? {} : { EGMA_HOME: workspace.egmaHome }),
        ...env,
      },
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
