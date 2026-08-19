/**
 * `egma self-host setup`, against a platform-shaped local server and a
 * Twilio-shaped tripwire.
 *
 * The real CLI process, the real command modules and the real HTTP client. Only
 * the platform, Twilio and the container runtime stand in. Normal setup must
 * never touch the Twilio stand-in: an administrator makes one trunk and
 * credential list, then gives each developer a stable SIP username/password.
 * Setup copies that developer's four runtime phone values into the platform.
 *
 * What is worth proving here, in order of how much it would cost to get wrong:
 *
 * 1. **Every answer is written through the platform, and this command seals
 *    nothing and keeps nothing.** The settings used to live in a file beside the
 *    deployment that only this CLI read, so a platform started any other way had
 *    none of them and nothing said so. So the checks are: what the platform
 *    holds afterwards, and that the file holds no setting at all.
 * 2. **A setting the platform already holds is not asked for again**, which is
 *    what makes running this twice cost nothing — and what makes a fully
 *    configured platform answer "nothing to do" rather than doing it all again.
 * 3. **A plan writes nothing, anywhere**, and asks nobody for anything.
 * 4. **No supplied secret reaches the terminal, the JSON, the receipt or the
 *    bootstrap file egma writes.** Sentinel values, swept for by hand.
 * 5. **The refusals name the problem**: a platform that did not answer, a
 *    platform that answered no, and a machine holding no key for it.
 */

import { existsSync } from "node:fs";
import { chmod, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startFakeTwilio, type FakeTwilio } from "./support/fake-twilio.ts";
import {
  makePlatformWorkspace,
  runSelfHost,
  startPlatform,
  type FakePlatform,
  type PlatformWorkspace,
  type SelfHostRun,
} from "./support/platform-workspace.ts";

/**
 * Values nothing else in this repository holds, so a sweep that finds one has
 * found this test's own input and not a coincidence.
 */
const IGNORED_AUTH_TOKEN = "SENTINEL-twilio-auth-token-0f1c8a2e4b6d";
const MODEL_KEY = "sk-SENTINEL-model-key-9a7c3e5f1b2d4680";
const LISTENING_KEY = "sk-SENTINEL-listening-key-1122334455667788";
const SPEAKING_KEY = "sk-SENTINEL-speaking-key-99887766554433221";
const IGNORED_ACCOUNT_SID = "AC00000000000000000000000000000001";
const SOURCE_NUMBER = "+15550100100";
const NUMBER_SID = "PN00000000000000000000000000000001";

const EXISTING_TRUNK = {
  sid: "TK00000000000000000000000000000001",
  domain: "egma-simulator-abc123.pstn.twilio.com",
};
const EXISTING_LIST = { sid: "CL00000000000000000000000000000001" };
const SIP_USERNAME = "egma-nischal";
const SIP_PASSWORD = "SENTINEL-shared-sip-password-1a2b3c4d";

/** One carrier configuration intentionally shared by local and hosted platforms. */
const SHARED_CARRIER: NodeJS.ProcessEnv = {
  EGMA_PHONE_TRUNK_ADDRESS: EXISTING_TRUNK.domain,
  EGMA_PHONE_SOURCE_NUMBER: SOURCE_NUMBER,
  EGMA_PHONE_TRUNK_USERNAME: SIP_USERNAME,
  EGMA_PHONE_TRUNK_PASSWORD: SIP_PASSWORD,
};

const REPLACEMENT_SIP_PASSWORD =
  "SENTINEL-replacement-sip-password-5e6f7a8b";
const REPLACEMENT_CARRIER: NodeJS.ProcessEnv = {
  EGMA_PHONE_TRUNK_ADDRESS: "replacement.pstn.twilio.com",
  EGMA_PHONE_SOURCE_NUMBER: "+15550100200",
  EGMA_PHONE_TRUNK_USERNAME: "egma-nischal-replacement",
  EGMA_PHONE_TRUNK_PASSWORD: REPLACEMENT_SIP_PASSWORD,
};

const PHONE_VARIABLES = [
  "EGMA_PHONE_TRUNK_ADDRESS",
  "EGMA_PHONE_SOURCE_NUMBER",
  "EGMA_PHONE_TRUNK_USERNAME",
  "EGMA_PHONE_TRUNK_PASSWORD",
] as const;

const WORKSPACE_PREFIX = "egma-platform-setup-";

/** Everything a platform holding nothing needs before it reports ready. */
const EVERY_ANSWER: NodeJS.ProcessEnv = {
  EGMA_PERSONA_MODEL_API_KEY: MODEL_KEY,
  EGMA_PERSONA_STT_API_KEY: LISTENING_KEY,
  EGMA_PERSONA_TTS_API_KEY: SPEAKING_KEY,
  ...SHARED_CARRIER,
};

/** What a platform holds once setup has finished against a working carrier. */
const EVERYTHING_HELD = {
  persona_model_provider: "openai",
  persona_model: "gpt-5.6-terra",
  persona_model_key: MODEL_KEY,
  // A caller on a live line does not pause to reason, so the interview's own
  // suggestion turns it off — the one model setting egma does suggest a value
  // for, because it is a behavior rather than a provider's model name.
  persona_model_reasoning_effort: "none",
  speech_to_text_provider: "openai_realtime",
  speech_to_text_key: LISTENING_KEY,
  text_to_speech_provider: "cartesia",
  text_to_speech_key: SPEAKING_KEY,
  voice_activity_provider: "silero",
  media_backend: "livekit",
  carrier_trunk_address: EXISTING_TRUNK.domain,
  carrier_trunk_number: SOURCE_NUMBER,
  carrier_trunk_username: SIP_USERNAME,
  carrier_trunk_password: SIP_PASSWORD,
} as const;

let twilio: FakeTwilio;
let platform: FakePlatform;
let workspace: PlatformWorkspace;

async function runSetup(
  args: readonly string[],
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<SelfHostRun> {
  return runSelfHost(workspace, ["setup", ...args], {
    EGMA_TWILIO_API_ROOT: twilio.apiRoot,
    EGMA_TWILIO_TRUNKING_ROOT: twilio.trunkingRoot,
    EGMA_BASE_URL: platform.url,
    // Nothing pre-answered unless a check says so, so a variable exported by
    // whoever is running the suite cannot answer a question for it.
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
    EGMA_PHONE_TRUNK_ADDRESS: "",
    EGMA_PHONE_TRUNK_USERNAME: "",
    EGMA_PHONE_TRUNK_PASSWORD: "",
    TWILIO_ACCOUNT_SID: "",
    TWILIO_AUTH_TOKEN: "",
    EGMA_PHONE_SOURCE_NUMBER: "",
    ...extraEnv,
  });
}

function expectNoTwilioAccess(): void {
  expect(twilio.requests).toEqual([]);
  expect(twilio.writes).toEqual([]);
  expect(twilio.passwords).toEqual([]);
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

describe("egma self-host setup", () => {
  beforeEach(async () => {
    workspace = await makePlatformWorkspace(WORKSPACE_PREFIX);
    twilio = await startFakeTwilio({
      numbers: { [SOURCE_NUMBER]: NUMBER_SID },
      existingTrunk: EXISTING_TRUNK,
      existingCredentialList: EXISTING_LIST,
      existingCredential: {
        sid: "CR00000000000000000000000000000001",
        username: "egma-production",
      },
      credentialListAttached: true,
      numberAttached: true,
    });
  });

  afterEach(async () => {
    await twilio.close();
    await platform.close();
  });

  it("writes every missing setting through the platform, and keeps none of them", async () => {
    platform = await startPlatform();
    await workspace.signIn(platform);

    const run = await runSetup(["--apply", "--yes", "--json"], EVERY_ANSWER);

    // Exactly one document on standard output and nothing else, so that a
    // coding agent driving this parses the whole answer rather than picking a
    // document out of a stream of lines.
    const answered = JSON.parse(run.stdout) as Record<string, unknown>;
    expect(answered.status, run.stderr).toBe("ready");
    expect(run.code).toBe(0);

    // **One write, carrying every answer.** Everything is asked before anything
    // is written, which is what makes a decline or a Ctrl-C part way through
    // leave the platform exactly as it was.
    expect(platform.written).toHaveLength(1);
    expect(platform.held()).toEqual(EVERYTHING_HELD);
    expectNoTwilioAccess();

    // The three the simulator has a working default for are not demanded of a
    // run with nobody watching, and readiness does not wait for them either.
    // Each leg answers with its own provider's default, which is the whole
    // reason egma does not store a second opinion about a model's name here.
    expect(answered.settings_written).not.toContain("speech_to_text_model");
    expect(answered.settings_written).not.toContain("text_to_speech_model");
    expect(answered.settings_written).not.toContain("text_to_speech_voice");

    // **And nothing of this is in the workspace.** The file that used to hold
    // every one of these still exists — it carries the media-server credential,
    // which a container reads when it is created — and it carries no setting.
    const stored = await workspace.storedConfig();
    expect(Object.keys(stored).sort()).toEqual([
      "EGMA_BASE_URL",
      "EGMA_LIVEKIT_API_KEY",
      "EGMA_LIVEKIT_API_SECRET",
    ]);
    const written = await everythingWritten(workspace.dir);
    for (const secret of [MODEL_KEY, LISTENING_KEY, SPEAKING_KEY, SIP_PASSWORD]) {
      expect(written).not.toContain(secret);
    }
  });

  it("copies exactly four runtime phone values into a fresh database", async () => {
    platform = await startPlatform({
      holds: Object.fromEntries(
        Object.entries(EVERYTHING_HELD).filter(([name]) => !name.startsWith("carrier_")),
      ),
    });
    await workspace.signIn(platform);

    const run = await runSetup(["--apply", "--yes", "--json"], SHARED_CARRIER);

    expect(run.code, run.stderr).toBe(0);
    expect(platform.written).toEqual([
      {
        carrier_trunk_address: EXISTING_TRUNK.domain,
        carrier_trunk_number: SOURCE_NUMBER,
        carrier_trunk_username: SIP_USERNAME,
        carrier_trunk_password: SIP_PASSWORD,
      },
    ]);
    expectNoTwilioAccess();
  });

  it.each(PHONE_VARIABLES)("requires %s and never falls back to Twilio", async (missing) => {
    platform = await startPlatform();
    await workspace.signIn(platform);
    const answers = { ...EVERY_ANSWER, [missing]: "" };

    const run = await runSetup(["--apply", "--yes", "--json"], answers);

    expect(run.code).toBe(2);
    expect(run.stderr).toContain(missing);
    expect(platform.written).toEqual([]);
    expectNoTwilioAccess();
  });

  it("accepts a complete source-IP route without asking for SIP credentials", async () => {
    platform = await startPlatform({
      holds: Object.fromEntries(
        Object.entries(EVERYTHING_HELD).filter(
          ([name]) =>
            name !== "carrier_trunk_username" &&
            name !== "carrier_trunk_password",
        ),
      ),
    });
    await workspace.signIn(platform);

    const run = await runSetup(["--apply", "--yes", "--json"]);
    const answered = JSON.parse(run.stdout) as Record<string, unknown>;

    expect(run.code, run.stderr).toBe(0);
    expect(answered.status).toBe("ready");
    expect(answered.settings_written).toEqual([]);
    expect(platform.written).toEqual([]);
    expectNoTwilioAccess();
  });

  it("ignores Twilio account authority even when the environment exports it", async () => {
    platform = await startPlatform();
    await workspace.signIn(platform);

    const run = await runSetup(["--apply", "--yes", "--json"], {
      ...EVERY_ANSWER,
      TWILIO_ACCOUNT_SID: IGNORED_ACCOUNT_SID,
      TWILIO_AUTH_TOKEN: IGNORED_AUTH_TOKEN,
    });

    expect(run.code, run.stderr).toBe(0);
    expect(`${run.stdout}\n${run.stderr}`).not.toContain(IGNORED_AUTH_TOKEN);
    expectNoTwilioAccess();
  });

  it("asks for nothing the platform already holds", async () => {
    // The property that makes running this twice cost nothing, and the one that
    // makes an operator's second run about the one key they were missing.
    platform = await startPlatform({
      holds: Object.fromEntries(
        Object.entries(EVERYTHING_HELD).filter(([name]) => name !== "persona_model_key"),
      ),
    });
    await workspace.signIn(platform);

    const run = await runSetup(["--apply", "--yes", "--json"], {
      EGMA_PERSONA_MODEL_API_KEY: MODEL_KEY,
      ...EVERY_ANSWER,
    });

    expect(run.code, run.stderr).toBe(0);
    expect(platform.written).toEqual([{ persona_model_key: MODEL_KEY }]);
    // The carrier is held, so nobody's Twilio account was read at all — no
    // trunk listed, no credential rotated, nothing.
    expect(twilio.requests).toEqual([]);
  });

  it("changes nothing on a platform that is already configured, and says so", async () => {
    platform = await startPlatform({ holds: EVERYTHING_HELD });
    await workspace.signIn(platform);

    // The first run still sees to the media-server credential, because that is
    // the workspace's rather than the platform's: a deployment can be perfectly
    // configured and still be running on a pair published in this repository.
    const first = await runSetup(["--apply", "--yes"], EVERY_ANSWER);
    expect(first.code, first.stderr).toBe(0);
    expect(first.stdout).toContain("changed: the media-server credential");

    // The second has nothing left to do anywhere, and says exactly that.
    const run = await runSetup(["--apply", "--yes"], EVERY_ANSWER);

    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toContain("status: ready");
    expect(run.stdout).toContain("settings_written: none");
    expect(run.stdout).toContain("changed: nothing");
    expect(run.stderr).toContain("already holds every setting it needs");
    expect(platform.written).toEqual([]);
    expect(twilio.requests).toEqual([]);
  });

  it("refuses an unconfirmed carrier replacement without writing", async () => {
    platform = await startPlatform({ holds: EVERYTHING_HELD });
    await workspace.signIn(platform);

    const run = await runSetup(
      ["--replace-carrier", "--json"],
      REPLACEMENT_CARRIER,
    );
    const answered = JSON.parse(run.stdout) as Record<string, unknown>;

    expect(run.code).toBe(4);
    expect(answered.status).toBe("not_confirmed");
    expect(answered.changed).toBe("nothing");
    expect(answered.reason).toContain("added the replacement credential beside the old one");
    expect(run.stdout).not.toContain(REPLACEMENT_SIP_PASSWORD);
    expect(platform.written).toEqual([]);
    expectNoTwilioAccess();
  });

  it("replaces all four held carrier values only when explicitly confirmed", async () => {
    platform = await startPlatform({ holds: EVERYTHING_HELD });
    await workspace.signIn(platform);

    const run = await runSetup(
      ["--replace-carrier", "--yes", "--json"],
      REPLACEMENT_CARRIER,
    );
    const answered = JSON.parse(run.stdout) as Record<string, unknown>;

    expect(run.code, run.stderr).toBe(0);
    expect(answered.carrier_bundle).toBe("replaced");
    expect(platform.written).toEqual([
      {
        carrier_trunk_address: "replacement.pstn.twilio.com",
        carrier_trunk_number: "+15550100200",
        carrier_trunk_username: "egma-nischal-replacement",
        carrier_trunk_password: REPLACEMENT_SIP_PASSWORD,
      },
    ]);
    expect(run.stdout).not.toContain(REPLACEMENT_SIP_PASSWORD);
    expect(await everythingWritten(workspace.dir)).not.toContain(
      REPLACEMENT_SIP_PASSWORD,
    );
    expectNoTwilioAccess();
  });

  it("refuses a confirmed replacement unless all four new values are present", async () => {
    platform = await startPlatform({ holds: EVERYTHING_HELD });
    await workspace.signIn(platform);

    const incomplete = { ...REPLACEMENT_CARRIER };
    delete incomplete.EGMA_PHONE_TRUNK_PASSWORD;
    const run = await runSetup(
      ["--replace-carrier", "--yes", "--json"],
      incomplete,
    );

    expect(run.code).toBe(2);
    expect(run.stderr).toContain("EGMA_PHONE_TRUNK_PASSWORD");
    expect(platform.written).toEqual([]);
    expectNoTwilioAccess();
  });

  it("lists what it would ask for, and writes nothing anywhere", async () => {
    platform = await startPlatform();
    await workspace.signIn(platform);

    const run = await runSetup(["--plan"]);

    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toContain("status: planned");
    expect(run.stdout).toContain("changed: nothing");
    // The point of the mode: an operator gathers what they need *before* they
    // start, rather than discovering a missing key one setting at a time.
    expect(run.stdout).toContain("asks: the persona's model key");
    expect(run.stdout).toContain("asks: the speech-to-text key");
    expect(run.stdout).toContain(
      "asks: the SIP trunk address, source number, SIP username and SIP password",
    );
    expect(run.stdout).not.toContain("Twilio Account SID");
    expect(run.stdout).not.toContain("Twilio Auth Token");
    expect(run.stdout).not.toContain("your Twilio account");

    // Nothing was written to the platform, nothing was read at the carrier, and
    // no local state either — not the bootstrap file, not a receipt, not even
    // the directory those would live in.
    expect(platform.written).toEqual([]);
    expectNoTwilioAccess();
    expect(existsSync(path.join(workspace.dir, ".egma-platform"))).toBe(false);
  });

  it("finds this machine's key however the address was spelled", async () => {
    // The keys this machine holds are filed under a *normalized* origin, and
    // this command's address comes from a variable somebody typed rather than
    // from an origin the platform reported. Spelled with a trailing slash, an
    // unnormalized lookup finds nothing — so setup refuses an owner who is
    // signed in, and refuses them again after they log in a second time,
    // because logging in files the key under the same normal form.
    platform = await startPlatform({ holds: EVERYTHING_HELD });
    await workspace.signIn(platform);

    const run = await runSetup(["--apply", "--yes"], {
      ...EVERY_ANSWER,
      EGMA_BASE_URL: `${platform.url}/`,
    });

    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toContain("status: ready");
    // And what it prints and records is the one normal spelling, which is what
    // the platform reports about itself and what a repository binds to.
    expect(run.stdout).toContain(`url: ${platform.url}`);
    expect((await workspace.storedConfig()).EGMA_BASE_URL).toBe(platform.url);
  });

  it("refuses an address that is not one, naming where it came from", async () => {
    platform = await startPlatform();
    await workspace.signIn(platform);

    const run = await runSetup(["--plan"], { EGMA_BASE_URL: "egma.example/platform" });

    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain("EGMA_BASE_URL is not a platform origin");
    expect(run.stderr).toContain("no credentials, path, query, or fragment");
    // Refused before anything is asked of anybody, and the address is never
    // printed back — a rejected one can be carrying a password.
    expect(platform.asked).toEqual([]);
  });

  it("refuses to call itself ready when the media containers did not come back", async () => {
    // The pair is on the disk by the time the recreation runs, so a recreation
    // that failed leaves what is recorded and what is running disagreeing —
    // which passes every health check and surfaces minutes later as a media
    // refusal naming nothing about configuration. That is this effort's own
    // failure, so setup must not answer `ready` over it.
    platform = await startPlatform({ holds: EVERYTHING_HELD });
    await workspace.signIn(platform);
    await writeFile(workspace.dockerShim, "#!/bin/sh\nexit 1\n");
    await chmod(workspace.dockerShim, 0o755);

    const run = await runSetup(["--apply", "--yes"], EVERY_ANSWER);

    expect(run.code).toBe(4);
    expect(run.stdout).toContain("status: incomplete");
    expect(run.stdout).toContain("did not come back");
    // And it names the command that repairs it, rather than the trouble alone.
    expect(run.stdout).toContain("Run egma self-host up");
  });

  it("refuses, naming the address, when the platform cannot be reached", async () => {
    platform = await startPlatform();
    await workspace.signIn(platform);
    const address = platform.url;
    await platform.close();

    const run = await runSetup(["--apply", "--yes"], {
      ...EVERY_ANSWER,
      EGMA_BASE_URL: address,
    });

    expect(run.code).toBe(4);
    expect(run.stderr).toContain(`Egma at ${address} did not answer`);
    expect(run.stderr).toContain("that the instance is running");
    // Nothing was asked of anybody's carrier on the way to finding out.
    expect(twilio.requests).toEqual([]);

    // Started again only so the shared teardown has something to close.
    platform = await startPlatform();
  });

  it("refuses, naming the command that fixes it, when this machine holds no key", async () => {
    // Every answer is written through the platform's API, and that door opens
    // for an organization owner. Failing on a 401 nobody can act on would send
    // an operator to read source at the moment they are holding a credential.
    platform = await startPlatform();

    const run = await runSetup(["--apply", "--yes"], EVERY_ANSWER);

    expect(run.code).toBe(3);
    expect(run.stderr).toContain("not signed in");
    expect(run.stderr).toContain(`egma login --url ${platform.url}`);
    expect(run.stderr).toContain("Nothing was asked and nothing was written");
    expect(twilio.requests).toEqual([]);
  });

  it("relays the platform's own words when it refuses the settings door", async () => {
    // The wording is the contract: a client puts it in front of whoever is
    // holding the terminal, and it names both ways a caller can meet it — the
    // role they hold, and the kind of deployment this is.
    const refusal =
      "the settings of this platform are read and changed by an organization owner, " +
      "and only while this Egma instance serves one organization.";
    platform = await startPlatform({ refuses: { status: 403, message: refusal } });
    await workspace.signIn(platform);

    const run = await runSetup(["--apply", "--yes"], EVERY_ANSWER);

    expect(run.code).toBe(4);
    expect(run.stderr).toContain(refusal);
    expect(platform.written).toEqual([]);
  });

  it("reveals no supplied secret in its output, its receipt or its bootstrap file", async () => {
    platform = await startPlatform();
    await workspace.signIn(platform);

    const run = await runSetup(["--apply", "--yes", "--json"], {
      ...EVERY_ANSWER,
      TWILIO_ACCOUNT_SID: IGNORED_ACCOUNT_SID,
      TWILIO_AUTH_TOKEN: IGNORED_AUTH_TOKEN,
    });
    expect(run.code, run.stderr).toBe(0);

    const answered = JSON.parse(run.stdout) as Record<string, unknown>;
    // Which key each leg was configured with, and where it came from. Both
    // matter because these are variables a developer may already export: a run
    // that reads one asks nothing and looks exactly like a run that was told,
    // and a stale exported key surfaces an hour later as a provider refusing
    // every turn.
    expect(answered.persona_model_key_from).toBe("EGMA_PERSONA_MODEL_API_KEY");
    expect(answered.persona_model_key_hint).toBe(`…${MODEL_KEY.slice(-4)}`);
    // A hint names a key; it is not most of one.
    expect(String(answered.persona_model_key_hint).length).toBe(5);
    expect(answered.receipt).toMatch(/^\.egma-platform\/receipts\//u);
    expect(platform.held().carrier_trunk_password).toBe(SIP_PASSWORD);
    expectNoTwilioAccess();

    const said = `${run.stdout}\n${run.stderr}`;
    for (const secret of [
      IGNORED_AUTH_TOKEN,
      MODEL_KEY,
      LISTENING_KEY,
      SPEAKING_KEY,
      SIP_PASSWORD,
    ]) {
      expect(said).not.toContain(secret);
    }

    // A receipt is a document people commit and paste into issues, so no secret
    // reaches one — including the developer's stable SIP password.
    const receipts = await readdir(path.join(workspace.dir, ".egma-platform", "receipts"));
    expect(receipts).toHaveLength(1);
    const receipt = await readFile(
      path.join(workspace.dir, ".egma-platform", "receipts", receipts[0] as string),
      "utf8",
    );
    for (const secret of [
      IGNORED_AUTH_TOKEN,
      MODEL_KEY,
      LISTENING_KEY,
      SPEAKING_KEY,
      SIP_PASSWORD,
    ]) {
      expect(receipt).not.toContain(secret);
    }
    expect(receipt).not.toContain("minted, not recorded");

    // And the one file egma still writes here holds no provider key at all,
    // because no provider key is this command's to keep.
    const bootstrap = path.join(workspace.dir, ".egma-platform", "platform.env");
    const text = await readFile(bootstrap, "utf8");
    for (const secret of [
      IGNORED_AUTH_TOKEN,
      MODEL_KEY,
      LISTENING_KEY,
      SPEAKING_KEY,
      SIP_PASSWORD,
    ]) {
      expect(text).not.toContain(secret);
    }
    expect((await stat(bootstrap)).mode & 0o777).toBe(0o600);
    expect((await stat(path.join(workspace.dir, ".egma-platform"))).mode & 0o777).toBe(
      0o700,
    );
  });

  it("refuses a secret offered as a command argument, before it does anything", async () => {
    platform = await startPlatform();
    await workspace.signIn(platform);

    const run = await runSetup([
      "--apply",
      "--yes",
      "--auth-token",
      IGNORED_AUTH_TOKEN,
    ]);

    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain("will not take a secret in --auth-token");
    // Said back by name only. The value is never repeated.
    expect(run.stderr).not.toContain(IGNORED_AUTH_TOKEN);
    // And the advice is something a shell does not write to history, and names
    // this half of the CLI rather than the agent-repository half.
    expect(run.stderr).toContain('export EGMA_PHONE_TRUNK_PASSWORD="$(cat');
    expect(run.stderr).not.toContain("TWILIO_AUTH_TOKEN");
    expect(run.stderr).toContain("egma self-host setup");
    expect(run.stderr).not.toContain("egma connect");
    expectNoTwilioAccess();
  });

  it("says which command replaced the one somebody typed", async () => {
    // Whoever types `phone setup` is following documentation or a shell history
    // from before the settings moved into the platform, and the one useful
    // thing to say is which words do it now.
    platform = await startPlatform();

    const run = await runSelfHost(workspace, ["phone", "setup"], {
      EGMA_BASE_URL: platform.url,
    });

    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain("egma self-host phone setup is gone");
    expect(run.stderr).toContain("egma self-host setup");
  });

  it("works in a workspace named with --cwd, in both spellings", async () => {
    // Run from somewhere that is not a platform workspace, naming one. This is
    // the escape hatch the refusal for being in the wrong directory offers.
    platform = await startPlatform({ holds: EVERYTHING_HELD });
    await workspace.signIn(platform);
    const elsewhere = await mkdtemp(path.join(tmpdir(), "egma-elsewhere-"));

    for (const spelling of [["--cwd", workspace.dir], [`--cwd=${workspace.dir}`]]) {
      const run = await runSelfHost(
        { dir: elsewhere, binDir: workspace.binDir, egmaHome: workspace.egmaHome },
        ["setup", "--plan", ...spelling],
        { EGMA_BASE_URL: platform.url },
      );

      expect(run.stdout, `with ${spelling.join(" ")}`).toContain(
        `workspace: ${workspace.dir}`,
      );
      expect(run.code).toBe(0);
    }
  });

  it.each([
    // The quiet kind of wrong: `--json` is swallowed, and a script that asked
    // for one document gets plain lines with no complaint.
    { what: "a value that is really the next option", args: ["--plan", "--cwd", "--json"] },
    { what: "no value at all", args: ["--plan", "--cwd"] },
    { what: "an empty value", args: ["--plan", "--cwd="] },
  ])("refuses --cwd given $what", async ({ args }) => {
    platform = await startPlatform();

    const run = await runSetup(args);

    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain("does not know the option --cwd");
    expect(run.stdout).not.toContain("status: planned");
    expect(twilio.requests).toEqual([]);
  });

  it("names an option it does not know, and never its value", async () => {
    platform = await startPlatform();

    const run = await runSetup(["--plan", "--nonsense=something-private"]);

    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain("does not know the option --nonsense");
    expect(run.stderr).not.toContain("something-private");
    expect(twilio.requests).toEqual([]);
  });

  it("refuses outside a platform workspace, and names the difference", async () => {
    platform = await startPlatform();
    const notAWorkspace = await mkdtemp(path.join(tmpdir(), "egma-not-platform-"));

    const run = await runSelfHost(
      { dir: notAWorkspace, binDir: workspace.binDir, egmaHome: workspace.egmaHome },
      ["setup", "--plan"],
      { EGMA_BASE_URL: platform.url },
    );

    expect(run.code).toBe(1);
    expect(run.stderr).toContain("this is not a platform workspace");
    // The distinction the whole command rests on is spelled out, because
    // running it in an agent repository is the mistake somebody will make.
    expect(run.stderr).toContain("not your agent repository");
    expect(twilio.requests).toEqual([]);
  });
});
