/**
 * `egma self-host`: the platform operator's half of the CLI.
 *
 * One CLI, two contexts. The bare wizard and `connect`, `pull`, `push` and
 * `run` operate an *agent repository* — tests, and the address of the platform
 * that owns their identifiers. Everything under `self-host` operates a
 * *platform workspace* — the deployment itself, its containers, and the carrier
 * route that belongs to whoever runs it. On one laptop that
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
 * - **`setup`** configures the deployment's carrier route. It asks what route
 *   the platform holds, collects one complete bundle when needed, and writes
 *   it through the platform's own API. It never receives account-wide Twilio
 *   credentials or changes Twilio.
 *
 * **Nothing here seals anything.** The platform owns the carrier route and
 * seals it in its store. This CLI writes only the bootstrap variables a
 * container reads when it is created. See `BOOTSTRAP_VARIABLES`.
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

import { credentialsFileIn, UnusableUrlError } from "../platform/credentials.ts";
import { PlatformUnreachableError } from "../platform/device-flow.ts";
import { normalizePlatformOrigin } from "../platform/identity.ts";
import { signedInAt } from "../platform/signed-in.ts";
import {
  compose,
  DockerMissingError,
  missingRequiredVariable,
  type ComposeOptions,
} from "../self-host/compose.ts";
import {
  recordMediaCredential,
  MEDIA_SECRET_VARIABLE,
  type MediaCredential,
} from "../self-host/media-credential.ts";
import {
  askOptionally,
  askPlainly,
  askSecret,
  CARRIER_VARIABLES,
  NoAnswerError,
  StoppedError,
  REFUSED_SECRET_ARGUMENTS,
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
  NotSignedInError,
  PlatformRefusedError,
  readSettings,
  writeSettings,
  type PlatformSettingsAccess,
} from "../self-host/settings.ts";
import {
  bootstrapVariables,
  findWorkspace,
  NoPlatformWorkspaceError,
  PLATFORM_CONFIG_FILE,
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
  /**
   * This machine holds no key for the platform being set up.
   *
   * Its own ending because the move it asks for is its own: `egma login`, once,
   * against this platform. Every answer setup collects is written through the
   * platform's API — which is what keeps the API the only thing that seals —
   * and that door opens for an organization owner and for nobody else.
   */
  notSignedIn: 3,
  /** The platform refused, or setup could not finish, and said why. */
  refused: 4,
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
  /** Deliberate recovery: replace all four held carrier values together. */
  readonly replaceCarrier: boolean;
  /** Explicit confirmation for the recovery-only replacement above. */
  readonly confirmed: boolean;
  readonly asJson: boolean;
  /** Options this command does not know, by name only — never their value. */
  readonly unknown: readonly string[];
};

const VALUED_OPTIONS = ["--cwd"] as const;
const FLAGS = [
  "--plan",
  "--yes",
  "--json",
  "--replace-carrier",
] as const;

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
    planOnly: flags.has("--plan"),
    replaceCarrier: flags.has("--replace-carrier"),
    confirmed: flags.has("--yes"),
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
    if (verb === "setup") return await runSetup(options, invocation);
  } catch (error) {
    // Three ways this command cannot start at all: the directory is not a
    // platform workspace, there is no docker, or the address it was given is
    // not an address. Each is answered before anything is contacted.
    if (
      error instanceof NoPlatformWorkspaceError ||
      error instanceof DockerMissingError ||
      error instanceof UnusableUrlError
    ) {
      options.out(`status: refused\nreason: ${error.message}`);
      options.fail(error.message);
      return SELF_HOST_EXIT.noWorkspace;
    }
    if (error instanceof NoAnswerError) {
      options.out(`status: refused\nreason: ${error.message}`);
      options.fail(error.message);
      return SELF_HOST_EXIT.noAnswer;
    }
    if (error instanceof NotSignedInError) {
      options.out(`status: refused\nreason: ${error.message}`);
      options.fail(error.message);
      return SELF_HOST_EXIT.notSignedIn;
    }
    // Not answering and answering "no" are different problems with different
    // next moves — start your platform, against you are signed in as somebody
    // who may not do this — so both are named rather than collapsed into one
    // sentence about setup failing.
    if (error instanceof PlatformUnreachableError || error instanceof PlatformRefusedError) {
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
      options.fail("Stopped. Nothing was written.");
      return SELF_HOST_EXIT.interrupted;
    }
    throw error;
  }

  options.fail(
    `egma self-host does not know ${verb === "" ? "that" : `"${verb}"`}. It knows:\n` +
      "  egma self-host up      Start the whole platform.\n" +
      "  egma self-host setup   Configure its carrier route.",
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
  // Only the closed bootstrap list reaches a container.
  const boot = bootstrapVariables(stored);

  // One address, decided here. The environment wins because a deployment
  // reached on a LAN address says so there; what the workspace recorded is
  // next, so a platform set up once keeps its address; the compose default is
  // last.
  const address =
    options.env.EGMA_BASE_URL?.trim() || boot.EGMA_BASE_URL?.trim() || DEFAULT_PLATFORM_ADDRESS;

  options.out(`workspace: ${workspace}`);
  options.out(`url: ${address}`);

  // The media credential: whatever this workspace or its operator already has,
  // and a fresh one where neither has any. Recorded before anything is started,
  // and read back off the disk, so what the containers are handed below is what
  // the next start will find.
  let media: MediaCredential;
  try {
    media = await recordMediaCredential(workspace, options.env);
  } catch (cause) {
    options.out("status: failed");
    options.out(
      `reason: this workspace has no media-server credential and Egma could not write one: ${
        (cause as Error).message
      }`,
    );
    return SELF_HOST_EXIT.refused;
  }
  options.out(`media_credential: ${media.generated ? "generated" : "existing"}`);
  if (media.generated) for (const line of MEDIA_CREDENTIAL_NOTICE) options.fail(line);

  const environment: Record<string, string> = {
    ...boot,
    ...media.values,
    EGMA_BASE_URL: address,
  };
  const composeOptions: ComposeOptions = {
    workspace,
    environment,
    signal: options.signal,
    onLine: (line) => options.fail(line),
  };

  function refuseMissingVariable(missing: string): number {
    options.out("status: failed");
    options.out(
      `reason: ${missing} has no value, and this deployment deliberately has no ` +
        "default for it. It is one of the secrets or addresses Egma cannot invent " +
        "for you, so nothing was started at all rather than started on a value " +
        "published in this repository. Set it in .env in this workspace — the line " +
        "above says what makes one — and run this again.",
    );
    return SELF_HOST_EXIT.refused;
  }

  // This workspace is a source checkout. Build its services before Compose
  // starts them, so pulling new egma code cannot restart containers made from
  // the previous checkout. This is separate from `up`: a Dockerfile, registry
  // or disk failure is a build failure and must not be retried or described as
  // a store doing its first boot. Compose keeps its normal layer cache, and
  // services that only name a published image are not built.
  const built = await compose(["build"], composeOptions);
  const missingWhileBuilding = missingRequiredVariable(built);
  if (missingWhileBuilding !== null) {
    return refuseMissingVariable(missingWhileBuilding);
  }
  if (built.code !== 0) {
    options.out("status: failed");
    options.out(
      "reason: docker compose could not build the platform images. What it printed " +
        "above names the Dockerfile, registry or local runtime problem. No service " +
        "was started, and this command is safe to run again once it is fixed.",
    );
    return SELF_HOST_EXIT.refused;
  }

  const start = ["up", "-d", "--wait", "--wait-timeout", "300"] as const;

  // Twice, on a workspace that has never been started. ClickHouse's own
  // entrypoint starts a server, creates the database, stops it and starts the
  // real one — and its health check answers during the first of those, so the
  // API can be released to connect to a server that is on its way down. It
  // exits, compose reports a dependency failure, and a second `up` succeeds
  // against the stores that now exist. Measured on a clean workspace here, so
  // this is not defensive coding: it is the first run, and a first run that
  // fails once and works when you type the same thing again is a product that
  // taught its first user to distrust it.
  let started = await compose(start, composeOptions);
  // Asked before the retry, because the two failures look alike and want
  // opposite answers. A missing bootstrap variable is refused while Compose is
  // still reading the file — nothing was created, and a second attempt would
  // invent no value the first one lacked — so it is reported by name here
  // rather than dressed up as a store that would not start, which would send
  // an operator reading container logs for a variable they never set.
  const missing = missingRequiredVariable(started);
  if (missing !== null) {
    return refuseMissingVariable(missing);
  }
  if (started.code !== 0) {
    options.fail(
      "one of the services did not come up on the first try. That is usual on a " +
        "workspace that has never been started, because a store's first boot " +
        "creates its database and restarts itself. Trying once more.",
    );
    started = await compose(start, composeOptions);
  }
  if (started.code !== 0) {
    options.out("status: failed");
    options.out(
      "reason: docker compose could not bring the platform up, twice. What it printed " +
        "above names the service that would not start; `docker compose logs` on that " +
        "service in this workspace says why. Nothing here is half-done — this command " +
        "is safe to run again once it is fixed.",
    );
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
  options.fail(`Egma is ready at ${address}`);
  if (platform.phoneState === "ready") {
    options.fail(
      "Phone calls are ready. The carrier route stays configured through a restart, an upgrade and a move to another machine.",
    );
  } else {
    options.fail(
      "Chat simulations can run now. Phone calls are optional and are not ready yet.",
    );
    // **The whole optional phone step, not just its last command.** Setup
    // writes the carrier route through the platform's own API, and that door
    // opens for an organization owner.
    options.fail(
      `Phone is missing ${
        platform.phoneMissing.length === 0
          ? "its carrier route"
          : platform.phoneMissing.join(", ")
      }.`,
    );
    options.fail(
      `Sign up at ${address} if you have not. The first person to sign up on a fresh Egma becomes its owner. Then run:`,
    );
    options.fail(`  npx @egma/cli login --url ${address}`);
    options.fail("  npx @egma/cli self-host setup");
  }
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
    ".egma-platform/platform.env. It is Egma's own password between its media " +
    "server, its simulator and its SIP gateway: you never choose it and never " +
    "type it, and a pair that exists is never replaced. Keep that file wherever " +
    "the rest of this deployment's secrets live.",
  "Until this, all three fell back to a pair published in Egma's own repository. " +
    "If this deployment was already running, that is what it was using, and its " +
    "media containers are replaced by this start.",
] as const;

/**
 * What an operator is told when the media containers did not come back.
 *
 * Written once because two endings say it, and said as a failure rather than as
 * a note beside a success: this machine now records a media credential that the
 * running containers do not hold, and every phone simulation would fail to
 * authenticate with nothing on screen to explain it.
 */
const MEDIA_DID_NOT_COME_BACK =
  "a media-server credential was generated and written down, and the three containers " +
  "that authenticate each other with it did not come back. What is recorded here and " +
  "what is running now disagree, so a phone simulation would fail to authenticate. " +
  "The settings themselves are safely stored. Run egma self-host up, which hands the " +
  "recorded pair to those containers and is safe to run again.";

type PlatformFacts = {
  readonly instanceId: string;
  readonly origin: string;
  /** Whether this otherwise-ready platform can place a phone call. */
  readonly phoneState: "ready" | "setup_required";
  readonly phoneMissing: readonly string[];
};

type Readiness = { readonly state?: unknown; readonly missing?: unknown };

function readinessIn(reported: Readiness | undefined): {
  state: "ready" | "setup_required";
  missing: readonly string[];
} | null {
  const missing = reported?.missing;
  if (
    (reported?.state !== "ready" && reported?.state !== "setup_required") ||
    !Array.isArray(missing) ||
    !missing.every((one) => typeof one === "string") ||
    (reported.state === "ready" && missing.length > 0) ||
    (reported.state === "setup_required" && missing.length === 0)
  ) {
    return null;
  }
  return {
    state: reported.state,
    missing,
  };
}

async function readPlatform(address: string): Promise<PlatformFacts | null> {
  try {
    const answer = await fetch(`${address}${PLATFORM_IDENTITY_PATH}`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!answer.ok) return null;
    const body = (await answer.json()) as {
      instance_id?: unknown;
      origin?: unknown;
      phone?: Readiness;
    };
    if (typeof body.instance_id !== "string" || typeof body.origin !== "string") return null;
    const phone = readinessIn(body.phone);
    if (phone === null) return null;
    return {
      instanceId: body.instance_id,
      origin: body.origin,
      phoneState: phone.state,
      phoneMissing: phone.missing,
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

// -- setup --------------------------------------------------------------------

type CarrierBundleValues =
  | Readonly<{
      carrier_trunk_address: string;
      carrier_trunk_number: string;
      carrier_trunk_username?: never;
      carrier_trunk_password?: never;
    }>
  | Readonly<{
      carrier_trunk_address: string;
      carrier_trunk_number: string;
      carrier_trunk_username: string;
      carrier_trunk_password: string;
    }>;

const CARRIER_SETTING_NAMES = [
  "carrier_trunk_address",
  "carrier_trunk_number",
  "carrier_trunk_username",
  "carrier_trunk_password",
] as const satisfies readonly (keyof CarrierBundleValues)[];

type ExportedCarrierBundle =
  | { readonly kind: "absent" }
  | { readonly kind: "incomplete"; readonly missing: readonly string[] }
  | { readonly kind: "complete"; readonly values: CarrierBundleValues };

/**
 * This deployment's stable runtime carrier bundle.
 *
 * Every developer may use a different SIP username and password on the same
 * account, trunk and credential list. The bundle lives outside the disposable
 * database, so a reset copies it again. A source-IP carrier needs the address
 * and source number. A credential carrier needs those two values plus both SIP
 * credential values. Any other shape is incomplete: combining a trunk from one
 * route with a credential from another would fail every phone simulation.
 */
function exportedCarrierBundleIn(
  environment: NodeJS.ProcessEnv,
): ExportedCarrierBundle {
  const trunkAddress = environment[CARRIER_VARIABLES.trunkAddress]?.trim() ?? "";
  const sourceNumber = environment[CARRIER_VARIABLES.sourceNumber]?.trim() ?? "";
  const sipUsername = environment[CARRIER_VARIABLES.sipUsername]?.trim() ?? "";
  const sipPassword = environment[CARRIER_VARIABLES.sipPassword]?.trim() ?? "";

  if (
    trunkAddress === "" &&
    sourceNumber === "" &&
    sipUsername === "" &&
    sipPassword === ""
  ) {
    return { kind: "absent" };
  }

  const missing = [
    [CARRIER_VARIABLES.trunkAddress, trunkAddress],
    [CARRIER_VARIABLES.sourceNumber, sourceNumber],
  ]
    .filter((entry) => entry[1] === "")
    .map((entry) => entry[0] as string);
  const credentialSupplied = sipUsername !== "" || sipPassword !== "";
  if (credentialSupplied && sipUsername === "") {
    missing.push(CARRIER_VARIABLES.sipUsername);
  }
  if (credentialSupplied && sipPassword === "") {
    missing.push(CARRIER_VARIABLES.sipPassword);
  }
  if (missing.length > 0) return { kind: "incomplete", missing };

  return {
    kind: "complete",
    values: credentialSupplied
      ? {
          carrier_trunk_address: trunkAddress,
          carrier_trunk_number: normalizeNumber(sourceNumber),
          carrier_trunk_username: sipUsername,
          carrier_trunk_password: sipPassword,
        }
      : {
          carrier_trunk_address: trunkAddress,
          carrier_trunk_number: normalizeNumber(sourceNumber),
        },
  };
}

/**
 * `egma self-host setup`: the carrier-route setup command.
 *
 * **It asks the platform what carrier route it holds.** A complete route is
 * left alone. A missing route is written as one complete bundle.
 *
 * **Every answer is written through the API.** Nothing here seals, nothing here
 * holds an encryption key, and nothing here writes a setting to a file. That is
 * the reversal this work makes: the route lives in the platform store, not in
 * a file only this CLI reads.
 *
 * **Everything is asked before anything is written.** An operator can gather
 * what they need before they start — `--plan` prints exactly that list — and a
 * decline or a Ctrl-C part way through leaves both the platform and the carrier
 * exactly as they were.
 *
 * The carrier half is a complete route: trunk address and source number for
 * source-IP authentication, plus SIP username and password for credential
 * authentication. A developer can have their own credential on the same Twilio
 * trunk as production. Setup copies the route into the platform and never
 * receives account-wide Twilio authority or changes Twilio state.
 */
async function runSetup(
  options: SelfHostOptions,
  invocation: SelfHostInvocation,
): Promise<number> {
  const workspace = findWorkspace(invocation.cwd ?? options.cwd);
  const mode = invocation;
  const stored = readPlatformConfig(workspace);
  // The one door between that file and a container. See `BOOTSTRAP_VARIABLES`.
  const boot = bootstrapVariables(stored);
  const ask: AskOptions = {
    env: options.env,
    input: options.stdin,
    output: options.stdout,
    signal: options.signal,
  };

  // **One shape for this address, decided before anything is keyed on it.**
  // The keys this machine holds are filed under a *normalized* origin, so an
  // address spelled any other way — a trailing slash, an upper-case host, an
  // explicit `:443` — looks up nothing, and setup would refuse an owner who is
  // signed in and refuse them again after they logged in a second time. Every
  // other verb is handed an origin the platform itself reported; this one
  // starts from a variable somebody typed, so it does the normalizing here.
  const address = platformAddress(
    options.env.EGMA_BASE_URL?.trim() || boot.EGMA_BASE_URL?.trim() || DEFAULT_PLATFORM_ADDRESS,
    options.env.EGMA_BASE_URL?.trim() ? "EGMA_BASE_URL" : "this workspace's recorded address",
  );

  // Where this is happening, for the person reading. Not in JSON mode: standard
  // output carries exactly one document there and nothing else, and two lines
  // in front of it would put a coding agent back to parsing terminal text.
  if (!mode.asJson) {
    options.out(`workspace: ${workspace}`);
    options.out(`url: ${address}`);
  }

  // Who is asking. The carrier-route door opens for an organization owner and
  // nobody else, so setup is a signed-in command.
  // It says which command mints that key rather than failing on a 401 nobody
  // can act on.
  const signedIn = await signedInAt({
    url: address,
    credentialsFile: credentialsFileIn(options.env),
  });
  if (signedIn === null) throw new NotSignedInError(address);
  const access: PlatformSettingsAccess = { url: address, key: signedIn.key };

  const held = await readSettings(access);
  const exportedCarrier = exportedCarrierBundleIn(options.env);
  const heldCarrierNames = new Set(
    held
      .filter((setting) => setting.held)
      .map((setting) => setting.name),
  );
  const heldIpRoute =
    heldCarrierNames.has("carrier_trunk_address") &&
    heldCarrierNames.has("carrier_trunk_number") &&
    !heldCarrierNames.has("carrier_trunk_username") &&
    !heldCarrierNames.has("carrier_trunk_password");
  const heldCredentialRoute = CARRIER_SETTING_NAMES.every((name) =>
    heldCarrierNames.has(name),
  );
  // A complete source-IP route needs no SIP pair. The guided Twilio flow asks
  // for all four values only when no route exists, or when an operator
  // explicitly replaces the route. The API refuses any partial stored route
  // before setup can read it.
  const carrierWanted =
    mode.replaceCarrier ||
    (!heldIpRoute && !heldCredentialRoute);

  /** A source-IP route has two values. A credential route has all four. */
  const configured = !carrierWanted;

  if (mode.planOnly) {
    // What setup would ask for, in the order it would ask, and nothing else. No
    // question, no read of anybody's carrier account and no file: this mode
    // exists so that an operator gathers what they need *before* they start,
    // rather than discovering a missing key one setting at a time.
    answer(options, mode, {
      command: "self-host setup",
      mode: "plan",
      status: configured ? "ready" : "planned",
      asks: carrierWanted
        ? [
            "the SIP trunk address and source number, plus SIP username and password when the carrier requires them",
          ]
        : [],
      holds: held.filter((setting) => setting.held).map((setting) => setting.name),
      platform_url: address,
      changed: "nothing",
    });
    return SELF_HOST_EXIT.ok;
  }

  if (mode.replaceCarrier && !mode.confirmed) {
    answer(options, mode, {
      command: "self-host setup",
      mode: "apply",
      status: "not_confirmed",
      changed: "nothing",
      reason:
        "--replace-carrier replaces the complete stored carrier route. Run the same command with --yes only after the replacement route is ready. For credential authentication, run it only after a carrier administrator has added the replacement credential beside the old one.",
      platform_url: address,
    });
    return SELF_HOST_EXIT.refused;
  }

  if (configured) {
    // Already configured. Nothing is asked, nobody's carrier is read and no
    // setting is written — and that is said rather than left to be inferred
    // from a command that appeared to do something.
    //
    // The media credential is still seen to because it belongs to the
    // workspace, not to the carrier route in the platform store.
    const media = await settleMediaCredential(options, workspace, boot, address);
    answer(options, mode, {
      command: "self-host setup",
      mode: "apply",
      status: media.settled ? "ready" : "incomplete",
      settings_written: [],
      media_credential: media.generated ? "generated" : "existing",
      changed: media.generated ? "the media-server credential" : "nothing",
      platform_url: address,
      ...(media.settled ? {} : { reason: MEDIA_DID_NOT_COME_BACK }),
    });
    if (!media.settled) return SELF_HOST_EXIT.refused;
    options.fail("");
    options.fail(
      "This Egma instance already holds every setting it needs. Nothing was asked and nothing was written.",
    );
    return SELF_HOST_EXIT.ok;
  }

  // -- the interview ----------------------------------------------------------
  //
  // Everything, before anything is written. The route can arrive from the
  // documented environment variables, so a script can drive this unattended.
  const answers: Record<string, string> = {};
  const secrets: string[] = [];

  // -- the carrier ------------------------------------------------------------
  let carrierBundle: CarrierBundleValues | null = null;
  if (carrierWanted) {
    if (exportedCarrier.kind === "complete") {
      carrierBundle = exportedCarrier.values;
    } else if (options.stdin.isTTY !== true) {
      if (exportedCarrier.kind === "incomplete") {
        throw new NoAnswerError(
          "the complete SIP carrier bundle",
          exportedCarrier.missing[0] as string,
        );
      }
      if (mode.replaceCarrier) {
        throw new NoAnswerError(
          "the complete replacement SIP carrier bundle",
          CARRIER_VARIABLES.trunkAddress,
        );
      }
      // A platform without a carrier can still run non-phone simulations. A
      // headless setup with no carrier values reports the route as missing.
    } else {
      const trunkAddress = await askOptionally(
        CARRIER_VARIABLES.trunkAddress,
        "SIP trunk address (Enter to leave the phone half for later)",
        ask,
        null,
      );
      if (trunkAddress !== null && trunkAddress !== "") {
        const sourceNumber = normalizeNumber(
          await askPlainly(
            CARRIER_VARIABLES.sourceNumber,
            "Source phone number, in E.164",
            ask,
          ),
        );
        const sipUsername = await askOptionally(
          CARRIER_VARIABLES.sipUsername,
          "SIP username (Enter for source-IP authentication)",
          ask,
          null,
        );
        if (sipUsername === null || sipUsername === "") {
          carrierBundle = {
            carrier_trunk_address: trunkAddress,
            carrier_trunk_number: sourceNumber,
          };
        } else {
          const sipPassword = await askSecret(
            CARRIER_VARIABLES.sipPassword,
            "SIP password (not shown as you type)",
            ask,
          );
          carrierBundle = {
            carrier_trunk_address: trunkAddress,
            carrier_trunk_number: sourceNumber,
            carrier_trunk_username: sipUsername,
            carrier_trunk_password: sipPassword.value,
          };
        }
      }
    }

    if (carrierBundle !== null) {
      // The complete route moves together. This is the whole database-reset
      // path: copy this developer's stable route into the new platform store.
      // No account-wide Twilio credential is read and Twilio is never contacted.
      Object.assign(answers, carrierBundle);
      if (carrierBundle.carrier_trunk_password !== undefined) {
        secrets.push(carrierBundle.carrier_trunk_password);
      }
    }
  }

  // -- the write --------------------------------------------------------------
  const names = Object.keys(answers);
  if (names.length > 0) await writeSettings(access, answers);

  // The workspace's own credential, seen to only now — after the last question,
  // so that pressing Ctrl-C part way through leaves this machine exactly as it
  // was.
  //
  // The route needs no restart. Only a freshly minted media pair replaces a
  // container.
  const media = await settleMediaCredential(options, workspace, boot, address);

  // Read once rather than waited for. Readiness is built from the store on
  // every request, so the answer is already true the moment the write lands.
  const platform = await readPlatform(address);
  // A held source-IP route makes carrierWanted false before the interview. If
  // no route existed, setup must not call the result ready until a complete
  // two-value or four-value route has been supplied.
  const carrierBundleMissing = carrierWanted && carrierBundle === null;
  const stillMissing = [
    ...(platform?.phoneMissing ?? []),
    ...(carrierBundleMissing ? ["the complete SIP carrier bundle"] : []),
  ];

  const configFile = path.join(PLATFORM_DIRECTORY, PLATFORM_CONFIG_FILE);
  const receipt: Receipt = {
    command: "self-host setup",
    at: new Date().toISOString(),
    result:
      platform?.phoneState === "ready" && !carrierBundleMissing
        ? "applied"
        : "failed",
    facts: {
      settings_written: names.join(", "),
      source_number: carrierBundle?.carrier_trunk_number ?? null,
      trunk_address: carrierBundle?.carrier_trunk_address ?? null,
      sip_username: carrierBundle?.carrier_trunk_username ?? null,
      // Said rather than shown, so that a receipt records that a credential
      // exists without being the second place it exists.
      sip_password:
        carrierBundle?.carrier_trunk_password === undefined
          ? null
          : "supplied, not recorded",
      configuration_file: configFile,
      platform_url: address,
      phone: carrierBundleMissing
        ? "setup_required"
        : (platform?.phoneState ?? "unknown"),
      media_credential: media.generated ? "generated" : "existing",
    },
    steps: [],
  };
  // The media secret joins the swept set even though nothing prints it. The
  // sweep is a guard rather than a review habit, and a guard that covers only
  // the secrets somebody remembered is the wrong half of one.
  const allSecrets = [...secrets, media.values[MEDIA_SECRET_VARIABLE] as string];
  const receiptFile = fileReceipt(workspace, receipt, allSecrets);

  const done = {
    command: "self-host setup",
    mode: "apply",
    // Names only, never values. What was written is the fact; what it was
    // written as is the platform's, sealed, and never comes back out here.
    settings_written: names,
    still_missing: stillMissing,
    carrier_bundle:
      carrierBundle === null
        ? "unchanged"
        : mode.replaceCarrier
          ? "replaced"
          : "supplied",
    receipt: path.relative(workspace, receiptFile),
    platform_url: address,
    phone: carrierBundleMissing
      ? "setup_required"
      : (platform?.phoneState ?? "unknown"),
    media_credential: media.generated ? "generated" : "existing",
  } as const;

  // **Two things can be wrong at once, and the answer says both.** A single
  // sentence chosen by whichever condition was tested first masks the other.
  //
  // The media sentence goes first because it is the silent one. A missing
  // setting is named by the readiness answer on every request and by every
  // `self-host up`; a media pair that disagrees with the running containers is
  // reported by nothing at all, and surfaces minutes later as an authentication
  // refusal naming nothing about configuration.
  const wrong = [
    ...(media.settled ? [] : [MEDIA_DID_NOT_COME_BACK]),
    ...(carrierBundleMissing
      ? [
          `the complete SIP carrier bundle was not supplied. Set ${CARRIER_VARIABLES.trunkAddress}, ${CARRIER_VARIABLES.sourceNumber}, ${CARRIER_VARIABLES.sipUsername}, and ${CARRIER_VARIABLES.sipPassword}, then run setup again`,
        ]
      : []),
    ...(platform === null
      ? [
          `the settings were written but ${address} stopped answering, so Egma cannot say whether phone calls are ready`,
        ]
      : platform.phoneState === "ready"
        ? []
        : [
            `every answer was written and this platform still reports phone setup required. It is missing ${platform.phoneMissing.join(
              ", ",
            )}. Run the same command again — it asks only for what is still absent.`,
          ]),
  ];

  if (wrong.length > 0) {
    answer(
      options,
      mode,
      { ...done, status: "incomplete", reason: wrong.join(" ") },
      allSecrets,
    );
    return SELF_HOST_EXIT.refused;
  }

  answer(options, mode, { ...done, status: "ready" }, allSecrets);
  options.fail("");
  options.fail("Phone calls are ready on this Egma instance.");
  options.fail(
    "Its carrier route lives in the platform store, sealed, so it survives a restart and a move to another machine.",
  );
  if (carrierBundle !== null) {
    options.fail(
      "The SIP carrier values were copied into this platform. Twilio was not contacted or changed.",
    );
  }
  return SELF_HOST_EXIT.ok;
}

/**
 * A media credential this run has finished with, and whether the containers
 * that hold it really came back.
 *
 * **`settled: false` is not a detail to print and carry on from.** The pair is
 * on the disk by the time the recreation runs, so a recreation that failed
 * leaves the recorded pair and the running containers disagreeing — which
 * passes every health check and surfaces minutes later as a media or carrier
 * refusal naming nothing about configuration. That is the exact failure this
 * whole effort exists to remove, so setup does not answer `ready` over it.
 */
type SettledMedia = MediaCredential & { readonly settled: boolean };

/**
 * The one spelling of a platform's address that everything here is keyed on.
 *
 * `normalizePlatformOrigin` is what the credentials file files a key under and
 * what the platform reports about itself, so anything that looks a key up, asks
 * the platform a question, or writes the address down goes through it first.
 * An address it cannot make sense of is refused by naming where it came from —
 * never by printing it, because a rejected address can carry a password.
 */
function platformAddress(given: string, from: string): string {
  try {
    return normalizePlatformOrigin(given);
  } catch {
    throw new UnusableUrlError(from);
  }
}

/**
 * See to this workspace's media-server credential: decide it, write it down,
 * and replace the three containers that hold it when this run is what made it.
 *
 * **In the ordinary order `up` has already done all of this.** Setup still uses
 * the same one-winner step, so a setup racing a start cannot leave the two
 * commands with different pairs.
 *
 * The three are recreated together rather than restarted, because a container
 * keeps the environment it was created with — and replacing one of them and not
 * the others leaves a deployment where two halves of one password disagree and
 * every phone simulation fails to authenticate with nothing on screen to say
 * why.
 */
async function settleMediaCredential(
  options: SelfHostOptions,
  workspace: string,
  boot: Readonly<Record<string, string>>,
  address: string,
): Promise<SettledMedia> {
  const media = await recordMediaCredential(workspace, options.env);
  writePlatformConfig(workspace, {
    ...boot,
    ...media.values,
    EGMA_BASE_URL: address,
  });
  if (!media.generated) return { ...media, settled: true };

  const recreated = await compose(
    ["up", "-d", "--wait", "--wait-timeout", "300", "--force-recreate", ...MEDIA_SERVICES],
    {
      workspace,
      environment: { ...boot, ...media.values, EGMA_BASE_URL: address },
      signal: options.signal,
      onLine: (line) => options.fail(line),
    } satisfies ComposeOptions,
  );
  for (const line of MEDIA_CREDENTIAL_NOTICE) options.fail(line);
  return { ...media, settled: recreated.code === 0 };
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
    if (name === "command" || name === "mode") continue;
    // A list stays a list in JSON and becomes one line per entry here, because
    // the entries are what a person reads down: the settings that were written,
    // the ones still missing, the questions setup would ask. An empty one is
    // said rather than skipped — "nothing was written" is an answer, and a
    // missing line is not.
    if (Array.isArray(value)) {
      if (value.length === 0) options.out(`${name}: none`);
      for (const entry of value) options.out(`${name}: ${String(entry)}`);
      continue;
    }
    options.out(`${name}: ${String(value)}`);
  }
}

/**
 * A number as a carrier means it. Whitespace and the punctuation people write
 * numbers with are removed; nothing else is guessed at, because a number egma
 * corrected into a different number is a call to a stranger.
 */
function normalizeNumber(given: string): string {
  return given.replace(/[\s()\-.]/g, "");
}
