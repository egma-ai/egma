/**
 * What the Egma model gateway is configured with, and where a bad value is
 * caught.
 *
 * The gateway is the one egma application that runs outside egma's own
 * deployment, so it is configured the way its host configures things: a flat
 * map of names to strings, handed in rather than read out of a global. A
 * Cloudflare Worker gets that map as its `env` binding and a developer's
 * machine gets it out of the process environment, and neither is visible from
 * anything below this file.
 *
 * **Everything secret is required and nothing secret has a default.** A
 * gateway started without a provider credential would answer health checks,
 * accept connections, and refuse every one of them at the provider — so a
 * missing name is loud at boot instead of silent until the first simulation.
 */

/** The flat map a host hands in. Cloudflare's `env`, or `process.env`. */
export type Environment = Readonly<Record<string, string | undefined>>;

/** The three model jobs this gateway carries. Vocabulary from CONTEXT.md. */
export const MODEL_JOBS = ["llm", "stt", "tts"] as const;
export type ModelJob = (typeof MODEL_JOBS)[number];

/** The providers this gateway has a shipped route for. */
export const PROVIDERS = ["deepgram", "openai", "cartesia"] as const;
export type Provider = (typeof PROVIDERS)[number];

export const LOG_LEVELS = ["DEBUG", "INFO", "WARN", "ERROR"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/**
 * Where each provider is really reached.
 *
 * **These are the gateway's own addresses, and no caller can name one.** The
 * deployment may replace them — that is what lets the deterministic suite point
 * a route at a strict local server standing in for a provider — but the value
 * comes from deployment configuration and never from a request. A request that
 * tries to name an upstream is refused by the route table before this is read.
 */
export const PROVIDER_HOME: Readonly<Record<Provider, string>> = {
  deepgram: "https://api.deepgram.com",
  openai: "https://api.openai.com",
  cartesia: "https://api.cartesia.ai",
};

/**
 * How long a whole relayed exchange may take before it is a failure.
 *
 * **Finite, always, and this is the reason the number exists at all.** A relay
 * with no clock on it holds a socket and an isolate open for as long as the
 * other end is willing to say nothing, which is the failure mode a shared
 * gateway cannot have: one wedged simulation would otherwise cost the gateway a
 * connection slot for the rest of the day. Ten minutes is far longer than any
 * voice exchange this carries and far shorter than forever.
 */
const DEFAULT_EXCHANGE_TIMEOUT_MS = 600_000;

/**
 * How long the gateway waits for the provider's first byte.
 *
 * Separate from the whole-exchange bound because they catch different failures:
 * this one catches a provider that accepted the request and then went quiet,
 * which is indistinguishable from a working stream until it is timed. Thirty
 * seconds is generous for a first token and short enough that a persona waiting
 * on it fails visibly rather than hanging.
 */
const DEFAULT_FIRST_OUTPUT_TIMEOUT_MS = 30_000;

/**
 * How long a relayed socket may carry nothing in either direction.
 *
 * A voice socket is never idle for long — audio flows continuously while the
 * simulation is live — so silence this long is an abandoned exchange rather
 * than a quiet one.
 */
const DEFAULT_SOCKET_IDLE_TIMEOUT_MS = 120_000;

/**
 * The largest single frame the relay will carry.
 *
 * **The one place a relayed socket can grow without a bound, so it is the one
 * place with a number on it.** Neither side of a relayed socket is open until
 * both are — see `relay-socket.ts` — so there is no queue between them to
 * bound, and back-pressure is the transport's own. What is left is one frame,
 * which has to exist in memory in one piece before it can be handed on: a
 * caller sending a single enormous frame would otherwise take the whole isolate
 * down, and every other exchange on it with them. One mebibyte is far more than
 * any audio frame or transcript this carries, and far less than a problem.
 */
const DEFAULT_MAX_FRAME_BYTES = 1_048_576;

export type Config = {
  /**
   * The organization-scoped secret the preview verifier accepts, the
   * organization it stands for, and the inference-key identifier recorded
   * against it.
   *
   * **This is the preview's whole authentication story and it is deliberately
   * one secret.** Real inference keys — created, shown once, hashed, revoked —
   * are stored work that belongs to the managed-access ticket that builds the
   * store. What the gateway needs from that store is one answer: does this
   * credential authorize a connection, and which organization is it. So the
   * gateway takes a verifier, this is the verifier a preview deploys, and the
   * store arrives later behind the same interface with nothing else changing.
   */
  readonly organizationSecret: string;
  readonly organizationId: string;
  readonly inferenceKeyId: string;

  /** Egma's own provider credentials, one per shipped provider. */
  readonly providerCredentials: Readonly<Record<Provider, string>>;

  /** Where each provider is reached. Deployment configuration, never a caller's. */
  readonly providerHome: Readonly<Record<Provider, string>>;

  readonly exchangeTimeoutMs: number;
  readonly firstOutputTimeoutMs: number;
  readonly socketIdleTimeoutMs: number;
  readonly maxFrameBytes: number;
  readonly logLevel: LogLevel;
};

/** Every name a deployment must supply a value for. */
export const REQUIRED_NAMES = [
  "EGMA_GATEWAY_ORGANIZATION_SECRET",
  "EGMA_GATEWAY_ORGANIZATION_ID",
  "EGMA_GATEWAY_INFERENCE_KEY_ID",
  "EGMA_GATEWAY_DEEPGRAM_KEY",
  "EGMA_GATEWAY_OPENAI_KEY",
  "EGMA_GATEWAY_CARTESIA_KEY",
] as const;

/** Every name a deployment may supply, and which nothing breaks without. */
export const OPTIONAL_NAMES = [
  "EGMA_GATEWAY_DEEPGRAM_HOME",
  "EGMA_GATEWAY_OPENAI_HOME",
  "EGMA_GATEWAY_CARTESIA_HOME",
  "EGMA_GATEWAY_EXCHANGE_TIMEOUT_MS",
  "EGMA_GATEWAY_FIRST_OUTPUT_TIMEOUT_MS",
  "EGMA_GATEWAY_SOCKET_IDLE_TIMEOUT_MS",
  "EGMA_GATEWAY_MAX_FRAME_BYTES",
  "EGMA_GATEWAY_LOG_LEVEL",
  "EGMA_GATEWAY_PORT",
] as const;

/**
 * The names that hold a secret value.
 *
 * Written down because two other things need to know: the deployment
 * documentation, which must list every one as a secret rather than a variable,
 * and the record writer, which must never be handed one.
 */
export const SECRET_NAMES = [
  "EGMA_GATEWAY_ORGANIZATION_SECRET",
  "EGMA_GATEWAY_DEEPGRAM_KEY",
  "EGMA_GATEWAY_OPENAI_KEY",
  "EGMA_GATEWAY_CARTESIA_KEY",
] as const;

export class ConfigurationFault extends Error {}

function required(environment: Environment, name: string): string {
  const value = environment[name]?.trim();
  if (value === undefined || value === "") {
    throw new ConfigurationFault(
      `${name} is not set, and the Egma model gateway cannot carry traffic without it`,
    );
  }
  return value;
}

function positiveWholeNumber(
  environment: Environment,
  name: string,
  fallback: number,
): number {
  const written = environment[name]?.trim();
  if (written === undefined || written === "") return fallback;

  const value = Number(written);
  if (!Number.isInteger(value) || value < 1) {
    throw new ConfigurationFault(
      `${name} is a positive whole number of milliseconds or bytes, and "${written}" is not`,
    );
  }
  return value;
}

/**
 * An upstream address, or the provider's real home.
 *
 * Checked here rather than at first use, because a value that is not an address
 * would otherwise be discovered by a request that fails with the provider's
 * name on it — which reads as the provider being down.
 */
function home(environment: Environment, name: string, fallback: string): string {
  const written = environment[name]?.trim();
  if (written === undefined || written === "") return fallback;
  let parsed: URL;
  try {
    parsed = new URL(written);
  } catch {
    throw new ConfigurationFault(`${name} must be an absolute address, and "${written}" is not`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ConfigurationFault(
      `${name} must be an http or https address, and "${written}" is not`,
    );
  }
  // Written with no trailing slash so that joining a provider's own path onto
  // it is string concatenation and never produces a doubled separator.
  return written.replace(/\/+$/, "");
}

function logLevel(environment: Environment): LogLevel {
  const written = environment["EGMA_GATEWAY_LOG_LEVEL"]?.trim().toUpperCase();
  if (written === undefined || written === "") return "INFO";
  const found = LOG_LEVELS.find((level) => level === written);
  if (found === undefined) {
    throw new ConfigurationFault(
      `EGMA_GATEWAY_LOG_LEVEL is one of ${LOG_LEVELS.join(", ")}, and "${written}" is not`,
    );
  }
  return found;
}

export function loadConfig(environment: Environment): Config {
  const config: Config = {
    organizationSecret: required(environment, "EGMA_GATEWAY_ORGANIZATION_SECRET"),
    organizationId: required(environment, "EGMA_GATEWAY_ORGANIZATION_ID"),
    inferenceKeyId: required(environment, "EGMA_GATEWAY_INFERENCE_KEY_ID"),
    providerCredentials: {
      deepgram: required(environment, "EGMA_GATEWAY_DEEPGRAM_KEY"),
      openai: required(environment, "EGMA_GATEWAY_OPENAI_KEY"),
      cartesia: required(environment, "EGMA_GATEWAY_CARTESIA_KEY"),
    },
    providerHome: {
      deepgram: home(environment, "EGMA_GATEWAY_DEEPGRAM_HOME", PROVIDER_HOME.deepgram),
      openai: home(environment, "EGMA_GATEWAY_OPENAI_HOME", PROVIDER_HOME.openai),
      cartesia: home(environment, "EGMA_GATEWAY_CARTESIA_HOME", PROVIDER_HOME.cartesia),
    },
    exchangeTimeoutMs: positiveWholeNumber(
      environment,
      "EGMA_GATEWAY_EXCHANGE_TIMEOUT_MS",
      DEFAULT_EXCHANGE_TIMEOUT_MS,
    ),
    firstOutputTimeoutMs: positiveWholeNumber(
      environment,
      "EGMA_GATEWAY_FIRST_OUTPUT_TIMEOUT_MS",
      DEFAULT_FIRST_OUTPUT_TIMEOUT_MS,
    ),
    socketIdleTimeoutMs: positiveWholeNumber(
      environment,
      "EGMA_GATEWAY_SOCKET_IDLE_TIMEOUT_MS",
      DEFAULT_SOCKET_IDLE_TIMEOUT_MS,
    ),
    maxFrameBytes: positiveWholeNumber(
      environment,
      "EGMA_GATEWAY_MAX_FRAME_BYTES",
      DEFAULT_MAX_FRAME_BYTES,
    ),
    logLevel: logLevel(environment),
  };

  // A first-output bound above the whole-exchange bound can never fire, so a
  // deployment that set one would have configured a timeout it does not have.
  if (config.firstOutputTimeoutMs > config.exchangeTimeoutMs) {
    throw new ConfigurationFault(
      "EGMA_GATEWAY_FIRST_OUTPUT_TIMEOUT_MS must be within EGMA_GATEWAY_EXCHANGE_TIMEOUT_MS, or the first-output bound can never be reached",
    );
  }

  return config;
}
