/**
 * The media server's credential, which a deployment now makes for itself.
 *
 * **This closes a hole that was open in a running deployment**, not a
 * hypothetical one. The media server, the simulator and the SIP bridge all fell
 * back to a key and a secret written into the compose file in the public
 * repository, and nothing in the CLI, the skills or the documentation ever
 * replaced them. Bound to loopback the exposure is small; the compose file
 * invites a wider bind for testing from another machine, and at that moment the
 * media server accepts anyone who read the repository.
 *
 * So preparing a workspace mints a random pair. What is worth proving, in the
 * order it would cost to get wrong:
 *
 * 1. **A second preparation does not replace it.** A regenerated pair is a
 *    running deployment whose three media containers stop agreeing, and the
 *    symptom is every phone simulation failing to authenticate.
 * 2. **The pair reaches compose**, because a credential written to a file no
 *    container reads is the same as no credential at all.
 * 3. **The secret is never printed.** It is a password between egma's own
 *    parts, and the operator never sees it, chooses it or types it.
 * 4. **A workspace prepared before this change is told** what happened, because
 *    its containers are recreated underneath it.
 */

import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { CLI_ENTRY } from "./support/workspace.ts";

/** The pair that was published in this repository, and must never come back. */
const PUBLISHED_KEY = "egma-devkey";
const PUBLISHED_SECRET = "egma-development-only-livekit-secret-change-it";

const KEY_VARIABLE = "EGMA_LIVEKIT_API_KEY";
const SECRET_VARIABLE = "EGMA_LIVEKIT_API_SECRET";

type FakePlatform = { readonly url: string; close(): Promise<void> };

/** A stand-in for the running platform, answering only what `up` reads. */
async function startPlatform(): Promise<FakePlatform> {
  const server: Server = createServer((_request, answer) => {
    answer.writeHead(200, { "content-type": "application/json" });
    answer.end(
      JSON.stringify({
        instance_id: "pf_00000000000000000000000001",
        origin: url,
        phone: { state: "setup_required", missing: ["the carrier trunk"] },
      }),
    );
  });
  await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;
  return {
    url,
    close: () =>
      new Promise<void>((closed) => {
        server.close(() => closed());
      }),
  };
}

type Workspace = {
  readonly dir: string;
  readonly binDir: string;
  /** What compose was asked for, and what it was asked for it with. */
  dockerCalls(): Promise<string>;
  /** What egma wrote down, as names and values. */
  storedConfig(): Promise<Record<string, string>>;
};

/**
 * A workspace with a `docker` on its PATH that succeeds and writes down the two
 * media variables it was handed.
 *
 * The environment matters more than the arguments here: the whole claim is that
 * the three media containers are handed one pair, and a compose invocation that
 * carried neither variable would leave every one of them to its own default.
 */
async function makeWorkspace(): Promise<Workspace> {
  const dir = await mkdtemp(path.join(tmpdir(), "egma-media-credential-"));
  await writeFile(path.join(dir, "docker-compose.yml"), "name: egma\nservices: {}\n");
  const binDir = path.join(dir, "bin");
  await mkdir(binDir, { recursive: true });
  const calls = path.join(dir, "docker-calls.txt");
  await writeFile(calls, "");
  const shim = path.join(binDir, "docker");
  await writeFile(
    shim,
    `#!/bin/sh\necho "ARGS $@" >> "${calls}"\n` +
      `echo "${KEY_VARIABLE}=\${${KEY_VARIABLE}}" >> "${calls}"\n` +
      `echo "${SECRET_VARIABLE}=\${${SECRET_VARIABLE}}" >> "${calls}"\nexit 0\n`,
  );
  await chmod(shim, 0o755);
  return {
    dir,
    binDir,
    dockerCalls: () => readFile(calls, "utf8"),
    storedConfig: async () => {
      const file = path.join(dir, ".egma-platform", "platform.env");
      const found: Record<string, string> = {};
      for (const line of (await readFile(file, "utf8")).split("\n")) {
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

type Run = { readonly code: number; readonly stdout: string; readonly stderr: string };

async function runUp(
  workspace: Workspace,
  platform: FakePlatform,
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_ENTRY, "self-host", "up"], {
      cwd: workspace.dir,
      env: {
        ...process.env,
        PATH: `${workspace.binDir}:${process.env.PATH ?? ""}`,
        EGMA_BASE_URL: platform.url,
        ...extraEnv,
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

describe("the media server's credential", () => {
  it("is generated when a workspace is prepared, and is not the published one", async () => {
    const platform = await startPlatform();
    const workspace = await makeWorkspace();
    try {
      const run = await runUp(workspace, platform);

      expect(run.code).toBe(0);
      expect(run.stdout).toContain("media_credential: generated");

      const stored = await workspace.storedConfig();
      const key = stored[KEY_VARIABLE] ?? "";
      const secret = stored[SECRET_VARIABLE] ?? "";

      expect(key).not.toBe("");
      expect(secret).not.toBe("");
      expect(key).not.toBe(PUBLISHED_KEY);
      expect(secret).not.toBe(PUBLISHED_SECRET);
      // LiveKit refuses a secret shorter than 32 characters, and a short one is
      // guessable besides. Asserted rather than trusted, because the length is
      // one edit away from being trimmed to something tidy-looking.
      expect(secret.length).toBeGreaterThanOrEqual(32);
      // Nothing in either value may need quoting: they travel through a
      // `NAME=value` file egma parses itself, a child process environment, and
      // a YAML scalar in the compose file.
      expect(key).toMatch(/^[A-Za-z0-9_-]+$/u);
      expect(secret).toMatch(/^[A-Za-z0-9_-]+$/u);

      // It is a password between egma's own parts. The operator never sees it.
      expect(`${run.stdout}\n${run.stderr}`).not.toContain(secret);
    } finally {
      await platform.close();
    }
  });

  it("hands that one pair to compose, so the three media containers agree", async () => {
    const platform = await startPlatform();
    const workspace = await makeWorkspace();
    try {
      await runUp(workspace, platform);

      const stored = await workspace.storedConfig();
      const calls = await workspace.dockerCalls();
      // A credential written to a file no container reads is no credential at
      // all: what proves this works is compose being handed the same pair.
      expect(calls).toContain(`${KEY_VARIABLE}=${stored[KEY_VARIABLE] as string}`);
      expect(calls).toContain(`${SECRET_VARIABLE}=${stored[SECRET_VARIABLE] as string}`);
    } finally {
      await platform.close();
    }
  });

  it("leaves a pair that already exists alone, so a second start breaks nothing", async () => {
    const platform = await startPlatform();
    const workspace = await makeWorkspace();
    try {
      await runUp(workspace, platform);
      const first = await workspace.storedConfig();

      const second = await runUp(workspace, platform);
      const after = await workspace.storedConfig();

      expect(second.code).toBe(0);
      expect(after[KEY_VARIABLE]).toBe(first[KEY_VARIABLE]);
      expect(after[SECRET_VARIABLE]).toBe(first[SECRET_VARIABLE]);
      // And it says which of the two happened, because "generated" on a running
      // deployment is the line that explains why its containers were replaced.
      expect(second.stdout).toContain("media_credential: existing");
      expect(second.stdout).not.toContain("media_credential: generated");
    } finally {
      await platform.close();
    }
  });

  it("gives a workspace prepared before this change a pair, and says so", async () => {
    const platform = await startPlatform();
    const workspace = await makeWorkspace();
    try {
      // What an upgrading deployment's workspace holds: everything phone setup
      // wrote, and no media credential, because there was nothing to write it.
      await mkdir(path.join(workspace.dir, ".egma-platform"), { recursive: true });
      await writeFile(
        path.join(workspace.dir, ".egma-platform", "platform.env"),
        "EGMA_PHONE_SOURCE_NUMBER=+15550100100\nEGMA_SIMULATOR_MEDIA_BACKEND=livekit\n",
      );

      const run = await runUp(workspace, platform);

      expect(run.code).toBe(0);
      const stored = await workspace.storedConfig();
      expect(stored[KEY_VARIABLE]).not.toBe(undefined);
      expect(stored[SECRET_VARIABLE]).not.toBe(undefined);
      // Everything the carrier paperwork left behind survives the rewrite.
      expect(stored.EGMA_PHONE_SOURCE_NUMBER).toBe("+15550100100");
      expect(stored.EGMA_SIMULATOR_MEDIA_BACKEND).toBe("livekit");
      // And the operator is told, in sentences, because their media containers
      // are being replaced by this run — and because what those containers held
      // until this moment is a security fact they are entitled to hear plainly.
      expect(run.stderr).toContain("media-server credential was generated");
      expect(run.stderr).toContain("published in egma's own repository");
      expect(run.stderr).toContain("media containers are replaced by this start");
    } finally {
      await platform.close();
    }
  });

  it("keeps a pair the operator brought, and writes it down rather than replacing it", async () => {
    // `.env.example` names these two variables, so somebody exporting them
    // meant it — and a CLI that quietly minted its own over the top would be
    // ignoring a setting it told them to make. Recording it matters as much as
    // honouring it: a pair that lives only in one shell is one the next start
    // cannot find, and that start would mint a third and lock the deployment
    // out of itself.
    const platform = await startPlatform();
    const workspace = await makeWorkspace();
    try {
      const run = await runUp(workspace, platform, {
        [KEY_VARIABLE]: "a-key-the-operator-chose",
        [SECRET_VARIABLE]: "a-secret-the-operator-chose-that-is-long-enough",
      });

      expect(run.stdout).toContain("media_credential: existing");
      const stored = await workspace.storedConfig();
      expect(stored[KEY_VARIABLE]).toBe("a-key-the-operator-chose");
      expect(stored[SECRET_VARIABLE]).toBe("a-secret-the-operator-chose-that-is-long-enough");
    } finally {
      await platform.close();
    }
  });

  it("replaces half a pair, because half a credential authenticates nothing", async () => {
    const platform = await startPlatform();
    const workspace = await makeWorkspace();
    try {
      await mkdir(path.join(workspace.dir, ".egma-platform"), { recursive: true });
      await writeFile(
        path.join(workspace.dir, ".egma-platform", "platform.env"),
        `${KEY_VARIABLE}=a-key-with-no-secret\n`,
      );

      const run = await runUp(workspace, platform);

      expect(run.stdout).toContain("media_credential: generated");
      const stored = await workspace.storedConfig();
      expect(stored[KEY_VARIABLE]).not.toBe("a-key-with-no-secret");
      expect(stored[SECRET_VARIABLE] ?? "").not.toBe("");
    } finally {
      await platform.close();
    }
  });
});
