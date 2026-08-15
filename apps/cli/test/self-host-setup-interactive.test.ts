/**
 * `egma self-host setup` with somebody at the keyboard.
 *
 * The headless modes are checked next door against the same two stand-ins. This
 * file is about the half a headless run can never show: that the questions are
 * really asked, **in the order the platform lists its settings**, that a
 * suggestion is a default a person can see and take, that no key is echoed while
 * it is typed, that the carrier plan is shown before anything is written to
 * somebody's paid account, and that declining writes nothing at all.
 *
 * Proving that needs a terminal, so this runs the real command in a real
 * pseudo-terminal and reads its real screen — the same arrangement the wizard's
 * scrollback promises are held to.
 */

import { existsSync } from "node:fs";
import path from "node:path";

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

const ACCOUNT_SID = "AC00000000000000000000000000000001";
const SOURCE_NUMBER = "+15550100100";
const NUMBER_SID = "PN00000000000000000000000000000001";
const EXISTING_TRUNK = {
  sid: "TK00000000000000000000000000000001",
  domain: "egma-simulator-abc123.pstn.twilio.com",
};

/** Values nothing else holds, so finding one on the screen means one leaked. */
const AUTH_TOKEN = "SENTINELauthtoken0f1c8a2e4b6d";
const MODEL_KEY = "skSENTINELmodelkey9a7c3e5f1b2d";
const LISTENING_KEY = "skSENTINELlisteningkey5f1b2d4a";
const SPEAKING_KEY = "skSENTINELspeakingkey7c3e5f1b2";

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

  function start(): TerminalRun {
    return runInTerminal({
      command: process.execPath,
      args: [CLI_ENTRY, "self-host", "setup", "--apply"],
      cwd: workspace.dir,
      env: {
        ...process.env,
        PATH: `${workspace.binDir}:${process.env.PATH ?? ""}`,
        EGMA_HOME: workspace.egmaHome,
        EGMA_TWILIO_API_ROOT: twilio.apiRoot,
        EGMA_TWILIO_TRUNKING_ROOT: twilio.trunkingRoot,
        EGMA_BASE_URL: platform.url,
        // Nothing pre-answered: every question is really asked.
        EGMA_PERSONA_MODEL_PROVIDER: "",
        EGMA_PERSONA_MODEL: "",
        EGMA_PERSONA_MODEL_API_KEY: "",
        EGMA_PERSONA_STT_PROVIDER: "",
        EGMA_PERSONA_STT_API_KEY: "",
        EGMA_PERSONA_TTS_PROVIDER: "",
        EGMA_PERSONA_TTS_API_KEY: "",
        EGMA_PERSONA_TTS_MODEL: "",
        EGMA_PERSONA_TTS_VOICE: "",
        EGMA_PERSONA_VAD_PROVIDER: "",
        EGMA_MEDIA_BACKEND: "",
        TWILIO_ACCOUNT_SID: "",
        TWILIO_AUTH_TOKEN: "",
        EGMA_PHONE_SOURCE_NUMBER: "",
      },
    });
  }

  it("asks for every setting in turn, hides the keys, and writes nothing when declined", async () => {
    terminal = start();

    // The order is the platform's own: who the persona thinks with, then what
    // it speaks and hears with, then how a call reaches the telephone network —
    // so an operator gathers one provider's paperwork at a time rather than
    // jumping between accounts.
    await showing(terminal, "the persona's model provider [openai]");
    terminal.write("\r");
    await showing(terminal, "the persona's model [gpt-4o]");
    terminal.write("\r");
    await showing(terminal, "the persona's model key (not shown as you type)");
    terminal.write(`${MODEL_KEY}\r`);

    await showing(terminal, "the speech-to-text provider [openai]");
    terminal.write("\r");
    await showing(terminal, "the speech-to-text key");
    terminal.write(`${LISTENING_KEY}\r`);

    await showing(terminal, "the text-to-speech provider [openai]");
    terminal.write("\r");
    await showing(terminal, "the text-to-speech key");
    terminal.write(`${SPEAKING_KEY}\r`);

    // The two the simulator has a working default for are offered with no
    // suggestion of egma's own, because a model name invented here would be a
    // second opinion about a provider's catalogue, stored, and wrong the week
    // one is retired. An empty answer leaves the platform holding neither.
    await showing(terminal, "the text-to-speech model");
    terminal.write("\r");
    await showing(terminal, "the text-to-speech voice");
    terminal.write("\r");

    await showing(terminal, "the voice-activity provider [silero]");
    terminal.write("\r");
    await showing(terminal, "the media backend [livekit]");
    terminal.write("\r");

    // The carrier, which is the one half that is not typed into the platform:
    // a trunk hostname and a SIP credential are what the paperwork produces.
    await showing(terminal, "Twilio Account SID");
    terminal.write(`${ACCOUNT_SID}\r`);
    // The number question says the thing a person most needs to know about it
    // before they answer, which is that egma will not go and buy one.
    await showing(terminal, "already owns", "egma never buys one");
    terminal.write(`${SOURCE_NUMBER}\r`);
    await showing(terminal, "Twilio Auth Token", "never kept");
    terminal.write(`${AUTH_TOKEN}\r`);

    // The plan, before a single write. Every artifact named with its own
    // identifier, and the promise about buying restated where the decision is.
    await showing(
      terminal,
      `reuse the existing trunk egma-simulator (${EXISTING_TRUNK.sid})`,
      `${SOURCE_NUMBER} (${NUMBER_SID}) is already on the trunk`,
      "buys_a_number: no",
      "Apply this to your Twilio account?",
    );

    // Nothing has been written yet — not at the carrier and not at the
    // platform. Every question comes before any write, which is what makes
    // declining leave both of them exactly as they were.
    expect(twilio.writes).toEqual([]);
    expect(platform.written).toEqual([]);

    terminal.write("n\r");
    await showing(terminal, "status: not_approved", "changed: nothing");
    expect(twilio.writes).toEqual([]);
    expect(platform.written).toEqual([]);
    expect(platform.held()).toEqual({});
    // And nothing locally either — not a bootstrap file, not a receipt, not
    // even the directory those would live in. "changed: nothing" is a claim
    // about three places, so it is checked in all three.
    expect(existsSync(path.join(workspace.dir, ".egma-platform"))).toBe(false);

    // No key was ever on the screen or in scrollback: they were read with the
    // terminal's echo off, so no shoulder and no screen recording has them, and
    // neither does the buffer a person scrolls back through.
    const everything = `${terminal.screen()}\n${terminal.scrollback()}\n${terminal.raw()}`;
    for (const secret of [AUTH_TOKEN, MODEL_KEY, LISTENING_KEY, SPEAKING_KEY]) {
      expect(everything).not.toContain(secret);
    }

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
    {
      at: "the first question",
      answerFirst: false,
      showing: "the persona's model provider",
    },
    {
      at: "a secret question",
      answerFirst: true,
      showing: "the persona's model key",
    },
  ])(
    "stops with one sentence when Ctrl-C lands on $at",
    async ({ answerFirst, showing: prompt }) => {
      // The single most likely first-run interaction in the whole command is
      // "I do not have my key to hand", and it used to end in a Node stack
      // trace and `Node.js v24.16.0` — which reads as a bug in egma at the exact
      // moment somebody was being careful with a credential.
      terminal = start();

      if (answerFirst) {
        await showing(terminal, "the persona's model provider [openai]");
        terminal.write("\r");
        await showing(terminal, "the persona's model [gpt-4o]");
        terminal.write("\r");
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
      expect(platform.written).toEqual([]);
    },
  );
});
