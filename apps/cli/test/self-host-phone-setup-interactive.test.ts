/**
 * `egma self-host phone setup` with somebody at the keyboard.
 *
 * The headless modes are checked next door against the same Twilio-shaped
 * server. This file is about the half a headless run can never show: that the
 * questions are asked at all, that the two secrets are **not echoed** while they
 * are typed, that the plan is shown before anything is written to somebody's
 * carrier, and that declining writes nothing.
 *
 * Proving that needs a terminal, so this runs the real command in a real
 * pseudo-terminal and reads its real screen — the same arrangement the wizard's
 * scrollback promises are held to.
 */

import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startFakeTwilio, type FakeTwilio } from "./support/fake-twilio.ts";
import { runInTerminal, showing, type TerminalRun } from "./support/pty.ts";
import { CLI_ENTRY } from "./support/workspace.ts";

const ACCOUNT_SID = "AC00000000000000000000000000000001";
const SOURCE_NUMBER = "+15550100100";
const NUMBER_SID = "PN00000000000000000000000000000001";
const EXISTING_TRUNK = {
  sid: "TK00000000000000000000000000000001",
  domain: "egma-simulator-abc123.pstn.twilio.com",
};

/** Values nothing else holds, so finding one on the screen means one leaked. */
const AUTH_TOKEN = "SENTINELauthtoken0f1c8a2e4b6d";
const OPENAI_KEY = "skSENTINELopenaikey9a7c3e5f1b2d";

async function makeWorkspace(): Promise<{ dir: string; binDir: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "egma-platform-tty-"));
  await writeFile(path.join(dir, "docker-compose.yml"), "name: egma\nservices: {}\n");
  const binDir = path.join(dir, "bin");
  await mkdir(binDir, { recursive: true });
  const shim = path.join(binDir, "docker");
  await writeFile(shim, "#!/bin/sh\nexit 0\n");
  await chmod(shim, 0o755);
  return { dir, binDir };
}

/** A platform that never becomes phone-ready, so nothing waits on it here. */
async function startPlatform(): Promise<{ url: string; close(): Promise<void> }> {
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

describe("egma self-host phone setup, with somebody watching", () => {
  let twilio: FakeTwilio;
  let platform: Awaited<ReturnType<typeof startPlatform>>;
  let workspace: Awaited<ReturnType<typeof makeWorkspace>>;
  let terminal: TerminalRun | undefined;

  beforeEach(async () => {
    workspace = await makeWorkspace();
    platform = await startPlatform();
    twilio = await startFakeTwilio({
      numbers: { [SOURCE_NUMBER]: NUMBER_SID },
      existingTrunk: EXISTING_TRUNK,
      existingCredentialList: { sid: "CL00000000000000000000000000000001" },
      credentialListAttached: true,
      numberAttached: true,
    });
  });

  afterEach(async () => {
    await terminal?.kill();
    terminal = undefined;
    await twilio.close();
    await platform.close();
  });

  it("asks for each input, hides the two secrets, and writes nothing when declined", async () => {
    terminal = runInTerminal({
      command: process.execPath,
      args: [CLI_ENTRY, "self-host", "phone", "setup", "--apply"],
      cwd: workspace.dir,
      env: {
        ...process.env,
        PATH: `${workspace.binDir}:${process.env.PATH ?? ""}`,
        EGMA_TWILIO_API_ROOT: twilio.apiRoot,
        EGMA_TWILIO_TRUNKING_ROOT: twilio.trunkingRoot,
        EGMA_BASE_URL: platform.url,
        // Nothing pre-answered: every question is really asked.
        TWILIO_ACCOUNT_SID: "",
        TWILIO_AUTH_TOKEN: "",
        OPENAI_API_KEY: "",
        EGMA_PHONE_SOURCE_NUMBER: "",
      },
    });

    await showing(terminal, "Twilio Account SID");
    terminal.write(`${ACCOUNT_SID}\r`);

    // The number question says the thing a person most needs to know about it
    // before they answer, which is that egma will not go and buy one.
    await showing(terminal, "already owns", "egma never buys one");
    terminal.write(`${SOURCE_NUMBER}\r`);

    await showing(terminal, "Twilio Auth Token", "never kept");
    terminal.write(`${AUTH_TOKEN}\r`);

    await showing(terminal, "OpenAI API key");
    terminal.write(`${OPENAI_KEY}\r`);

    // The plan, before a single write. Every artifact named with its own
    // identifier, and the promise about buying restated where the decision is.
    await showing(
      terminal,
      `reuse the existing trunk egma-simulator (${EXISTING_TRUNK.sid})`,
      `${SOURCE_NUMBER} (${NUMBER_SID}) is already on the trunk`,
      "buys_a_number: no",
      "Apply this to your Twilio account?",
    );

    // Nothing has been written yet, and that is the point of showing a plan.
    expect(twilio.writes).toEqual([]);

    terminal.write("n\r");
    await showing(terminal, "status: not_approved", "changed: nothing");
    expect(twilio.writes).toEqual([]);

    // Neither secret was ever on the screen or in scrollback: they were read
    // with the terminal's echo off, so no shoulder and no screen recording has
    // them, and neither does the buffer a person scrolls back through.
    const everything = `${terminal.screen()}\n${terminal.scrollback()}\n${terminal.raw()}`;
    expect(everything).not.toContain(AUTH_TOKEN);
    expect(everything).not.toContain(OPENAI_KEY);

    // The two that are not secrets were echoed, which is right: an account
    // identifier is on Twilio's own dashboard and a source number is on every
    // caller's handset, and a person has to be able to see a typo.
    expect(everything).toContain(ACCOUNT_SID);
    expect(everything).toContain(SOURCE_NUMBER);

    expect(await terminal.exited).toBe(5);
  });

  it.each([
    // The first question of all, read through readline, which raises its own
    // AbortError; and a secret question, read through the raw reader, which
    // raises the stop directly. Two code paths, one sentence, one exit code.
    { at: "the first question", answerFirst: false, showing: "Twilio Account SID" },
    { at: "a secret question", answerFirst: true, showing: "Twilio Auth Token" },
  ])("stops with one sentence when Ctrl-C lands on $at", async ({ answerFirst, showing: prompt }) => {
    // The single most likely first-run interaction in the whole command is
    // "I do not have my token to hand", and it used to end in a Node stack
    // trace and `Node.js v24.16.0` — which reads as a bug in egma at the exact
    // moment somebody was being careful with a credential.
    terminal = runInTerminal({
      command: process.execPath,
      args: [CLI_ENTRY, "self-host", "phone", "setup", "--apply"],
      cwd: workspace.dir,
      env: {
        ...process.env,
        PATH: `${workspace.binDir}:${process.env.PATH ?? ""}`,
        EGMA_TWILIO_API_ROOT: twilio.apiRoot,
        EGMA_TWILIO_TRUNKING_ROOT: twilio.trunkingRoot,
        EGMA_BASE_URL: platform.url,
        TWILIO_ACCOUNT_SID: "",
        TWILIO_AUTH_TOKEN: "",
        OPENAI_API_KEY: "",
        EGMA_PHONE_SOURCE_NUMBER: "",
      },
    });

    if (answerFirst) {
      await showing(terminal, "Twilio Account SID");
      terminal.write(`${ACCOUNT_SID}\r`);
      await showing(terminal, "already owns");
      terminal.write(`${SOURCE_NUMBER}\r`);
    }
    await showing(terminal, prompt);

    // Ctrl-C, which at a secret prompt is a byte rather than a signal.
    terminal.write("\u0003");

    await showing(terminal, "Stopped. Nothing was written");
    const everything = `${terminal.screen()}\n${terminal.scrollback()}`;
    expect(everything).not.toContain("Node.js v");
    expect(everything).not.toContain("at ReadStream");

    // 130 is what a shell means by "stopped part way", and every other verb in
    // this CLI already answers with it.
    expect(await terminal.exited).toBe(130);
    expect(twilio.writes).toEqual([]);
  });
});
