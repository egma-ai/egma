/**
 * `egma self-host`: the platform operator's half of the CLI.
 *
 * One CLI, two contexts. The bare wizard and `connect`, `pull`, `push` and
 * `run` operate an *agent repository* — tests, and the address of the platform
 * that owns their identifiers. Everything under `self-host` operates a
 * *platform workspace* — the deployment itself, its containers, and the carrier
 * and provider credentials that belong to whoever runs it. On one laptop that
 * is often the same person, and the product still keeps the two apart, because
 * one platform serves many repositories and platform secrets must not spread
 * into any of them.
 *
 * Two verbs:
 *
 * - **`up`** starts the whole platform and prints the address an agent
 *   repository points at. Everything: the API, the web application, both
 *   stores, the simulator, the grader, LiveKit, its SIP gateway and their
 *   Redis. There is no phone overlay to ask for by name any more.
 * - **`phone setup`** makes that deployment able to place a call. It asks for a
 *   Twilio account, a number that account already owns, and one OpenAI key;
 *   shows a plan; and on approval does the carrier paperwork, activates the
 *   configuration and waits for the platform to report phone readiness.
 *
 * **The address `up` prints is the address the platform reports.** They are one
 * value, not two that happen to agree: the CLI refuses to send a repository's
 * identifiers to a platform whose reported origin differs from the address a
 * developer typed, which is right, and which makes an `up` that printed a LAN
 * address while the API reported localhost a deployment where every later
 * command is refused. So `up` sets `EGMA_BASE_URL` to exactly what it prints,
 * and prints exactly what it set.
 */

import { existsSync } from "node:fs";
import path from "node:path";

import {
  compose,
  containerOf,
  DockerMissingError,
  type ComposeOptions,
} from "../self-host/compose.ts";
import {
  askPlainly,
  askSecret,
  NoAnswerError,
  PLAIN_VARIABLES,
  REFUSED_SECRET_ARGUMENTS,
  SECRET_VARIABLES,
  secretArgumentRefusal,
  type AskOptions,
} from "../self-host/protected-input.ts";
import { fileReceipt, sweptOf, type Receipt } from "../self-host/receipt.ts";
import {
  applyCarrier,
  ARTIFACT_NAME,
  CarrierError,
  planCarrier,
  TWILIO_API_ROOT,
  TWILIO_TRUNKING_ROOT,
  type CarrierPlan,
} from "../self-host/twilio.ts";
import {
  findWorkspace,
  NoPlatformWorkspaceError,
  PLATFORM_DIRECTORY,
  readPlatformConfig,
  writePlatformConfig,
} from "../self-host/workspace.ts";

/** What each ending means to whoever ran the command. */
export const SELF_HOST_EXIT = {
  /** Done. */
  ok: 0,
  /** This is not a platform workspace, or docker is not here. */
  noWorkspace: 1,
  /** An input was missing and there was nobody to ask. */
  noAnswer: 2,
  /** The carrier or the platform refused, and said why. */
  refused: 4,
  /** A plan was shown and nothing was approved, so nothing was written. */
  notApproved: 5,
  /** Stopped part way. */
  interrupted: 130,
} as const;

/**
 * The address a platform is reached at, and therefore the one it reports.
 *
 * The compose default, restated here because this command *sets* it rather than
 * reading it: a deployment reached on a LAN address sets `EGMA_BASE_URL` in its
 * own environment and `up` prints what it finds there.
 */
export const DEFAULT_PLATFORM_ADDRESS = "http://localhost:3101";

/** Where the API answers its own identity and phone readiness. */
const PLATFORM_IDENTITY_PATH = "/api/platform";

/** How long the platform has to come up before something is wrong. */
const READY_TIMEOUT_MS = 300_000;
const READY_POLL_MS = 2_000;

/** Which services `self-host up` waits for. */
const WAITED_FOR = ["postgres", "clickhouse", "api", "web", "livekit"] as const;

/** Which services phone configuration reaches, and therefore what is recreated. */
const PHONE_SERVICES = ["api", "simulator", "grader"] as const;

export type SelfHostOptions = {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly argv: readonly string[];
  readonly stdin: NodeJS.ReadableStream & { isTTY?: boolean };
  readonly stdout: NodeJS.WritableStream & { isTTY?: boolean };
  readonly out: (line: string) => void;
  readonly fail: (line: string) => void;
  readonly signal?: AbortSignal | undefined;
};

export function isSelfHostInvocation(argv: readonly string[]): boolean {
  return argv[0] === "self-host";
}

export async function runSelfHostCommand(options: SelfHostOptions): Promise<number> {
  const leaked = REFUSED_SECRET_ARGUMENTS.find((refused) =>
    options.argv.some((argument) => argument === refused || argument.startsWith(`${refused}=`)),
  );
  if (leaked !== undefined) {
    options.fail(secretArgumentRefusal(leaked));
    return SELF_HOST_EXIT.refused;
  }

  const words = options.argv.slice(1).filter((word) => !word.startsWith("-"));
  const verb = words.join(" ");

  try {
    if (verb === "up") return await runUp(options);
    if (verb === "phone setup") return await runPhoneSetup(options);
  } catch (error) {
    if (error instanceof NoPlatformWorkspaceError || error instanceof DockerMissingError) {
      options.out(`status: refused\nreason: ${error.message}`);
      options.fail(error.message);
      return SELF_HOST_EXIT.noWorkspace;
    }
    if (error instanceof NoAnswerError) {
      options.out(`status: refused\nreason: ${error.message}`);
      options.fail(error.message);
      return SELF_HOST_EXIT.noAnswer;
    }
    if (error instanceof CarrierError) {
      options.out(`status: refused\nreason: ${error.message}`);
      options.fail(error.message);
      return SELF_HOST_EXIT.refused;
    }
    throw error;
  }

  options.fail(
    `egma self-host does not know ${verb === "" ? "that" : `"${verb}"`}. It knows:\n` +
      "  egma self-host up            Start the whole platform.\n" +
      "  egma self-host phone setup   Make it able to place phone calls.",
  );
  return SELF_HOST_EXIT.noWorkspace;
}

// -- up -----------------------------------------------------------------------

async function runUp(options: SelfHostOptions): Promise<number> {
  const workspace = findWorkspace(options.cwd);
  const stored = readPlatformConfig(workspace);

  // One address, decided here. The environment wins because a deployment
  // reached on a LAN address says so there; the stored configuration is next,
  // so a platform set up once keeps its address; the compose default is last.
  const address =
    options.env.EGMA_BASE_URL?.trim() ||
    stored.EGMA_BASE_URL?.trim() ||
    DEFAULT_PLATFORM_ADDRESS;

  const environment: Record<string, string> = { ...stored, EGMA_BASE_URL: address };
  const composeOptions: ComposeOptions = {
    workspace,
    environment,
    signal: options.signal,
    onLine: (line) => options.fail(line),
  };

  options.out(`workspace: ${workspace}`);
  options.out(`url: ${address}`);

  // Twice, on a workspace that has never been started. ClickHouse's own
  // entrypoint starts a server, creates the database, stops it and starts the
  // real one — and its health check answers during the first of those, so the
  // API can be released to connect to a server that is on its way down. It
  // exits, compose reports a dependency failure, and a second `up` succeeds
  // against the stores that now exist. Measured on a clean workspace here, so
  // this is not defensive coding: it is the first run, and a first run that
  // fails once and works when you type the same thing again is a product that
  // taught its first user to distrust it.
  let started = await compose(["up", "-d", "--wait", "--wait-timeout", "300"], composeOptions);
  if (started.code !== 0) {
    options.fail(
      "one of the services did not come up on the first try. That is usual on a " +
        "workspace that has never been started, because a store's first boot " +
        "creates its database and restarts itself. Trying once more.",
    );
    started = await compose(["up", "-d", "--wait", "--wait-timeout", "300"], composeOptions);
  }
  if (started.code !== 0) {
    options.out("status: failed");
    options.out("reason: docker compose could not bring the platform up, twice");
    return SELF_HOST_EXIT.refused;
  }

  const platform = await waitForPlatform(address, options.signal);
  if (platform === null) {
    options.out("status: failed");
    options.out(
      `reason: the containers started but nothing answered ${address}${PLATFORM_IDENTITY_PATH} within ${
        READY_TIMEOUT_MS / 1000
      }s`,
    );
    return SELF_HOST_EXIT.refused;
  }

  // The agreement this whole command turns on: what was printed is what the
  // platform reports about itself. A repository binds to the second and a
  // developer types the first, and a CLI that refuses a mismatch — which it
  // does, and should — makes any disagreement here fatal later rather than now.
  if (platform.origin !== address) {
    options.out("status: failed");
    options.out(
      `reason: this platform reports its address as ${platform.origin} but was started at ${address}. ` +
        "Every command from an agent repository would be refused. Set EGMA_BASE_URL to the address " +
        "people really reach this platform at and run this again.",
    );
    return SELF_HOST_EXIT.refused;
  }

  options.out(`platform: ${platform.instanceId}`);
  options.out(`services: ${WAITED_FOR.join(" ")}`);
  options.out(`phone: ${platform.phoneState}`);
  if (platform.phoneMissing.length > 0) {
    options.out(`phone_missing: ${platform.phoneMissing.join(", ")}`);
  }
  options.out("status: ready");
  options.out(`connect: npx egma --url ${address}`);

  options.fail("");
  options.fail(`egma is running at ${address}`);
  options.fail(
    platform.phoneState === "ready"
      ? "Phone simulations are set up."
      : "Phone simulations need one more command here: egma self-host phone setup",
  );
  options.fail("");
  options.fail("In your agent repository, once:");
  options.fail(`  npx egma --url ${address}`);
  return SELF_HOST_EXIT.ok;
}

type PlatformFacts = {
  readonly instanceId: string;
  readonly origin: string;
  readonly phoneState: string;
  readonly phoneMissing: readonly string[];
};

async function readPlatform(address: string): Promise<PlatformFacts | null> {
  try {
    const answer = await fetch(`${address}${PLATFORM_IDENTITY_PATH}`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!answer.ok) return null;
    const body = (await answer.json()) as {
      instance_id?: unknown;
      origin?: unknown;
      phone?: { state?: unknown; missing?: unknown };
    };
    if (typeof body.instance_id !== "string" || typeof body.origin !== "string") return null;
    const missing = body.phone?.missing;
    return {
      instanceId: body.instance_id,
      origin: body.origin,
      phoneState: typeof body.phone?.state === "string" ? body.phone.state : "unknown",
      phoneMissing: Array.isArray(missing) ? missing.map(String) : [],
    };
  } catch {
    return null;
  }
}

async function waitForPlatform(
  address: string,
  signal: AbortSignal | undefined,
): Promise<PlatformFacts | null> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    const facts = await readPlatform(address);
    if (facts !== null) return facts;
    if (Date.now() >= deadline || signal?.aborted === true) return null;
    await new Promise((wake) => setTimeout(wake, READY_POLL_MS));
  }
}

// -- phone setup --------------------------------------------------------------

type PhoneSetupMode = {
  /** Read and show what would happen; write nothing, anywhere. */
  readonly planOnly: boolean;
  /** Approval given in the command, for a run with nobody watching. */
  readonly approved: boolean;
  /** Answer with one JSON document instead of lines. */
  readonly asJson: boolean;
};

function modeOf(argv: readonly string[]): PhoneSetupMode {
  const has = (flag: string): boolean => argv.includes(flag);
  return {
    planOnly: has("--plan") && !has("--apply"),
    approved: has("--yes"),
    asJson: has("--json"),
  };
}

async function runPhoneSetup(options: SelfHostOptions): Promise<number> {
  const workspace = findWorkspace(options.cwd);
  const mode = modeOf(options.argv);
  const stored = readPlatformConfig(workspace);
  const ask: AskOptions = {
    env: options.env,
    input: options.stdin,
    output: options.stdout,
    signal: options.signal,
  };

  // The two that are not secrets, asked for plainly. An account SID is printed
  // on Twilio's own dashboard and a source number is on every caller's handset.
  const accountSid = await askPlainly(
    PLAIN_VARIABLES.accountSid,
    "Twilio Account SID",
    ask,
  );
  const sourceNumber = normalizeNumber(
    await askPlainly(
      PLAIN_VARIABLES.sourceNumber,
      "A voice number this Twilio account already owns, in E.164 (egma never buys one)",
      ask,
    ),
  );
  // The three that are. Never an argument, never echoed, never written to a
  // receipt, and the first of them never written anywhere at all.
  const authToken = await askSecret(
    "twilio-auth-token",
    "Twilio Auth Token (used by this command only, never kept)",
    ask,
  );
  const openaiKey = await askSecret(
    "openai-api-key",
    "OpenAI API key (the persona's voice, its ears, its words and the default judge)",
    ask,
  );

  const secrets = [authToken, openaiKey] as const;
  const access = {
    accountSid,
    authToken,
    apiRoot: options.env.EGMA_TWILIO_API_ROOT?.trim() || TWILIO_API_ROOT,
    trunkingRoot: options.env.EGMA_TWILIO_TRUNKING_ROOT?.trim() || TWILIO_TRUNKING_ROOT,
  };

  // Planning reads the account and changes nothing, here or there.
  const plan = await planCarrier(access, { number: sourceNumber, name: ARTIFACT_NAME });
  const planDocument = planLines(plan, workspace);
  sweptOf(planDocument.join("\n"), secrets);

  if (mode.asJson) {
    options.out(
      JSON.stringify(
        {
          command: "self-host phone setup",
          mode: mode.planOnly ? "plan" : "apply",
          account_sid: plan.accountSid,
          source_number: plan.sourceNumber,
          source_number_sid: plan.sourceNumberSid,
          trunk_name: plan.trunkName,
          trunk_sid: plan.trunkSid,
          trunk_address: plan.trunkAddress,
          buys_a_number: false,
          steps: plan.steps,
        },
        null,
        2,
      ),
    );
  } else {
    for (const line of planDocument) options.out(line);
  }

  if (mode.planOnly) {
    fileReceipt(
      workspace,
      {
        command: "self-host phone setup --plan",
        at: new Date().toISOString(),
        result: "planned",
        facts: nonSecretFacts(plan),
        steps: plan.steps.map((step) => `${step.action}: ${step.detail}`),
      },
      secrets,
    );
    options.out("status: planned");
    options.out("changed: nothing");
    return SELF_HOST_EXIT.ok;
  }

  if (!mode.approved) {
    const approved = await askApproval(options, ask);
    if (!approved) {
      options.out("status: not_approved");
      options.out("changed: nothing");
      return SELF_HOST_EXIT.notApproved;
    }
  }

  const applied = await applyCarrier(access, { number: sourceNumber, name: ARTIFACT_NAME });

  // The address the platform is reached at survives phone setup untouched: the
  // agreement `up` established is not this command's to move.
  const address =
    options.env.EGMA_BASE_URL?.trim() ||
    stored.EGMA_BASE_URL?.trim() ||
    DEFAULT_PLATFORM_ADDRESS;

  const configuration: Record<string, string> = {
    ...stored,
    EGMA_BASE_URL: address,

    // What the API knows about the carrier: three non-secret facts, and it
    // reports readiness from them. No token, no password, no key.
    EGMA_PHONE_TRUNK_ADDRESS: applied.trunkAddress,
    EGMA_PHONE_SOURCE_NUMBER: applied.sourceNumber,
    EGMA_PHONE_SPEECH_PROVIDER: "openai",

    // What the simulator dials with. The SIP credential authenticates one
    // trunk and can do nothing else on the account — that is the whole reason
    // the Auth Token is a setup-time input rather than a container's variable.
    EGMA_SIMULATOR_MEDIA_BACKEND: "livekit",
    EGMA_SIMULATOR_SIP_TRUNK_ADDRESS: applied.trunkAddress,
    EGMA_SIMULATOR_SIP_TRUNK_NUMBER: applied.sourceNumber,
    EGMA_SIMULATOR_SIP_TRUNK_USERNAME: applied.sipUsername,
    EGMA_SIMULATOR_SIP_TRUNK_PASSWORD: applied.sipPassword,

    // One key, four jobs: the persona's words, its voice, its ears, and the
    // judge a project is given when it has configured none. Pipecat's own
    // OpenAI integrations and its Silero detector; egma configures them and
    // implements no speech provider of its own.
    EGMA_SIMULATOR_MODEL_PROVIDER: "openai",
    EGMA_SIMULATOR_MODEL_NAME: options.env.EGMA_PERSONA_MODEL?.trim() || "gpt-4o",
    EGMA_SIMULATOR_MODEL_API_KEY: openaiKey,
    EGMA_SIMULATOR_STT_PROVIDER: "openai",
    EGMA_SIMULATOR_TTS_PROVIDER: "openai",
    EGMA_SIMULATOR_VAD_PROVIDER: "silero",
    EGMA_SIMULATOR_OPENAI_API_KEY: openaiKey,
    EGMA_JUDGE_PROVIDER: "openai",
    EGMA_JUDGE_MODEL: options.env.EGMA_JUDGE_MODEL?.trim() || "gpt-4o",
    EGMA_JUDGE_API_KEY: openaiKey,
  };

  const configFile = writePlatformConfig(workspace, configuration, {
    header: [
      "egma platform configuration — written by `egma self-host phone setup`.",
      "",
      "This file holds credentials. It is created readable by you and nobody",
      "else, it belongs wherever the rest of this deployment's secrets do, and",
      "it belongs in no repository.",
      "",
      "The Twilio Auth Token is deliberately not here. It was used once, to do",
      "the carrier paperwork, and never kept: what a running egma holds is the",
      "SIP credential below, which can authenticate one trunk and nothing else.",
    ],
  });

  const composeOptions: ComposeOptions = {
    workspace,
    environment: configuration,
    signal: options.signal,
    onLine: (line) => options.fail(line),
  };

  // Activate it. Recreating rather than restarting, because a container keeps
  // the environment it was created with and a restart would come back with the
  // configuration it did not have.
  const recreated = await compose(
    ["up", "-d", "--wait", "--wait-timeout", "300", "--force-recreate", ...PHONE_SERVICES],
    composeOptions,
  );

  const readiness =
    recreated.code === 0 ? await waitForPhone(address, options.signal) : null;

  const receipt: Receipt = {
    command: "self-host phone setup",
    at: new Date().toISOString(),
    result: readiness === "ready" ? "applied" : "failed",
    facts: {
      ...nonSecretFacts(plan),
      trunk_sid: applied.trunkSid,
      trunk_address: applied.trunkAddress,
      sip_username: applied.sipUsername,
      // Said rather than shown, so that a receipt records that a credential
      // exists without being the second place it exists.
      sip_password: "minted, not recorded",
      speech_provider: "openai",
      configuration_file: path.relative(workspace, configFile),
      platform_url: address,
      phone_state: readiness ?? "unknown",
    },
    steps: applied.steps.map((step) => `${step.action}: ${step.detail}`),
  };
  const receiptFile = fileReceipt(workspace, receipt, [
    ...secrets,
    applied.sipPassword,
  ]);

  for (const step of applied.steps) options.out(`did: ${step.action} ${step.detail}`);
  options.out(`trunk: ${applied.trunkSid}`);
  options.out(`trunk_address: ${applied.trunkAddress}`);
  options.out(`source_number: ${applied.sourceNumber}`);
  options.out(`configuration: ${path.relative(workspace, configFile)}`);
  options.out(`receipt: ${path.relative(workspace, receiptFile)}`);
  options.out(`phone: ${readiness ?? "unknown"}`);

  if (readiness !== "ready") {
    options.out("status: failed");
    options.out(
      "reason: the carrier is set up and the configuration is written, but this " +
        "platform did not come back reporting phone readiness. Run the same command " +
        "again — it reuses everything it made and creates no second copy of anything.",
    );
    return SELF_HOST_EXIT.refused;
  }

  options.out("status: ready");
  options.fail("");
  options.fail("This egma can place phone calls.");
  options.fail(
    `The Twilio Auth Token was used once and kept nowhere. What is running holds a SIP credential for the trunk ${applied.trunkSid} and nothing else on that account.`,
  );
  return SELF_HOST_EXIT.ok;
}

async function waitForPhone(
  address: string,
  signal: AbortSignal | undefined,
): Promise<string | null> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    const facts = await readPlatform(address);
    if (facts !== null && facts.phoneState === "ready") return facts.phoneState;
    if (Date.now() >= deadline || signal?.aborted === true) {
      return facts === null ? null : facts.phoneState;
    }
    await new Promise((wake) => setTimeout(wake, READY_POLL_MS));
  }
}

async function askApproval(
  options: SelfHostOptions,
  ask: AskOptions,
): Promise<boolean> {
  if (options.stdin.isTTY !== true) {
    // Nobody is watching and nothing said yes. A plan is still worth having,
    // so this is not an error — it is a plan, and a refusal to write.
    return false;
  }
  const { createInterface } = await import("node:readline/promises");
  const asked = createInterface({ input: options.stdin, output: options.stdout });
  try {
    const answer = (
      await asked.question("Apply this to your Twilio account? [y/N] ", {
        signal: ask.signal,
      })
    )
      .trim()
      .toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    asked.close();
  }
}

function planLines(plan: CarrierPlan, workspace: string): readonly string[] {
  return [
    `workspace: ${workspace}`,
    `account: ${plan.accountSid}`,
    `source_number: ${plan.sourceNumber} (${plan.sourceNumberSid})`,
    `trunk_name: ${plan.trunkName}`,
    `trunk: ${plan.trunkSid ?? "none yet"}`,
    `trunk_address: ${plan.trunkAddress ?? "minted on apply"}`,
    "buys_a_number: no",
    ...plan.steps.map((step) => `plan: ${step.action} ${step.detail}`),
  ];
}

function nonSecretFacts(plan: CarrierPlan): Record<string, string | null> {
  return {
    account_sid: plan.accountSid,
    source_number: plan.sourceNumber,
    source_number_sid: plan.sourceNumberSid,
    trunk_name: plan.trunkName,
  };
}

/**
 * A number as a carrier means it. Whitespace and the punctuation people write
 * numbers with are removed; nothing else is guessed at, because a number egma
 * corrected into a different number is a call to a stranger.
 */
function normalizeNumber(given: string): string {
  return given.replace(/[\s()\-.]/g, "");
}

/** Whether a directory looks like a platform workspace, without throwing. */
export function isPlatformWorkspace(directory: string): boolean {
  try {
    return existsSync(path.join(findWorkspace(directory), PLATFORM_DIRECTORY)) || true;
  } catch {
    return false;
  }
}

export { containerOf };
