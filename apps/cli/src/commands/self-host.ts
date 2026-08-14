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
 *   Redis. There is no phone overlay to ask for by name any more. It also
 *   prepares the workspace: a workspace with no media-server credential is
 *   given one, generated here and written beside the other bootstrap
 *   variables, so that no deployment runs on a pair anyone can read.
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

import path from "node:path";

import { compose, DockerMissingError, type ComposeOptions } from "../self-host/compose.ts";
import {
  mediaCredential,
  recorded,
  MEDIA_SECRET_VARIABLE,
} from "../self-host/media-credential.ts";
import {
  askPlainly,
  askSecret,
  asStop,
  keyHint,
  NoAnswerError,
  StoppedError,
  PLAIN_VARIABLES,
  REFUSED_SECRET_ARGUMENTS,
  SECRET_VARIABLES,
  secretArgumentRefusal,
  type AskOptions,
} from "../self-host/protected-input.ts";
import {
  fileReceipt,
  SecretInReceiptError,
  sweptOf,
  type Receipt,
} from "../self-host/receipt.ts";
import {
  applyCarrier,
  ARTIFACT_NAME,
  CarrierError,
  planCarrier,
  TWILIO_API_ROOT,
  TWILIO_TRUNKING_ROOT,
  type CarrierPlan,
  type CarrierStep,
} from "../self-host/twilio.ts";
import {
  findWorkspace,
  NoPlatformWorkspaceError,
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

/**
 * Every service `self-host up` starts, in the order somebody would look for
 * them. Named in full rather than summarised: five of these — the object
 * store, the simulator, the grader, the SIP gateway and its Redis — publish
 * nothing and have no page to visit, so a line naming them is the only sign a
 * person gets that they are running at all.
 *
 * The one-shot job that creates the object store's bucket is deliberately not
 * here. It runs and exits, so a person who went looking for it would find
 * nothing running and read that as something broken.
 */
const STARTED = [
  "postgres",
  "clickhouse",
  "minio",
  "api",
  "web",
  "simulator",
  "grader",
  "livekit",
  "livekit-sip",
  "livekit-redis",
] as const;

/** Which services phone configuration reaches, and therefore what is recreated. */
const PHONE_SERVICES = ["api", "simulator", "grader"] as const;

/**
 * The three that authenticate each other with the media credential.
 *
 * Recreated together whenever that pair is minted, because a container keeps
 * the environment it was created with: replacing one of the three and not the
 * others leaves a deployment where two halves of one password disagree, and
 * every phone simulation fails to authenticate with nothing on screen to say
 * why.
 */
const MEDIA_SERVICES = ["livekit", "livekit-sip", "simulator"] as const;

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

/**
 * What a self-host command was asked to do.
 *
 * Parsed here rather than by filtering out anything beginning with a dash,
 * which is what this used to do and which was wrong in a way that took the one
 * escape hatch away from the person who needed it most: the *value* of
 * `--cwd /tmp/ws` does not begin with a dash, so it was read as part of the
 * verb and `egma self-host up --cwd /tmp/ws` answered "does not know
 * 'up /tmp/ws'" — while the refusal for not being in a platform workspace was
 * telling people to use `--cwd`.
 *
 * Both spellings, because both are ordinary: `--cwd X` is what a person types
 * and `--cwd=X` is what a script generates, and an option that silently does
 * nothing in one of them is worse than one that does not exist.
 */
export type SelfHostInvocation = {
  readonly verb: string;
  readonly cwd: string | null;
  readonly planOnly: boolean;
  readonly approved: boolean;
  readonly asJson: boolean;
  /** Options this command does not know, by name only — never their value. */
  readonly unknown: readonly string[];
};

const VALUED_OPTIONS = ["--cwd"] as const;
const FLAGS = ["--plan", "--apply", "--yes", "--json"] as const;

export function parseSelfHostArgs(argv: readonly string[]): SelfHostInvocation {
  const words: string[] = [];
  const unknown: string[] = [];
  let cwd: string | null = null;
  const flags = new Set<string>();

  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index] as string;
    if (!argument.startsWith("-")) {
      words.push(argument);
      continue;
    }
    const split = argument.indexOf("=");
    const name = split === -1 ? argument : argument.slice(0, split);
    const attached = split === -1 ? null : argument.slice(split + 1);

    if ((VALUED_OPTIONS as readonly string[]).includes(name)) {
      // `--cwd=X` carries its value; `--cwd X` takes the next word, and that
      // word is consumed here so it can never be read as part of the verb.
      const value = attached ?? argv[(index += 1)] ?? null;
      // An option that eats the next option is the quiet kind of wrong:
      // `--plan --cwd --json` would swallow `--json` and print plain output to
      // a script that asked for a document. Nothing here takes a value that
      // begins with a dash; a missing one, and an empty `--cwd=`, are refused
      // by name like every other bad option rather than quietly falling back
      // to whichever directory the command happened to be run in.
      if (value === null || value === "" || value.startsWith("-")) {
        unknown.push(name);
        continue;
      }
      cwd = value;
      continue;
    }
    if ((FLAGS as readonly string[]).includes(name)) {
      flags.add(name);
      continue;
    }
    unknown.push(name);
  }

  return {
    verb: words.join(" "),
    cwd,
    planOnly: flags.has("--plan") && !flags.has("--apply"),
    approved: flags.has("--yes"),
    asJson: flags.has("--json"),
    unknown,
  };
}

export async function runSelfHostCommand(options: SelfHostOptions): Promise<number> {
  const leaked = REFUSED_SECRET_ARGUMENTS.find((refused) =>
    options.argv.some((argument) => argument === refused || argument.startsWith(`${refused}=`)),
  );
  if (leaked !== undefined) {
    options.fail(secretArgumentRefusal(leaked));
    return SELF_HOST_EXIT.refused;
  }

  const invocation = parseSelfHostArgs(options.argv);
  if (invocation.unknown.length > 0) {
    // Only the name is said back. Something written as `--thing=value` may be
    // carrying anything, and a refusal is no place to print it.
    options.fail(
      `egma self-host does not know the option ${invocation.unknown[0] as string}. ` +
        "Run egma --help to see the ones it does.",
    );
    return SELF_HOST_EXIT.noWorkspace;
  }
  const verb = invocation.verb;

  try {
    if (verb === "up") return await runUp(options, invocation);
    if (verb === "phone setup") return await runPhoneSetup(options, invocation);
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
    if (error instanceof SecretInReceiptError) {
      // The sweep fired. Nothing was written and nothing was printed, and
      // saying so in a sentence matters more here than anywhere: a stack trace
      // over a leak reads as "egma is broken and may have leaked", when what
      // happened is the opposite — a guard caught something before it left.
      options.out("status: refused");
      options.out("changed: nothing");
      options.fail(error.message);
      return SELF_HOST_EXIT.refused;
    }
    if (error instanceof StoppedError) {
      // Ctrl-C at a question. The most likely first-run interaction in the
      // whole command is "I do not have my token to hand", and it used to end
      // in a Node stack trace — which reads as a bug in egma at the moment
      // somebody was being careful. Nothing was written, and this says so.
      options.out("status: stopped");
      options.out("changed: nothing");
      options.fail("Stopped. Nothing was written, here or at your carrier.");
      return SELF_HOST_EXIT.interrupted;
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

async function runUp(
  options: SelfHostOptions,
  invocation: SelfHostInvocation,
): Promise<number> {
  const workspace = findWorkspace(invocation.cwd ?? options.cwd);
  const stored = readPlatformConfig(workspace);

  // One address, decided here. The environment wins because a deployment
  // reached on a LAN address says so there; the stored configuration is next,
  // so a platform set up once keeps its address; the compose default is last.
  const address =
    options.env.EGMA_BASE_URL?.trim() ||
    stored.EGMA_BASE_URL?.trim() ||
    DEFAULT_PLATFORM_ADDRESS;

  options.out(`workspace: ${workspace}`);
  options.out(`url: ${address}`);

  // The media credential: whatever this workspace or its operator already has,
  // and a fresh one where neither has any.
  //
  // **Written down whenever the file does not already say it**, which covers
  // one more case than generating does. A pair only exported into a shell is a
  // pair the next start cannot find, and the start after that would mint a
  // third one and lock the deployment out of itself. The file is the record of
  // what this deployment runs on, however the value first arrived.
  const media = mediaCredential(options.env, stored);
  if (!recorded(media, stored)) {
    try {
      writePlatformConfig(workspace, { ...stored, ...media.values });
    } catch (cause) {
      options.out("status: failed");
      options.out(
        `reason: this workspace has no media-server credential and egma could not write one: ${
          (cause as Error).message
        }`,
      );
      return SELF_HOST_EXIT.refused;
    }
  }
  options.out(`media_credential: ${media.generated ? "generated" : "existing"}`);
  if (media.generated) for (const line of MEDIA_CREDENTIAL_NOTICE) options.fail(line);

  const environment: Record<string, string> = {
    ...stored,
    ...media.values,
    EGMA_BASE_URL: address,
  };
  const composeOptions: ComposeOptions = {
    workspace,
    environment,
    signal: options.signal,
    onLine: (line) => options.fail(line),
  };

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
  options.out(`services: ${STARTED.join(" ")}`);
  options.out(`phone: ${platform.phoneState}`);
  if (platform.phoneMissing.length > 0) {
    options.out(`phone_missing: ${platform.phoneMissing.join(", ")}`);
  }
  options.out("status: ready");
  options.out(`connect: npx @egma/cli --url ${address}`);

  options.fail("");
  options.fail(`egma is running at ${address}`);
  options.fail(
    platform.phoneState === "ready"
      ? "Phone simulations are set up."
      : "Phone simulations need one more command here: egma self-host phone setup",
  );
  options.fail("");
  options.fail("In your agent repository, once:");
  options.fail(`  npx @egma/cli --url ${address}`);
  return SELF_HOST_EXIT.ok;
}

/**
 * What the operator is told when a media credential was minted for them.
 *
 * **The second half is the part that has to be said.** A deployment that was
 * already running was running on a pair published in egma's own repository,
 * and this start replaces its media containers. That is a security fact its
 * operator is entitled to hear plainly rather than infer from containers
 * restarting — and it is written as a condition the reader resolves rather
 * than as a guess made here, because nothing in this workspace reliably says
 * whether a deployment has been up before.
 */
const MEDIA_CREDENTIAL_NOTICE = [
  "A media-server credential was generated for this workspace and written to " +
    ".egma-platform/platform.env. It is egma's own password between its media " +
    "server, its simulator and its SIP gateway: you never choose it and never " +
    "type it, and a pair that exists is never replaced. Keep that file wherever " +
    "the rest of this deployment's secrets live.",
  "Until this, all three fell back to a pair published in egma's own repository. " +
    "If this deployment was already running, that is what it was using, and its " +
    "media containers are replaced by this start.",
] as const;

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

async function runPhoneSetup(
  options: SelfHostOptions,
  invocation: SelfHostInvocation,
): Promise<number> {
  const workspace = findWorkspace(invocation.cwd ?? options.cwd);
  const mode = invocation;
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
  const authAnswer = await askSecret(
    "twilio-auth-token",
    "Twilio Auth Token (used by this command only, never kept)",
    ask,
  );
  const openaiAnswer = await askSecret(
    "openai-api-key",
    "OpenAI API key (the persona's voice, its ears, its words and the default judge)",
    ask,
  );
  const authToken = authAnswer.value;
  const openaiKey = openaiAnswer.value;

  // Which key this is about to configure the whole platform with, and where it
  // came from. `OPENAI_API_KEY` is a variable most developers already export,
  // so a run that reads it asks nothing and looks exactly like a run that was
  // told — and a stale exported key surfaces an hour later as a provider
  // refusing every turn rather than as a mistake anybody could see being made.
  const credentialSources = {
    twilio_auth_token_from: authAnswer.from,
    openai_key_from: openaiAnswer.from,
    openai_key_hint: keyHint(openaiKey),
  } as const;

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

  // In JSON mode the plan is not printed yet: standard output carries exactly
  // one document, at the end, so that a coding agent can parse the whole answer
  // rather than pick a document out of a stream of lines. In the plain mode a
  // person is reading, so the plan goes up as soon as it is known — they are
  // about to be asked to approve it.
  if (!mode.asJson) for (const line of planDocument) options.out(line);

  const planFacts = {
    command: "self-host phone setup",
    ...credentialSources,
    account_sid: plan.accountSid,
    source_number: plan.sourceNumber,
    source_number_sid: plan.sourceNumberSid,
    trunk_name: plan.trunkName,
    trunk_sid: plan.trunkSid,
    trunk_address: plan.trunkAddress,
    buys_a_number: false,
    steps: plan.steps,
  } as const;

  if (mode.planOnly) {
    // **No receipt, and no file of any kind.** Planning reads provider state
    // and changes neither provider nor local state — a receipt is local state,
    // and one written here made `"changed": "nothing"` and a path to a file
    // that had just been created two fields of the same answer. It was also
    // what created `.egma-platform` at the default mode, before the write that
    // makes it private ever ran.
    answer(
      options,
      mode,
      { ...planFacts, mode: "plan", status: "planned", changed: "nothing" },
      secrets,
    );
    return SELF_HOST_EXIT.ok;
  }

  if (!mode.approved) {
    const approved = await askApproval(options, ask);
    if (!approved) {
      answer(
        options,
        mode,
        { ...planFacts, mode: "apply", status: "not_approved", changed: "nothing" },
        secrets,
      );
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

  // The media credential, made here only if neither this command's environment
  // nor the workspace already has one. In the ordinary order `up` has already
  // made it: this command waits on a running platform, and a running platform
  // was started by `up`. What this covers is a deployment brought up before
  // egma generated the pair at all, whose first act after upgrading is carrier
  // setup. The write below records it either way.
  const media = mediaCredential(options.env, stored);

  const configuration: Record<string, string> = {
    ...stored,
    ...media.values,
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

  // **The one window this command cannot make atomic, made legible instead.**
  //
  // Twilio has already accepted a new SIP password by the time this runs, and
  // it accepts only that one — the old password stopped working the moment the
  // rotation landed. If this write fails, the carrier and this machine disagree
  // about the credential, and the symptom is every outbound call failing
  // authentication with nothing on screen to explain it.
  //
  // There is no transaction across a carrier's API and a local file, and
  // reordering does not help: writing first would leave a password here that
  // Twilio never accepted. So the failure is caught and named, and the recovery
  // is stated — running setup again mints another password and writes both ends
  // together, which is the whole repair.
  let configFile: string;
  try {
    configFile = writePlatformConfig(workspace, configuration);
  } catch (cause) {
    throw new CarrierError(
      `Twilio accepted a new SIP password for ${applied.sipUsername}, and this machine could not write it down: ${(cause as Error).message}. The carrier now accepts only a password that is not saved here, so calls would fail to authenticate. Run \`egma self-host phone setup\` again — it mints another password and writes both ends together. Nothing was charged and no call was placed.`,
    );
  }

  const composeOptions: ComposeOptions = {
    workspace,
    environment: configuration,
    signal: options.signal,
    onLine: (line) => options.fail(line),
  };

  // Activate it. Recreating rather than restarting, because a container keeps
  // the environment it was created with and a restart would come back with the
  // configuration it did not have.
  //
  // The media three join the phone three when this run minted the media
  // credential, for exactly the same reason one step down: recreating the
  // simulator on a new pair while the media server keeps the old one is a
  // deployment whose parts no longer authenticate each other.
  const recreating = media.generated
    ? [...new Set([...PHONE_SERVICES, ...MEDIA_SERVICES])]
    : [...PHONE_SERVICES];
  const recreated = await compose(
    ["up", "-d", "--wait", "--wait-timeout", "300", "--force-recreate", ...recreating],
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
      openai_key_hint: credentialSources.openai_key_hint,
      openai_key_from: credentialSources.openai_key_from,
      configuration_file: path.relative(workspace, configFile),
      platform_url: address,
      phone_state: readiness ?? "unknown",
      // Said and never shown, exactly like the SIP password above.
      media_credential: media.generated ? "generated" : "existing",
    },
    steps: applied.steps.map((step) => `${step.action}: ${step.detail}`),
  };
  // The media secret joins the swept set even though nothing prints it. The
  // sweep is a guard rather than a review habit, and a guard that covers only
  // the secrets somebody remembered is the wrong half of one.
  const allSecrets = [
    ...secrets,
    applied.sipPassword,
    media.values[MEDIA_SECRET_VARIABLE] as string,
  ];
  const receiptFile = fileReceipt(workspace, receipt, allSecrets);

  const done = {
    ...planFacts,
    mode: "apply",
    trunk_sid: applied.trunkSid,
    trunk_address: applied.trunkAddress,
    steps: applied.steps,
    configuration: path.relative(workspace, configFile),
    receipt: path.relative(workspace, receiptFile),
    platform_url: address,
    phone: readiness ?? "unknown",
    media_credential: media.generated ? "generated" : "existing",
  } as const;

  if (readiness !== "ready") {
    answer(
      options,
      mode,
      {
      ...done,
      status: "failed",
      reason:
        "the carrier is set up and the configuration is written, but this " +
        "platform did not come back reporting phone readiness. Run the same command " +
        "again — it reuses everything it made and creates no second copy of anything.",
      },
      allSecrets,
    );
    return SELF_HOST_EXIT.refused;
  }

  answer(options, mode, { ...done, status: "ready" }, allSecrets);
  options.fail("");
  if (media.generated) for (const line of MEDIA_CREDENTIAL_NOTICE) options.fail(line);
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
  } catch (stopped) {
    // Ctrl-C over the approval question is the same stop as Ctrl-C over any
    // other, and nothing has been written to the carrier at this point.
    throw asStop(stopped);
  } finally {
    asked.close();
  }
}

/**
 * The command's answer, in whichever shape was asked for.
 *
 * **Standard output carries exactly one JSON document in JSON mode**, and
 * nothing else — no lines before it and none after. A document with two plain
 * lines stuck on the end is not JSON, and a coding agent driving this would
 * have to go back to parsing terminal text, which is the whole thing the mode
 * exists to avoid. The story a person reads is the same facts as lines, and
 * anything conversational is on standard error either way.
 */
function answer(
  options: SelfHostOptions,
  mode: SelfHostInvocation,
  facts: Readonly<Record<string, unknown>>,
  /**
   * The secrets this command is holding. Every answer is swept before it is
   * written, not only the plan: an asymmetric guard in a module whose whole
   * argument is that the guard is not a review habit is a guard that will
   * eventually be the wrong half.
   */
  secrets: readonly (string | undefined)[] = [],
): void {
  if (mode.asJson) {
    const document = JSON.stringify(facts, null, 2);
    sweptOf(document, secrets);
    options.out(document);
    return;
  }
  sweptOf(
    Object.entries(facts)
      .map(([name, value]) => `${name}: ${JSON.stringify(value)}`)
      .join("\n"),
    secrets,
  );
  for (const [name, value] of Object.entries(facts)) {
    if (name === "steps") {
      for (const step of value as readonly CarrierStep[]) {
        options.out(`${mode.planOnly ? "plan" : "did"}: ${step.action} ${step.detail}`);
      }
      continue;
    }
    if (name === "command" || name === "mode") continue;
    options.out(`${name}: ${String(value)}`);
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
