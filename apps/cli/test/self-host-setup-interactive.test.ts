/**
 * `egma self-host setup` with somebody at the keyboard.
 *
 * The headless modes are checked next door against the same two stand-ins. This
 * file is about the half a headless run can never show: that the questions are
 * really asked, **in the order the platform lists its settings**, that a
 * suggestion is a default a person can see and take, that no key is echoed while
 * it is typed, and that setup asks for one complete runtime phone route without
 * ever asking for or contacting a Twilio account.
 *
 * Proving that needs a terminal, so this runs the real command in a real
 * pseudo-terminal and reads its real screen — the same arrangement the wizard's
 * scrollback promises are held to.
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
const NUMBER_SID = "PN00000000000000000000000000000001";
const EXISTING_TRUNK = {
  sid: "TK00000000000000000000000000000001",
  domain: "egma-simulator-abc123.pstn.twilio.com",
};
const SIP_USERNAME = "egma-nischal";
const SIP_PASSWORD = "SENTINELsipPassword1a2b3c4d";

/** Values nothing else holds, so finding one on the screen means one leaked. */
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
        EGMA_TWILIO_API_ROOT: twilio.apiRoot,
        EGMA_TWILIO_TRUNKING_ROOT: twilio.trunkingRoot,
        EGMA_BASE_URL: platform.url,
        // Nothing pre-answered: every question is really asked.
        EGMA_PERSONA_MODEL_PROVIDER: "",
        EGMA_PERSONA_MODEL: "",
        EGMA_PERSONA_MODEL_API_KEY: "",
        EGMA_PERSONA_MODEL_REASONING_EFFORT: "",
        EGMA_PERSONA_STT_PROVIDER: "",
        EGMA_PERSONA_STT_API_KEY: "",
        EGMA_PERSONA_STT_MODEL: "",
        EGMA_PERSONA_TTS_PROVIDER: "",
        EGMA_PERSONA_TTS_API_KEY: "",
        EGMA_PERSONA_TTS_MODEL: "",
        EGMA_PERSONA_TTS_VOICE: "",
        EGMA_PERSONA_VAD_PROVIDER: "",
        EGMA_MEDIA_BACKEND: "",
        EGMA_PHONE_TRUNK_ADDRESS: "",
        EGMA_PHONE_SOURCE_NUMBER: "",
        EGMA_PHONE_TRUNK_USERNAME: "",
        EGMA_PHONE_TRUNK_PASSWORD: "",
        // These are empty tripwires. Normal setup does not ask for them.
        TWILIO_ACCOUNT_SID: "",
        TWILIO_AUTH_TOKEN: "",
      },
    });
  }

  it("asks for four runtime phone values, hides the secrets, and never contacts Twilio", async () => {
    terminal = start();

    // The order is the platform's own: who the persona thinks with, then what
    // it speaks and hears with, then how a call reaches the telephone network —
    // so an operator gathers one provider's paperwork at a time rather than
    // jumping between accounts.
    await showing(terminal, "the persona's model provider [openai]");
    terminal.write("\r");
    await showing(terminal, "the persona's model [gpt-5.6-terra]");
    terminal.write("\r");
    await showing(terminal, "the persona's model key (not shown as you type)");
    terminal.write(`${MODEL_KEY}\r`);
    // The one model setting egma does suggest a value for, because it is a
    // behavior rather than a provider's model name: a caller on a live line
    // does not pause to reason, so the suggestion turns it off.
    await showing(terminal, "the persona's reasoning effort [none]");
    terminal.write("\r");

    // The listening leg's suggestion is the streaming transport, not the
    // segmented one: a leg that cannot start transcribing until the agent
    // stops talking adds the whole length of every agent turn to that turn.
    await showing(terminal, "the speech-to-text provider [openai_realtime]");
    terminal.write("\r");
    await showing(terminal, "the speech-to-text key");
    terminal.write(`${LISTENING_KEY}\r`);
    // The three model-and-voice names are offered with no suggestion of egma's
    // own, because a name invented here would be a second opinion about a
    // provider's catalogue, stored, and wrong the week one is retired. An
    // empty answer leaves the platform holding none of them, and each built
    // leg then answers with its own provider's default.
    await showing(terminal, "the speech-to-text model");
    terminal.write("\r");

    await showing(terminal, "the text-to-speech provider [cartesia]");
    terminal.write("\r");
    await showing(terminal, "the text-to-speech key");
    terminal.write(`${SPEAKING_KEY}\r`);
    await showing(terminal, "the text-to-speech model");
    terminal.write("\r");
    await showing(terminal, "the text-to-speech voice");
    terminal.write("\r");

    await showing(terminal, "the voice-activity provider [silero]");
    terminal.write("\r");
    await showing(terminal, "the media backend [livekit]");
    terminal.write("\r");

    // These are runtime values made once by the Twilio administrator. Each
    // developer has their own SIP username/password on the shared trunk.
    await showing(terminal, "SIP trunk address");
    terminal.write(`${EXISTING_TRUNK.domain}\r`);
    await showing(terminal, "Source phone number, in E.164");
    terminal.write(`${SOURCE_NUMBER}\r`);
    await showing(terminal, "SIP username");
    terminal.write(`${SIP_USERNAME}\r`);
    await showing(terminal, "SIP password", "not shown as you type");
    terminal.write(`${SIP_PASSWORD}\r`);

    await showing(terminal, "status: ready");

    // The only write is to the platform. Even a populated Twilio account is
    // never read, so ordinary setup cannot change somebody else's password.
    expect(platform.held()).toMatchObject({
      carrier_trunk_address: EXISTING_TRUNK.domain,
      carrier_trunk_number: SOURCE_NUMBER,
      carrier_trunk_username: SIP_USERNAME,
      carrier_trunk_password: SIP_PASSWORD,
    });
    expect(twilio.requests).toEqual([]);
    expect(twilio.writes).toEqual([]);
    expect(twilio.passwords).toEqual([]);

    // No key was ever on the screen or in scrollback: they were read with the
    // terminal's echo off, so no shoulder and no screen recording has them, and
    // neither does the buffer a person scrolls back through.
    const everything = `${terminal.screen()}\n${terminal.scrollback()}\n${terminal.raw()}`;
    for (const secret of [MODEL_KEY, LISTENING_KEY, SPEAKING_KEY, SIP_PASSWORD]) {
      expect(everything).not.toContain(secret);
    }

    // The three non-secret runtime values are echoed so a typo is visible.
    expect(everything).toContain(EXISTING_TRUNK.domain);
    expect(everything).toContain(SOURCE_NUMBER);
    expect(everything).toContain(SIP_USERNAME);
    expect(everything).not.toContain("Twilio Account SID");
    expect(everything).not.toContain("Twilio Auth Token");
    expect(everything).not.toContain("Apply this to your Twilio account?");

    expect(await terminal.exited).toBe(0);
  });

  it("accepts a source-IP route without asking for a SIP password", async () => {
    await platform.close();
    platform = await startPlatform({
      holds: {
        persona_model_provider: "openai",
        persona_model: "gpt-5.6-terra",
        persona_model_key: MODEL_KEY,
        persona_model_reasoning_effort: "none",
        speech_to_text_provider: "openai_realtime",
        speech_to_text_key: LISTENING_KEY,
        speech_to_text_model: "gpt-4o-transcribe",
        text_to_speech_provider: "cartesia",
        text_to_speech_key: SPEAKING_KEY,
        text_to_speech_model: "sonic-3",
        text_to_speech_voice: "default",
        voice_activity_provider: "silero",
        media_backend: "livekit",
      },
    });
    await workspace.signIn(platform);
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
        await showing(terminal, "the persona's model [gpt-5.6-terra]");
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
      expect(twilio.requests).toEqual([]);
      expect(twilio.writes).toEqual([]);
      expect(twilio.passwords).toEqual([]);
      expect(platform.written).toEqual([]);
    },
  );
});
