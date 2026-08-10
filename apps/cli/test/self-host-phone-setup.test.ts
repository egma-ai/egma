/**
 * `egma self-host phone setup`, against a Twilio-shaped local server.
 *
 * The real CLI process, the real command modules and the real HTTP client —
 * only the carrier and the container runtime stand in, because a suite that
 * bought SIP trunks would cost money and a suite that started Docker would take
 * minutes. The provider-backed acceptance is a separate, deliberate act; this
 * is the regression net under it.
 *
 * What is worth proving here, in order of how much it would cost to get wrong:
 *
 * 1. **A second run creates nothing.** Setup runs against an account that
 *    already has the trunk, the credential list and the attachments a previous
 *    run left, which is the state every real re-run meets. Proved against the
 *    carrier's own record of writes rather than against what the command said
 *    about itself.
 * 2. **A plan writes nothing, anywhere.**
 * 3. **No supplied secret reaches the terminal, the JSON, the receipt or the
 *    configuration egma writes.** Sentinel values, swept for by hand.
 * 4. **The Auth Token is never kept**, which is the difference between setup
 *    authority and runtime authority.
 * 5. **It never buys a number**, and says so when the account does not hold one.
 */

import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startFakeTwilio, type FakeTwilio } from "./support/fake-twilio.ts";
import { CLI_ENTRY } from "./support/workspace.ts";

/**
 * Values nothing else in this repository holds, so a sweep that finds one has
 * found this test's own input and not a coincidence.
 */
const AUTH_TOKEN = "SENTINEL-twilio-auth-token-0f1c8a2e4b6d";
const OPENAI_KEY = "sk-SENTINEL-openai-key-9a7c3e5f1b2d4680";
const ACCOUNT_SID = "AC00000000000000000000000000000001";
const SOURCE_NUMBER = "+18884174625";
const NUMBER_SID = "PN00000000000000000000000000000001";

const EXISTING_TRUNK = { sid: "TK00000000000000000000000000000001", domain: "egma-simulator-abc123.pstn.twilio.com" };
const EXISTING_LIST = { sid: "CL00000000000000000000000000000001" };

type Platform = {
  readonly url: string;
  /** Turn phone readiness on, as recreating the API with configuration would. */
  makeReady(): void;
  close(): Promise<void>;
};

/** A stand-in for the running platform, answering only what setup reads. */
async function startPlatform(): Promise<Platform> {
  let ready = false;
  const server: Server = createServer((_request, answer) => {
    answer.writeHead(200, { "content-type": "application/json" });
    answer.end(
      JSON.stringify({
        instance_id: "pf_00000000000000000000000001",
        origin: (server.address() as AddressInfo | null) === null ? "" : url,
        phone: ready
          ? { state: "ready", missing: [] }
          : { state: "setup_required", missing: ["the carrier trunk"] },
      }),
    );
  });
  await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;
  return {
    url,
    makeReady: () => {
      ready = true;
    },
    close: () =>
      new Promise<void>((closed) => {
        server.close(() => closed());
      }),
  };
}

/**
 * A workspace that looks like a platform workspace, with a `docker` on its PATH
 * that succeeds and writes down what it was asked for.
 *
 * Standing in for the container runtime rather than for egma: everything the
 * command does above `docker compose` is the real thing.
 */
async function makeWorkspace(): Promise<{
  readonly dir: string;
  readonly binDir: string;
  dockerCalls(): Promise<string>;
}> {
  const dir = await mkdtemp(path.join(tmpdir(), "egma-platform-"));
  await writeFile(path.join(dir, "docker-compose.yml"), "name: egma\nservices: {}\n");
  const binDir = path.join(dir, "bin");
  await writeFile(path.join(dir, "docker-calls.txt"), "");
  const { mkdir, chmod } = await import("node:fs/promises");
  await mkdir(binDir, { recursive: true });
  const shim = path.join(binDir, "docker");
  await writeFile(
    shim,
    `#!/bin/sh\necho "$@" >> "${path.join(dir, "docker-calls.txt")}"\nexit 0\n`,
  );
  await chmod(shim, 0o755);
  return {
    dir,
    binDir,
    dockerCalls: () => readFile(path.join(dir, "docker-calls.txt"), "utf8"),
  };
}

type Run = { readonly code: number; readonly stdout: string; readonly stderr: string };

async function runSetup(
  workspace: { readonly dir: string; readonly binDir: string },
  twilio: FakeTwilio,
  platform: Platform,
  args: readonly string[],
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_ENTRY, "self-host", ...args], {
      cwd: workspace.dir,
      env: {
        ...process.env,
        PATH: `${workspace.binDir}:${process.env.PATH ?? ""}`,
        TWILIO_ACCOUNT_SID: ACCOUNT_SID,
        TWILIO_AUTH_TOKEN: AUTH_TOKEN,
        OPENAI_API_KEY: OPENAI_KEY,
        EGMA_PHONE_SOURCE_NUMBER: SOURCE_NUMBER,
        EGMA_TWILIO_API_ROOT: twilio.apiRoot,
        EGMA_TWILIO_TRUNKING_ROOT: twilio.trunkingRoot,
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

/** Everything the command left behind in the workspace, as one string. */
async function everythingWritten(dir: string): Promise<string> {
  const platformDirectory = path.join(dir, ".egma-platform");
  let written = "";
  const walk = async (at: string): Promise<void> => {
    for (const entry of await readdir(at, { withFileTypes: true })) {
      const here = path.join(at, entry.name);
      if (entry.isDirectory()) await walk(here);
      else written += `\n--- ${here} ---\n${await readFile(here, "utf8")}`;
    }
  };
  try {
    await walk(platformDirectory);
  } catch {
    return "";
  }
  return written;
}

describe("egma self-host phone setup", () => {
  let twilio: FakeTwilio;
  let platform: Platform;
  let workspace: Awaited<ReturnType<typeof makeWorkspace>>;

  beforeEach(async () => {
    workspace = await makeWorkspace();
    platform = await startPlatform();
  });

  afterEach(async () => {
    await twilio?.close();
    await platform.close();
  });

  it("plans against an account that already has everything, and writes nothing", async () => {
    twilio = await startFakeTwilio({
      numbers: { [SOURCE_NUMBER]: NUMBER_SID },
      existingTrunk: EXISTING_TRUNK,
      existingCredentialList: EXISTING_LIST,
      credentialListAttached: true,
      numberAttached: true,
    });

    const run = await runSetup(workspace, twilio, platform, ["phone", "setup", "--plan"]);

    expect(run.code).toBe(0);
    expect(run.stdout).toContain("status: planned");
    expect(run.stdout).toContain("changed: nothing");
    // Reuse, said about every one of the four artifacts.
    expect(run.stdout).toContain(`reuse the existing trunk egma-simulator (${EXISTING_TRUNK.sid})`);
    expect(run.stdout).toContain("the credential list is already on the trunk");
    expect(run.stdout).toContain(`${SOURCE_NUMBER} (${NUMBER_SID}) is already on the trunk`);
    expect(run.stdout).toContain("buys_a_number: no");

    // The carrier's own record: a plan is reads and nothing else.
    expect(twilio.writes).toEqual([]);
    expect(twilio.requests.every((one) => one.startsWith("GET"))).toBe(true);
  });

  it("applies against a fresh account, then a second run creates nothing", async () => {
    twilio = await startFakeTwilio({ numbers: { [SOURCE_NUMBER]: NUMBER_SID } });
    platform.makeReady();

    const first = await runSetup(workspace, twilio, platform, [
      "phone",
      "setup",
      "--apply",
      "--yes",
    ]);
    expect(first.code).toBe(0);
    expect(first.stdout).toContain("status: ready");
    expect(twilio.trunks).toHaveLength(1);
    expect(twilio.credentialLists).toHaveLength(1);

    const writesAfterFirst = [...twilio.writes];
    const trunkAfterFirst = twilio.trunks[0];

    const second = await runSetup(workspace, twilio, platform, [
      "phone",
      "setup",
      "--apply",
      "--yes",
    ]);
    expect(second.code).toBe(0);

    // The whole point. One trunk, one credential list, one attachment of each —
    // proved against the carrier rather than against what the command said.
    expect(twilio.trunks).toHaveLength(1);
    expect(twilio.trunks[0]).toEqual(trunkAfterFirst);
    expect(twilio.credentialLists).toHaveLength(1);

    const newWrites = twilio.writes.slice(writesAfterFirst.length);
    const created = newWrites.filter((one) => !one.includes("/Credentials/"));
    expect(created).toEqual([]);

    // The one thing a re-run cannot reuse: Twilio shows a password once, so a
    // second run mints another and tells the carrier. Two runs, two passwords,
    // and never the same one twice.
    expect(twilio.passwords).toHaveLength(2);
    expect(new Set(twilio.passwords).size).toBe(2);

    expect(second.stdout).toContain("did: reuse reused trunk");
    expect(second.stdout).toContain("was already on the trunk");
  });

  it("recovers from a setup that stopped half way", async () => {
    // The trunk and the list exist; nothing was attached. That is exactly what
    // a run interrupted between its third and fourth step leaves behind.
    twilio = await startFakeTwilio({
      numbers: { [SOURCE_NUMBER]: NUMBER_SID },
      existingTrunk: EXISTING_TRUNK,
      existingCredentialList: EXISTING_LIST,
      credentialListAttached: false,
      numberAttached: false,
    });
    platform.makeReady();

    const run = await runSetup(workspace, twilio, platform, [
      "phone",
      "setup",
      "--apply",
      "--yes",
    ]);

    expect(run.code).toBe(0);
    expect(twilio.trunks).toHaveLength(1);
    expect(twilio.credentialLists).toHaveLength(1);
    expect(twilio.writes).toContain(`POST /v1/Trunks/${EXISTING_TRUNK.sid}/CredentialLists`);
    expect(twilio.writes).toContain(`POST /v1/Trunks/${EXISTING_TRUNK.sid}/PhoneNumbers`);
    expect(twilio.writes.filter((one) => one === "POST /v1/Trunks")).toEqual([]);
  });

  it("reveals no supplied secret in its output, its receipt or its configuration", async () => {
    twilio = await startFakeTwilio({
      numbers: { [SOURCE_NUMBER]: NUMBER_SID },
      existingTrunk: EXISTING_TRUNK,
      existingCredentialList: EXISTING_LIST,
      credentialListAttached: true,
      numberAttached: true,
    });
    platform.makeReady();

    const run = await runSetup(workspace, twilio, platform, [
      "phone",
      "setup",
      "--apply",
      "--yes",
      "--json",
    ]);
    expect(run.code).toBe(0);

    // Exactly one document on standard output, and nothing else — a coding
    // agent driving this parses the whole answer rather than picking a
    // document out of a stream of lines. Anything conversational is on
    // standard error, where it cannot break a parse.
    const answered = JSON.parse(run.stdout) as Record<string, unknown>;
    expect(answered["status"]).toBe("ready");
    expect(answered["buys_a_number"]).toBe(false);
    expect(answered["trunk_sid"]).toBe(EXISTING_TRUNK.sid);
    expect(answered["receipt"]).toMatch(/^\.egma-platform\/receipts\//u);

    const said = `${run.stdout}\n${run.stderr}`;
    expect(said).not.toContain(AUTH_TOKEN);
    expect(said).not.toContain(OPENAI_KEY);

    const written = await everythingWritten(workspace.dir);

    // The Auth Token is a setup-time credential and is kept nowhere at all —
    // not in the receipt, and not in the configuration the platform runs on.
    expect(written).not.toContain(AUTH_TOKEN);

    // A receipt is a document people commit and paste into issues, so no
    // secret reaches one — including the SIP password egma minted, which is
    // named as existing and never written down.
    const receipts = await readdir(path.join(workspace.dir, ".egma-platform", "receipts"));
    expect(receipts).toHaveLength(1);
    const receipt = await readFile(
      path.join(workspace.dir, ".egma-platform", "receipts", receipts[0] as string),
      "utf8",
    );
    expect(receipt).not.toContain(AUTH_TOKEN);
    expect(receipt).not.toContain(OPENAI_KEY);
    expect(receipt).toContain("minted, not recorded");
    expect(receipt).toContain(EXISTING_TRUNK.sid);
    for (const password of twilio.passwords) expect(receipt).not.toContain(password);

    // The provider key does reach the configuration, because the simulator
    // speaks with it — and that file is created readable by its owner alone.
    const configuration = path.join(workspace.dir, ".egma-platform", "platform.env");
    expect(await readFile(configuration, "utf8")).toContain(OPENAI_KEY);
    expect((await stat(configuration)).mode & 0o777).toBe(0o600);
  });

  it("refuses a secret offered as a command argument, before it does anything", async () => {
    twilio = await startFakeTwilio({ numbers: { [SOURCE_NUMBER]: NUMBER_SID } });

    const run = await runSetup(workspace, twilio, platform, [
      "phone",
      "setup",
      "--apply",
      "--yes",
      "--auth-token",
      AUTH_TOKEN,
    ]);

    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain("will not take a secret in --auth-token");
    // Said back by name only. The value is never repeated.
    expect(run.stderr).not.toContain(AUTH_TOKEN);
    expect(twilio.requests).toEqual([]);
  });

  it("never buys a number, and says so when the account holds none", async () => {
    twilio = await startFakeTwilio({ numbers: {} });

    const run = await runSetup(workspace, twilio, platform, [
      "phone",
      "setup",
      "--apply",
      "--yes",
    ]);

    expect(run.code).toBe(4);
    expect(run.stdout).toContain("holds no number");
    expect(run.stdout).toContain("egma never buys, ports or registers one");
    // Nothing was created on the way to finding out.
    expect(twilio.writes).toEqual([]);
  });

  it("refuses outside a platform workspace, and names the difference", async () => {
    twilio = await startFakeTwilio({ numbers: { [SOURCE_NUMBER]: NUMBER_SID } });
    const notAWorkspace = await mkdtemp(path.join(tmpdir(), "egma-not-platform-"));

    const run = await runSetup(
      { dir: notAWorkspace, binDir: workspace.binDir },
      twilio,
      platform,
      ["phone", "setup", "--plan"],
    );

    expect(run.code).toBe(1);
    expect(run.stderr).toContain("this is not a platform workspace");
    expect(run.stderr).toContain("not your agent repository");
    expect(twilio.requests).toEqual([]);
  });
});
