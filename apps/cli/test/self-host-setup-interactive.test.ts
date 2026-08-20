/**
 * `egma self-host setup` with somebody at the keyboard.
 *
 * The interview owns one thing: a complete carrier route. These checks use a
 * real pseudo-terminal to prove that a SIP password is hidden, Ctrl-C writes
 * nothing, and setup never contacts the carrier account.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startFakeTwilio, type FakeTwilio } from "./support/fake-twilio.ts";
import {
  makePlatformWorkspace,
  startPlatform,
  type FakePlatform,
  type PlatformWorkspace,
} from "./support/platform-workspace.ts";
import { runInTerminal, showing, type TerminalRun } from "./support/pty.ts";
import { CLI_ENTRY } from "./support/workspace.ts";

const SOURCE_NUMBER = "+15550100100";
const EXISTING_TRUNK = "egma-simulator-abc123.pstn.twilio.com";
const SIP_USERNAME = "egma-nischal";
const SIP_PASSWORD = "SENTINELsipPassword1a2b3c4d";

describe("egma self-host setup, with somebody watching", () => {
  let twilio: FakeTwilio;
  let platform: FakePlatform;
  let workspace: PlatformWorkspace;
  let terminal: TerminalRun | undefined;

  beforeEach(async () => {
    workspace = await makePlatformWorkspace("egma-platform-tty-");
    platform = await startPlatform();
    await workspace.signIn(platform);
    twilio = await startFakeTwilio({
      numbers: { [SOURCE_NUMBER]: "PN00000000000000000000000000000001" },
      existingTrunk: {
        sid: "TK00000000000000000000000000000001",
        domain: EXISTING_TRUNK,
      },
      existingCredentialList: { sid: "CL00000000000000000000000000000001" },
      existingCredential: {
        sid: "CR00000000000000000000000000000001",
        username: "egma-production",
      },
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

  function start(): TerminalRun {
    return runInTerminal({
      command: process.execPath,
      args: [CLI_ENTRY, "self-host", "setup", "--apply"],
      cwd: workspace.dir,
      env: {
        ...process.env,
        PATH: `${workspace.binDir}:${process.env.PATH ?? ""}`,
        EGMA_HOME: workspace.egmaHome,
        EGMA_BASE_URL: platform.url,
        EGMA_PHONE_TRUNK_ADDRESS: "",
        EGMA_PHONE_SOURCE_NUMBER: "",
        EGMA_PHONE_TRUNK_USERNAME: "",
        EGMA_PHONE_TRUNK_PASSWORD: "",
        TWILIO_ACCOUNT_SID: "",
        TWILIO_AUTH_TOKEN: "",
      },
    });
  }

  it("writes one credential carrier route without exposing its password", async () => {
    terminal = start();

    await showing(terminal, "SIP trunk address");
    terminal.write(`${EXISTING_TRUNK}\r`);
    await showing(terminal, "Source phone number, in E.164");
    terminal.write(`${SOURCE_NUMBER}\r`);
    await showing(terminal, "SIP username");
    terminal.write(`${SIP_USERNAME}\r`);
    await showing(terminal, "SIP password", "not shown as you type");
    terminal.write(`${SIP_PASSWORD}\r`);

    await showing(terminal, "status: ready");

    expect(platform.held()).toMatchObject({
      carrier_trunk_address: EXISTING_TRUNK,
      carrier_trunk_number: SOURCE_NUMBER,
      carrier_trunk_username: SIP_USERNAME,
      carrier_trunk_password: SIP_PASSWORD,
    });
    expect(twilio.requests).toEqual([]);
    expect(twilio.writes).toEqual([]);
    expect(twilio.passwords).toEqual([]);

    const everything = `${terminal.screen()}\n${terminal.scrollback()}\n${terminal.raw()}`;
    expect(everything).not.toContain(SIP_PASSWORD);
    expect(everything).toContain(EXISTING_TRUNK);
    expect(everything).toContain(SOURCE_NUMBER);
    expect(everything).toContain(SIP_USERNAME);
    expect(everything).not.toContain("Twilio Account SID");
    expect(everything).not.toContain("Twilio Auth Token");
    expect(await terminal.exited).toBe(0);
  });

  it("accepts a source-IP route without asking for a SIP password", async () => {
    terminal = start();

    await showing(terminal, "SIP trunk address");
    terminal.write("source-ip.example.com\r");
    await showing(terminal, "Source phone number, in E.164");
    terminal.write(`${SOURCE_NUMBER}\r`);
    await showing(terminal, "SIP username", "Enter for source-IP authentication");
    terminal.write("\r");
    await showing(terminal, "status: ready");

    const everything = `${terminal.screen()}\n${terminal.scrollback()}\n${terminal.raw()}`;
    expect(everything).not.toContain("SIP password");
    expect(platform.held()).toMatchObject({
      carrier_trunk_address: "source-ip.example.com",
      carrier_trunk_number: SOURCE_NUMBER,
    });
    expect(platform.held()).not.toHaveProperty("carrier_trunk_username");
    expect(platform.held()).not.toHaveProperty("carrier_trunk_password");
    expect(twilio.requests).toEqual([]);
    expect(await terminal.exited).toBe(0);
  });

  it.each([
    { at: "the first question", secret: false },
    { at: "the secret question", secret: true },
  ])("stops cleanly when Ctrl-C lands on $at", async ({ secret }) => {
    terminal = start();

    if (secret) {
      await showing(terminal, "SIP trunk address");
      terminal.write(`${EXISTING_TRUNK}\r`);
      await showing(terminal, "Source phone number, in E.164");
      terminal.write(`${SOURCE_NUMBER}\r`);
      await showing(terminal, "SIP username");
      terminal.write(`${SIP_USERNAME}\r`);
      await showing(terminal, "SIP password");
    } else {
      await showing(terminal, "SIP trunk address");
    }

    terminal.write("\u0003");

    await showing(terminal, "Stopped. Nothing was written");
    const everything = `${terminal.screen()}\n${terminal.scrollback()}`;
    expect(everything).not.toContain("Node.js v");
    expect(everything).not.toContain("at ReadStream");
    expect(await terminal.exited).toBe(130);
    expect(twilio.requests).toEqual([]);
    expect(twilio.writes).toEqual([]);
    expect(twilio.passwords).toEqual([]);
    expect(platform.written).toEqual([]);
  });
});
