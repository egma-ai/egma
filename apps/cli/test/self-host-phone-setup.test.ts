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
import { existsSync } from "node:fs";
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
const SOURCE_NUMBER = "+15550100100";
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

    // And **no local state either**, which is the half the name of this check
    // used to claim without asserting. Planning reads provider state and
    // changes neither provider nor local state, so a plan leaves the workspace
    // exactly as it found it — no configuration, no receipt, not even the
    // directory those would live in.
    expect(existsSync(path.join(workspace.dir, ".egma-platform"))).toBe(false);
  });

  it("keeps its own directory private, whatever ran first", async () => {
    twilio = await startFakeTwilio({
      numbers: { [SOURCE_NUMBER]: NUMBER_SID },
      existingTrunk: EXISTING_TRUNK,
      existingCredentialList: EXISTING_LIST,
      credentialListAttached: true,
      numberAttached: true,
    });
    platform.makeReady();

    // The documented order, which is also the order that used to get this
    // wrong: a plan first, then an apply. `mkdir` applies its mode only when
    // it creates the directory, so whichever write happened to be first
    // decided the mode for good.
    await runSetup(workspace, twilio, platform, ["phone", "setup", "--plan"]);
    await runSetup(workspace, twilio, platform, ["phone", "setup", "--apply", "--yes"]);

    const platformDirectory = path.join(workspace.dir, ".egma-platform");
    expect((await stat(platformDirectory)).mode & 0o777).toBe(0o700);
    expect((await stat(path.join(platformDirectory, "receipts"))).mode & 0o777).toBe(
      0o700,
    );
    expect((await stat(path.join(platformDirectory, "platform.env"))).mode & 0o777).toBe(
      0o600,
    );
  });

  it("works in a workspace named with --cwd, in both spellings", async () => {
    twilio = await startFakeTwilio({
      numbers: { [SOURCE_NUMBER]: NUMBER_SID },
      existingTrunk: EXISTING_TRUNK,
      existingCredentialList: EXISTING_LIST,
      credentialListAttached: true,
      numberAttached: true,
    });

    // Run from somewhere that is not a platform workspace, naming one. This is
    // the escape hatch the refusal for being in the wrong directory offers, and
    // it did nothing in either spelling: the value of `--cwd X` was read as
    // part of the verb, and `--cwd=X` was not matched at all.
    const elsewhere = await mkdtemp(path.join(tmpdir(), "egma-elsewhere-"));

    for (const spelling of [
      ["--cwd", workspace.dir],
      [`--cwd=${workspace.dir}`],
    ]) {
      const run = await runSetup(
        { dir: elsewhere, binDir: workspace.binDir },
        twilio,
        platform,
        ["phone", "setup", "--plan", ...spelling],
      );

      expect(run.stdout, `with ${spelling.join(" ")}`).toContain("status: planned");
      expect(run.stdout).toContain(`workspace: ${workspace.dir}`);
      expect(run.code).toBe(0);
    }
  });

  it.each([
    {
      what: "a value that is really the next option",
      args: ["--plan", "--cwd", "--json"],
      // The quiet kind of wrong: `--json` is swallowed, and a script that
      // asked for one document gets plain lines with no complaint.
    },
    { what: "no value at all", args: ["--plan", "--cwd"] },
    { what: "an empty value", args: ["--plan", "--cwd="] },
  ])("refuses --cwd given $what", async ({ args }) => {
    twilio = await startFakeTwilio({ numbers: { [SOURCE_NUMBER]: NUMBER_SID } });

    const run = await runSetup(workspace, twilio, platform, ["phone", "setup", ...args]);

    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain("does not know the option --cwd");
    // Refused by name, like every other bad option — not quietly resolved
    // against whichever directory the command happened to be run in.
    expect(run.stdout).not.toContain("status: planned");
    expect(twilio.requests).toEqual([]);
  });

  it("names an option it does not know, and never its value", async () => {
    twilio = await startFakeTwilio({ numbers: { [SOURCE_NUMBER]: NUMBER_SID } });

    const run = await runSetup(workspace, twilio, platform, [
      "phone",
      "setup",
      "--plan",
      "--nonsense=something-private",
    ]);

    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain("does not know the option --nonsense");
    expect(run.stderr).not.toContain("something-private");
    expect(twilio.requests).toEqual([]);
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

    // Which key this configured the platform with, and where it was taken
    // from. Both matter because `OPENAI_API_KEY` is a variable most developers
    // already export: a run that reads one asks nothing and looks exactly like
    // a run that was told, and a stale exported key surfaces an hour later as
    // a provider refusing every turn.
    expect(answered["openai_key_from"]).toBe("OPENAI_API_KEY");
    expect(answered["openai_key_hint"]).toBe(`…${OPENAI_KEY.slice(-4)}`);
    // A hint names a key; it is not most of one.
    expect(String(answered["openai_key_hint"]).length).toBe(5);

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

  it("refuses to print an answer that carries a secret, rather than printing it", async () => {
    // The guard is not a review habit, so it is worth proving it fires. A
    // carrier that echoed the key back — in a trunk name, in a refusal, in
    // anything egma quotes — would otherwise put it in the plan, the terminal
    // and the receipt at once. Nothing quotes a provider today; the point is
    // that the day something does, this stops rather than leaks.
    twilio = await startFakeTwilio({
      numbers: { [SOURCE_NUMBER]: NUMBER_SID },
      existingTrunk: { sid: `TK${OPENAI_KEY}`, domain: EXISTING_TRUNK.domain },
      existingCredentialList: EXISTING_LIST,
      credentialListAttached: true,
      numberAttached: true,
    });

    const run = await runSetup(workspace, twilio, platform, ["phone", "setup", "--plan"]);

    expect(run.code).toBe(4);
    expect(`${run.stdout}\n${run.stderr}`).not.toContain(OPENAI_KEY);
    expect(run.stderr).toContain("refused to write");
    expect(run.stdout).toContain("changed: nothing");
    // A sentence, not a stack trace: a guard catching something is the
    // opposite of egma being broken, and it should not read like it.
    expect(run.stderr).not.toContain("Node.js v");
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

  it("refuses a secret argument in its own words, not the repository half's", async () => {
    twilio = await startFakeTwilio({ numbers: { [SOURCE_NUMBER]: NUMBER_SID } });

    // `--api-key` is refused by both halves of this CLI, and the repository
    // half's refusal talks about a Retell key and `egma connect`. Answering a
    // platform-workspace command with advice about a different product — at
    // the exact moment somebody is holding a credential — sends them to the
    // wrong place while what they typed is still in their history.
    const run = await runSetup(workspace, twilio, platform, [
      "phone",
      "setup",
      "--apply",
      "--yes",
      "--api-key=SENTINEL-wrong-place-4b6d",
    ]);

    expect(run.stderr).toContain("egma self-host phone setup");
    expect(run.stderr).not.toContain("egma connect");
    expect(run.stderr).not.toContain("EGMA_RETELL_API_KEY");
    expect(run.stderr).not.toContain("SENTINEL-wrong-place-4b6d");

    // And the advice is something a shell does not write to history. An inline
    // assignment is part of the command line, which is the very thing the
    // refusal's own stated reason is about.
    expect(run.stderr).not.toMatch(/TWILIO_AUTH_TOKEN=\S*\s+egma/u);
    expect(run.stderr).toContain('export TWILIO_AUTH_TOKEN="$(cat');
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
