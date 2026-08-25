/**
 * `egma self-host`: the platform operator's half of the CLI.
 *
 * One CLI, two contexts. The bare wizard and `connect`, `pull`, `push` and
 * `run` operate an *agent repository* — tests, and the address of the platform
 * that owns their identifiers. Everything under `self-host` operates a
 * *platform workspace* — the deployment itself and its containers. On one
 * laptop that is often the same person, and the product still keeps the two apart, because
 * one platform serves many repositories and platform secrets must not spread
 * into any of them.
 *
 * **`up`** starts the whole platform and prints the address an agent
 *   repository points at. Everything: the API, the web application, both
 *   stores, the simulator, the grader, LiveKit, its SIP gateway and their
 *   Redis. There is no phone overlay to ask for by name any more. It also
 *   prepares the workspace: credentials used only between Egma containers are
 *   generated once and written to the private platform file. External model
 *   keys and the optional carrier route stay in the operator's `.env` file.
 *
 * `up` sets `EGMA_BASE_URL` to the same URL it prints. Agent repositories use
 * that URL directly; there is no second platform-identity response to compare.
 */

import { UnusableUrlError } from "../platform/credentials.ts";
import { normalizePlatformOrigin } from "../platform/url.ts";
import {
  compose,
  composeEnvironment,
  DockerMissingError,
  DockerStateInspectionError,
  missingRequiredVariable,
  OperatorEnvironmentError,
  persistedPostgresVolumes,
  type ComposeOptions,
} from "../self-host/compose.ts";
import {
  recordPlatformBootstrap,
  type PlatformBootstrap,
} from "../self-host/media-credential.ts";
import {
  findWorkspace,
  NoPlatformWorkspaceError,
  protectOperatorEnvironment,
  readPlatformConfig,
} from "../self-host/workspace.ts";

/** What each ending means to whoever ran the command. */
export const SELF_HOST_EXIT = {
  /** Done. */
  ok: 0,
  /** This is not a platform workspace, or docker is not here. */
  noWorkspace: 1,
  /** The platform refused or could not finish, and said why. */
  refused: 4,
} as const;

/**
 * The address a platform is reached at, and therefore the one it reports.
 *
 * The compose default, restated here because this command *sets* it rather than
 * reading it: a deployment reached on a LAN address sets `EGMA_BASE_URL` in its
 * own environment and `up` prints what it finds there.
 */
export const DEFAULT_PLATFORM_ADDRESS = "http://localhost:3101";

/** The health check served by the web origin that `self-host up` prints. */
const PLATFORM_HEALTH_PATH = "/api/health";

/** How long the platform has to come up before something is wrong. */
const READY_TIMEOUT_MS = 300_000;
const READY_POLL_MS = 2_000;

const CARRIER_VARIABLES = [
  "EGMA_PHONE_TRUNK_ADDRESS",
  "EGMA_PHONE_SOURCE_NUMBER",
  "EGMA_PHONE_TRUNK_USERNAME",
  "EGMA_PHONE_TRUNK_PASSWORD",
] as const;

/** Refuse an incomplete carrier route before Docker runs. */
function carrierEnvironmentProblem(
  environment: Readonly<Record<string, string | undefined>>,
): string | null {
  const values = Object.fromEntries(
    CARRIER_VARIABLES.map((name) => [name, environment[name]?.trim() ?? ""]),
  ) as Record<(typeof CARRIER_VARIABLES)[number], string>;
  const present = CARRIER_VARIABLES.filter((name) => values[name] !== "");
  if (present.length === 0) return null;

  const missing = CARRIER_VARIABLES.filter((name) => values[name] === "");
  if (missing.length > 0) {
    return (
      "the phone carrier route in .env is incomplete. Add " +
      `${missing.join(" and ")}, or remove every EGMA_PHONE_* value`
    );
  }
  return null;
}

/** The normal self-host command owns one environment file, by design. */
function composeEnvironmentControlProblem(
  environment: Readonly<Record<string, string | undefined>>,
): string | null {
  const alternate = environment.COMPOSE_ENV_FILES?.trim() ?? "";
  const disabled = environment.COMPOSE_DISABLE_ENV_FILE?.trim().toLowerCase() ?? "";
  const disablesDefault =
    disabled !== "" && !["0", "false", "no", "off"].includes(disabled);
  if (alternate === "" && !disablesDefault) return null;
  return (
    "egma self-host up reads the platform workspace .env file. Unset " +
    "COMPOSE_ENV_FILES and COMPOSE_DISABLE_ENV_FILE, then put the operator " +
    "values in that .env file"
  );
}

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
  /** Options this command does not know, by name only — never their value. */
  readonly unknown: readonly string[];
};

const VALUED_OPTIONS = ["--cwd"] as const;

export function parseSelfHostArgs(argv: readonly string[]): SelfHostInvocation {
  const words: string[] = [];
  const unknown: string[] = [];
  let cwd: string | null = null;

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
      // `--cwd --unknown` would swallow `--unknown` and silently use it as a
      // path. Nothing here takes a value that
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
    unknown.push(name);
  }

  return {
    verb: words.join(" "),
    cwd,
    unknown,
  };
}

export async function runSelfHostCommand(options: SelfHostOptions): Promise<number> {
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
    if (
      error instanceof OperatorEnvironmentError ||
      error instanceof DockerStateInspectionError
    ) {
      options.out(`status: refused\nreason: ${error.message}`);
      options.fail(error.message);
      return SELF_HOST_EXIT.refused;
    }
    throw error;
  }

  options.fail(
    `egma self-host does not know ${verb === "" ? "that" : `"${verb}"`}. It knows:\n` +
      "  egma self-host up      Start the whole platform.",
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
  const composeControlProblem = composeEnvironmentControlProblem(options.env);
  if (composeControlProblem !== null) {
    options.out("status: refused");
    options.out(`reason: ${composeControlProblem}`);
    options.fail(composeControlProblem);
    return SELF_HOST_EXIT.refused;
  }
  protectOperatorEnvironment(workspace);
  const operator = await composeEnvironment({
    workspace,
    environment: options.env,
    signal: options.signal,
  });

  const carrierProblem = carrierEnvironmentProblem(operator);
  if (carrierProblem !== null) {
    options.out("status: refused");
    options.out(`reason: ${carrierProblem}`);
    options.fail(carrierProblem);
    return SELF_HOST_EXIT.refused;
  }

  // One address, decided here. The environment wins because a deployment
  // reached on a LAN address says so there; what the workspace recorded is
  // next, so a platform set up once keeps its address; the compose default is
  // last.
  const offeredAddress = operator.EGMA_BASE_URL?.trim();
  const address = platformAddress(
    offeredAddress || stored.EGMA_BASE_URL?.trim() || DEFAULT_PLATFORM_ADDRESS,
    offeredAddress ? "EGMA_BASE_URL" : "this workspace's recorded address",
  );

  options.out(`workspace: ${workspace}`);
  options.out(`url: ${address}`);

  // The database is the durable proof that this is an existing installation.
  // It can remain after every container and platform.env file was removed. We
  // must know that before minting anything: a new encryption key beside that
  // old database would make its sealed credentials unreadable.
  const postgresVolumes = await persistedPostgresVolumes({
    projectName: operator.COMPOSE_PROJECT_NAME?.trim() || "egma",
    environment: options.env,
    signal: options.signal,
  });

  // Decide every credential used only between Egma containers before Compose
  // starts. Existing values from an older `.env` deployment are adopted; later
  // starts use the private workspace file. Provider and carrier values remain
  // in the operator's `.env` and cannot enter this closed bootstrap set.
  let bootstrap: PlatformBootstrap;
  try {
    bootstrap = await recordPlatformBootstrap(
      workspace,
      operator,
      address,
      postgresVolumes,
    );
  } catch (cause) {
    options.out("status: failed");
    options.out(
      `reason: Egma could not prepare this workspace's internal credentials: ${
        (cause as Error).message
      }`,
    );
    return SELF_HOST_EXIT.refused;
  }
  options.out(
    `platform_credentials: ${bootstrap.generated.length > 0 ? "generated" : "existing"}`,
  );
  options.out(
    `media_credential: ${bootstrap.mediaGenerated ? "generated" : "existing"}`,
  );
  if (bootstrap.generated.length > 0) {
    for (const line of PLATFORM_CREDENTIAL_NOTICE) options.fail(line);
  }

  // Hand Compose the exact values its own parser resolved above. Child-process
  // environment has higher precedence than a second `.env` read, so `$` in a
  // provider key or SIP password stays literal and Compose environment-control
  // variables cannot make validation and runtime see different routes.
  const environment: Record<string, string> = {
    ...operator,
    ...bootstrap.values,
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
      `reason: ${missing} has no value in the prepared deployment configuration. ` +
        "Nothing was started. Normal bundled self-host configuration generates " +
        "every internal value, so this is either an incomplete advanced override " +
        "or a platform preparation error.",
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

  const ready = await waitForPlatform(address, options.signal);
  if (!ready) {
    options.out("status: failed");
    options.out(
      `reason: the containers started but nothing answered ${address}${PLATFORM_HEALTH_PATH} within ${
        READY_TIMEOUT_MS / 1000
      }s`,
    );
    return SELF_HOST_EXIT.refused;
  }

  options.out(`services: ${STARTED.join(" ")}`);
  options.out("status: ready");
  options.out(`connect: npx @egma/cli --url ${address}`);

  options.fail("");
  options.fail(`Egma is ready at ${address}`);
  options.fail("");
  options.fail("In your agent repository, once:");
  options.fail(`  npx @egma/cli --url ${address}`);
  return SELF_HOST_EXIT.ok;
}

/**
 * What the operator is told when any internal credential was generated.
 * The encryption-key backup warning is part of the result because a database
 * backup without that file cannot recover sealed credentials.
 */
const PLATFORM_CREDENTIAL_NOTICE = [
  "Egma generated the credentials used only between this workspace's containers " +
    "and wrote them to .egma-platform/platform.env. You do not choose or type " +
    "these values. Keep that private file with the rest of this deployment's backups.",
  "The encryption key in that file must be backed up with Postgres. Stored " +
    "credentials cannot be opened without it.",
] as const;

async function platformIsHealthy(address: string): Promise<boolean> {
  try {
    const answer = await fetch(`${address}${PLATFORM_HEALTH_PATH}`, {
      signal: AbortSignal.timeout(5_000),
    });
    return answer.ok;
  } catch {
    return false;
  }
}

async function waitForPlatform(
  address: string,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    if (await platformIsHealthy(address)) return true;
    if (Date.now() >= deadline || signal?.aborted === true) return false;
    await new Promise((wake) => setTimeout(wake, READY_POLL_MS));
  }
}

/**
 * Normalize the address before it is recorded or used.
 *
 * Credentials and repository bindings are keyed by this spelling, so a
 * trailing slash or an explicit default port must not create a second identity.
 */
function platformAddress(given: string, from: string): string {
  try {
    return normalizePlatformOrigin(given);
  } catch {
    throw new UnusableUrlError(from);
  }
}
