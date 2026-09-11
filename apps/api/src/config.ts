import {
  openBillingPlugIn,
  PROVIDERS_BY_JOB,
  type BillingPlugIn,
  type SimulationConcurrencyCaps,
} from "@egma/db";
import {
  providerCredentialSource,
  type ProviderCredentialSource,
} from "@egma/provider-credentials";

import { SERVICE_TOKEN_PREFIX } from "./auth/service-token.ts";
import type { SmtpSettings } from "./auth/email.ts";
import { loadIngestionSettings, type IngestionSettings } from "@egma/ingestion";
export type { IngestionSettings } from "@egma/ingestion";
import type { BlobStore } from "./recordings/signed-link.ts";
import type { VoiceFleetSettings } from "./voice-fleet.ts";

/** The one deployment-owned route used for phone simulations. */
export type CarrierRoute = {
  readonly trunkAddress: string;
  readonly sourceNumber: string;
  readonly trunkUsername: string;
  readonly trunkPassword: string;
};

/** The four environment values which form one complete phone carrier route. */
export const CARRIER_ROUTE_ENVIRONMENT = [
  {
    property: "trunkAddress",
    variable: "EGMA_PHONE_TRUNK_ADDRESS",
    label: "the carrier trunk",
  },
  {
    property: "sourceNumber",
    variable: "EGMA_PHONE_SOURCE_NUMBER",
    label: "the source number",
  },
  {
    property: "trunkUsername",
    variable: "EGMA_PHONE_TRUNK_USERNAME",
    label: "the SIP username",
  },
  {
    property: "trunkPassword",
    variable: "EGMA_PHONE_TRUNK_PASSWORD",
    label: "the SIP password",
  },
] as const satisfies readonly {
  readonly property: keyof CarrierRoute;
  readonly variable: string;
  readonly label: string;
}[];

/** E.164: a plus, then no more than fifteen digits and no leading zero. */
const E164 = /^\+[1-9]\d{1,14}$/u;

/**
 * Which halves of ingestion this process serves.
 *
 * `all` is the deployment every self-host and the current hosted platform runs:
 * one process accepts evidence and drains the pending prefix. The other two
 * exist so that splitting those apart later is a setting rather than a second
 * protocol and a second image — `ingest` accepts and never drains, `drain`
 * drains and never accepts.
 */
export type DeploymentRole = "all" | "ingest" | "drain";

export type Config = {
  readonly databaseUrl: string;
  /**
   * Where the trace store is. Required on the same terms as `databaseUrl`:
   * ClickHouse is the floor rather than an upgrade, there is no second
   * analytical path to fall back to, and an instance that started without it
   * would accept a trace it had nowhere to put.
   */
  readonly clickhouseUrl: string;
  readonly host: string;
  readonly port: number;
  /**
   * The origin a person's browser reaches egma on, and the one the session
   * cookie is scoped to. The pages and the API are served from a single origin
   * in every deployment, so this is both of them.
   *
   * A self-hoster's own instance, always. Nothing about logging in may depend
   * on a domain egma runs.
   */
  readonly baseUrl: string;
  /** What sessions are signed with. Absent means the service will not start. */
  readonly authSecret: string;
  /**
   * What connection credentials are sealed under before they touch a row —
   * 32 random bytes as 64 hex characters (`openssl rand -hex 32`). Malformed
   * or absent means the service will not start. Deployment credentials do not
   * use this path: model-provider keys stay in their credential source and the
   * phone carrier stays in the process environment.
   */
  readonly encryptionKey: string;
  /**
   * Close open signup after the first organization claims this deployment.
   * Enabled by default for self-hosting; hosted deployments can disable it.
   */
  readonly singleOrganization: boolean;
  /**
   * Whether `x-forwarded-proto` and `x-forwarded-host` may be believed. Off by
   * default, because believing them without a proxy in front lets any client
   * claim any origin.
   */
  readonly trustProxy: boolean;
  /**
   * How many credentialed requests one **organization** may make per minute.
   *
   * The organization rather than the key, so that rotating a key — mint,
   * deploy, revoke — cannot reset a budget, and so that ten deployments sharing
   * one account do not get ten budgets. The default is generous enough that
   * nobody using the product notices it and low enough that a runaway loop
   * stops being everybody else's problem.
   */
  readonly rateLimitPerMinute: number;
  /**
   * Required deployment token for internal simulation requests, prefixed
   * egma_st_. Claims return provider credentials, so no public default is safe.
   */
  readonly simulatorServiceToken: string;
  /** Private simulator endpoint used for persona audio Preview rendering. */
  readonly simulatorPreviewUrl: string;
  /**
   * Where a claimed simulation reads the current provider-key bundle.
   *
   * Cloud reads AWS Secrets Manager for every unit of work. Self-host reads
   * the operator's provider variables. Neither path writes a model key to
   * Postgres, and neither keeps a cross-work key cache.
   */
  readonly providerCredentials: ProviderCredentialSource;
  /** Optional deployment-wide simulation and speech-provider concurrency caps. */
  readonly simulationConcurrencyCaps: SimulationConcurrencyCaps;
  /** Hosted voice compute. Unset self-hosts never import the Daytona adapter. */
  readonly voiceFleet: VoiceFleetSettings | undefined;
  /** Immutable public commit running in this task, exposed by `/health`. */
  readonly releaseSha: string | undefined;
  /**
   * The billing plug-in this deployment runs on: an entitlement source and a
   * usage sink, chosen once from the settings below.
   *
   * **Absent billing is the default and is not a special case.** With no Stripe
   * secret named, the plug-in is the open one — every allowance unlimited,
   * every usage record discarded — and the product is exactly the product. A
   * self-hoster who names the same secret gets the same billing, which is what
   * makes billing a hosted service rather than a cloud-only feature (ADR-0024).
   * Nothing about the choice derives from whether this deployment is the cloud.
   */
  readonly billing: BillingPlugIn;
  /**
   * `EGMA_STRIPE_SECRET_KEY`, as the deployment named it, or `undefined`.
   *
   * **It is a setting and never a mode.** Its presence is what selects the
   * cloud adapter, and the selection itself happens in `billing.ts` beside
   * this file, because the adapter lives in the commercially licensed package
   * and loading it is a dynamic import taken only when this is set. Reading
   * the setting here rather than there keeps every deployment value in one
   * place.
   */
  readonly stripeSecretKey: string | undefined;
  /**
   * `EGMA_STRIPE_WEBHOOK_SECRET`, as the deployment named it, or `undefined`.
   *
   * **What proves a delivery came from Stripe.** A webhook carries no cookie
   * and no key: anybody can post to the endpoint, and only Stripe can sign a
   * body against this secret. Absent, the endpoint is not mounted at all —
   * an endpoint that could not check a signature would be one anybody could
   * post a payment to. The buttons still work without it; Stripe's answers
   * land the day it is set.
   */
  readonly stripeWebhookSecret: string | undefined;
  /**
   * The deployment's phone carrier route, read from the process environment.
   *
   * All four values are one credential bundle. Empty is ordinary and means
   * phone simulations are unavailable; a partial bundle is refused at startup.
   * It never enters Postgres and is handed only to claimed phone simulations.
   */
  readonly carrierRoute: CarrierRoute | undefined;
  /**
   * Recording playback configuration, enabled by EGMA_BLOB_PUBLIC_URL.
   * Use the browser-accessible address for signed links. Signing does not
   * connect to storage; without this configuration, audio links are unavailable.
   */
  readonly blob: BlobStore | undefined;
  /**
   * The durable ingestion path: which role this process serves, where staged
   * evidence waits, and which bucket it becomes durable in.
   *
   * Separate from `blob` above and sharing nothing with it. One deployment can
   * run both on one MinIO, and they still have two buckets and two credentials,
   * because a workload that could read, delete or expire the other's objects
   * would make either one's retention a promise neither can keep.
   */
  readonly ingestion: IngestionSettings;
  /**
   * Where to post mail, if anywhere. **Absent is the ordinary case and is never
   * an error**: with no transport configured, signup asks for no verification
   * and an invitation hands its link back to the person who created it. Setting
   * it is one step in the self-hosting documentation and never a prerequisite.
   *
   * There is no second setting saying "and now require verification" or "and
   * now send invitations", because two settings can disagree and one cannot.
   */
  readonly smtp: SmtpSettings | undefined;
};

function flag(
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: boolean,
): boolean {
  const raw = environment[name]?.trim().toLowerCase();
  if (raw === undefined || raw === "") return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  throw new Error(`${name} is not a yes or a no: ${environment[name]}`);
}

function positiveWhole(
  environment: NodeJS.ProcessEnv,
  name: string,
): number | undefined {
  const raw = environment[name]?.trim();
  if (raw === undefined || raw === "") return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a whole number of at least 1: ${raw}`);
  }
  return value;
}

function simulationConcurrencyCaps(
  environment: NodeJS.ProcessEnv,
): SimulationConcurrencyCaps {
  const voice = positiveWhole(
    environment,
    "EGMA_VOICE_SIMULATION_CONCURRENCY_CAP",
  );
  const chat = positiveWhole(
    environment,
    "EGMA_CHAT_SIMULATION_CONCURRENCY_CAP",
  );
  const raw = environment.EGMA_SPEECH_PROVIDER_CONCURRENCY_CAPS?.trim();
  if (raw === undefined || raw === "") {
    return {
      ...(voice === undefined ? {} : { voice }),
      ...(chat === undefined ? {} : { chat }),
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      "EGMA_SPEECH_PROVIDER_CONCURRENCY_CAPS must be a JSON object of provider names to positive whole numbers",
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      "EGMA_SPEECH_PROVIDER_CONCURRENCY_CAPS must be a JSON object of provider names to positive whole numbers",
    );
  }
  const speechProviders = new Set<string>(
    [...PROVIDERS_BY_JOB.stt, ...PROVIDERS_BY_JOB.tts].map(
      (entry) => entry.provider,
    ),
  );
  const caps: Record<string, number> = {};
  for (const [provider, offered] of Object.entries(parsed)) {
    if (!speechProviders.has(provider)) {
      throw new Error(
        `EGMA_SPEECH_PROVIDER_CONCURRENCY_CAPS names unsupported speech provider ${provider}`,
      );
    }
    if (!Number.isInteger(offered) || Number(offered) < 1) {
      throw new Error(
        `EGMA_SPEECH_PROVIDER_CONCURRENCY_CAPS must give ${provider} a whole number of at least 1`,
      );
    }
    caps[provider] = Number(offered);
  }
  return {
    ...(voice === undefined ? {} : { voice }),
    ...(chat === undefined ? {} : { chat }),
    speechProviders: caps,
  };
}

const DAYTONA_PROVIDER_SECRET_ENVIRONMENT = new Set([
  "EGMA_OPENAI_API_KEY",
  "EGMA_DEEPGRAM_API_KEY",
  "EGMA_CARTESIA_API_KEY",
]);
const REQUIRED_DAYTONA_PROVIDER_SECRET_ENVIRONMENT = [
  "EGMA_OPENAI_API_KEY",
  "EGMA_DEEPGRAM_API_KEY",
  "EGMA_CARTESIA_API_KEY",
] as const;

function jsonStringMap(
  environment: NodeJS.ProcessEnv,
  name: string,
): Record<string, string> {
  const raw = environment[name]?.trim();
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${name} must be a JSON object of environment variables to secret names`);
  }
  if (
    typeof parsed !== "object" || parsed === null || Array.isArray(parsed) ||
    Object.entries(parsed).some(
      ([variable, secret]) =>
        !DAYTONA_PROVIDER_SECRET_ENVIRONMENT.has(variable) ||
        typeof secret !== "string" || secret.trim() === "",
    )
  ) {
    throw new Error(
      `${name} supports only EGMA_OPENAI_API_KEY, EGMA_DEEPGRAM_API_KEY, and EGMA_CARTESIA_API_KEY with non-empty secret names`,
    );
  }
  return Object.fromEntries(
    Object.entries(parsed).map(([variable, secret]) => [
      variable,
      (secret as string).trim(),
    ]),
  );
}

function voiceFleetSettings(
  environment: NodeJS.ProcessEnv,
  context: {
    readonly baseUrl: string;
    readonly releaseSha: string | undefined;
  },
): VoiceFleetSettings | undefined {
  const kind = environment.EGMA_VOICE_FLEET_LAUNCHER?.trim();
  if (!kind) return undefined;
  if (kind !== "daytona") {
    throw new Error(`EGMA_VOICE_FLEET_LAUNCHER does not support ${kind}`);
  }
  const required = (name: string): string => {
    const value = environment[name]?.trim();
    if (!value) throw new Error(`${name} is required by EGMA_VOICE_FLEET_LAUNCHER`);
    return value;
  };
  if (context.releaseSha === undefined) {
    throw new Error("EGMA_RELEASE_SHA is required by EGMA_VOICE_FLEET_LAUNCHER");
  }
  const ttlMinutes = positiveWhole(environment, "DAYTONA_SANDBOX_TTL_MINUTES") ?? 30;
  const providerSecrets = jsonStringMap(environment, "DAYTONA_SANDBOX_SECRETS");
  const missingProviderSecrets = REQUIRED_DAYTONA_PROVIDER_SECRET_ENVIRONMENT.filter(
    (variable) => providerSecrets[variable] === undefined,
  );
  if (missingProviderSecrets.length > 0) {
    throw new Error(
      `DAYTONA_SANDBOX_SECRETS must map ${missingProviderSecrets.join(", ")}`,
    );
  }
  return {
    kind,
    apiKey: required("DAYTONA_API_KEY"),
    ...(environment.DAYTONA_API_URL?.trim()
      ? { apiUrl: environment.DAYTONA_API_URL.trim() }
      : {}),
    ...(environment.DAYTONA_TARGET?.trim()
      ? { target: environment.DAYTONA_TARGET.trim() }
      : {}),
    snapshot: required("DAYTONA_SNAPSHOT_ID"),
    releaseSha: context.releaseSha,
    ttlMinutes,
    serviceTokenSecret: required("DAYTONA_SERVICE_TOKEN_SECRET"),
    providerSecrets,
    controlPlaneUrl: context.baseUrl,
    livekitUrl: required("EGMA_SIMULATOR_LIVEKIT_URL"),
    livekitApiKey: required("EGMA_SIMULATOR_LIVEKIT_API_KEY"),
    livekitApiSecret: required("EGMA_SIMULATOR_LIVEKIT_API_SECRET"),
    s3Endpoint: required("EGMA_SIMULATOR_S3_ENDPOINT"),
    s3Bucket: required("EGMA_SIMULATOR_S3_BUCKET"),
    s3Region: required("EGMA_SIMULATOR_S3_REGION"),
    recordingRoleArn: required("EGMA_DAYTONA_RECORDING_ROLE_ARN"),
    recordingBucketArn: required("EGMA_DAYTONA_RECORDING_BUCKET_ARN"),
  };
}

function releaseSha(environment: NodeJS.ProcessEnv): string | undefined {
  const value = environment.EGMA_RELEASE_SHA?.trim();
  if (!value) return undefined;
  if (!/^[0-9a-f]{40}$/u.test(value)) {
    throw new Error("EGMA_RELEASE_SHA must be a 40-character lowercase commit SHA");
  }
  return value;
}

/**
 * Mail, if it was configured. Unset is the ordinary case and returns nothing;
 * set-but-unusable refuses to start, because a transport egma believes in and
 * cannot reach is worse than no transport at all — it turns verification on and
 * stops handing invitation links back, and then delivers neither.
 *
 * The from address defaults to something derived from the instance's own
 * origin, so configuring mail is genuinely one variable.
 */
function smtpSettings(
  environment: NodeJS.ProcessEnv,
  baseUrl: string,
): SmtpSettings | undefined {
  const url = environment.EGMA_SMTP_URL?.trim();
  if (!url) return undefined;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(
      `EGMA_SMTP_URL is not a URL: ${url}. It looks like smtp://user:password@host:587`,
    );
  }
  if (!["smtp:", "smtps:"].includes(parsed.protocol)) {
    throw new Error(
      `EGMA_SMTP_URL speaks ${parsed.protocol} and Egma posts mail over smtp: or smtps:`,
    );
  }

  return {
    url,
    from:
      environment.EGMA_MAIL_FROM?.trim() || `Egma <egma@${new URL(baseUrl).hostname}>`,
  };
}

/**
 * The service refuses to start rather than run misconfigured, so a bad
 * self-host is loud instead of silent.
 */
export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
): Config {
  const databaseUrl = environment.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required and was not set");
  }

  const clickhouseUrl = environment.CLICKHOUSE_URL?.trim();
  if (!clickhouseUrl) {
    throw new Error("CLICKHOUSE_URL is required and was not set");
  }
  let clickhouse: URL;
  try {
    clickhouse = new URL(clickhouseUrl);
  } catch {
    throw new Error(
      `CLICKHOUSE_URL is not a URL: ${clickhouseUrl}. It looks like http://user:password@host:8123/database`,
    );
  }
  if (!["http:", "https:"].includes(clickhouse.protocol)) {
    throw new Error(
      `CLICKHOUSE_URL speaks ${clickhouse.protocol} and Egma reaches ClickHouse over http: or https:`,
    );
  }

  const authSecret = environment.EGMA_AUTH_SECRET?.trim();
  if (!authSecret) {
    throw new Error(
      "EGMA_AUTH_SECRET is required and was not set. It signs session " +
        "cookies; starting without one would either log everybody out on " +
        "every restart or sign nothing at all.",
    );
  }

  // Length and alphabet, not just presence: a 32-character passphrase has the
  // right byte count and a fraction of the entropy, and must be refused
  // rather than accepted quietly.
  const encryptionKey = environment.EGMA_ENCRYPTION_KEY?.trim();
  if (!encryptionKey || !/^[0-9a-f]{64}$/i.test(encryptionKey)) {
    throw new Error(
      "EGMA_ENCRYPTION_KEY is required: 32 random bytes written as 64 hex " +
        "characters — `openssl rand -hex 32` makes one. Connection " +
        "credentials are sealed under it before they touch the database. " +
        "Back it up alongside the database; a backup of one without the " +
        "other is half a backup.",
    );
  }

  const port = Number(environment.PORT ?? 3100);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`PORT is not a usable port number: ${environment.PORT}`);
  }

  const rateLimitPerMinute = Number(
    environment.EGMA_RATE_LIMIT_PER_MINUTE ?? 600,
  );
  if (!Number.isInteger(rateLimitPerMinute) || rateLimitPerMinute <= 0) {
    throw new Error(
      `EGMA_RATE_LIMIT_PER_MINUTE is not a number of requests: ${environment.EGMA_RATE_LIMIT_PER_MINUTE}`,
    );
  }

  const simulatorServiceToken =
    environment.EGMA_SIMULATOR_SERVICE_TOKEN?.trim();
  if (!simulatorServiceToken) {
    throw new Error(
      "EGMA_SIMULATOR_SERVICE_TOKEN is required and was not set. It is what " +
        "the simulator shows this API to claim simulation work, and claim " +
        "answers carry customers' live connection credentials — so the door " +
        "refuses to exist unguarded. Set the same value on the api and " +
        `simulator containers: ${SERVICE_TOKEN_PREFIX} followed by ` +
        "`openssl rand -hex 32`.",
    );
  }
  // The prefix is checked at startup rather than discovered as a mystery
  // 401: the claim door only reads bearers that start with it, so a token
  // without it would be configured and yet never match anything.
  if (!simulatorServiceToken.startsWith(SERVICE_TOKEN_PREFIX)) {
    throw new Error(
      `EGMA_SIMULATOR_SERVICE_TOKEN must start with ${SERVICE_TOKEN_PREFIX}, ` +
        "so a leaked service token is recognisable to secret scanners and " +
        "can never be mistaken for a customer key. Use " +
        `${SERVICE_TOKEN_PREFIX} followed by \`openssl rand -hex 32\`.`,
    );
  }
  const simulatorPreviewUrl = environment.EGMA_SIMULATOR_PREVIEW_URL?.trim() || "http://simulator:8091";
  let parsedSimulatorPreviewUrl: URL;
  try {
    parsedSimulatorPreviewUrl = new URL(simulatorPreviewUrl);
  } catch {
    throw new Error("EGMA_SIMULATOR_PREVIEW_URL is not a URL");
  }
  if (!["http:", "https:"].includes(parsedSimulatorPreviewUrl.protocol) || parsedSimulatorPreviewUrl.username !== "" || parsedSimulatorPreviewUrl.password !== "") {
    throw new Error("EGMA_SIMULATOR_PREVIEW_URL must be an HTTP origin without credentials");
  }

  const givenBaseUrl = environment.EGMA_BASE_URL?.trim() || "http://localhost:3101";
  // Keep this check at the service boundary. The CLI is a public package that
  // is compiled, not bundled, so shared runtime code would also have to be
  // published. The platform-origin agreement test keeps both checks aligned.
  let parsedBaseUrl: URL;
  try {
    parsedBaseUrl = new URL(givenBaseUrl);
  } catch {
    throw new Error("EGMA_BASE_URL is not a URL");
  }
  if (!["http:", "https:"].includes(parsedBaseUrl.protocol)) {
    throw new Error("EGMA_BASE_URL is not an HTTP origin");
  }
  if (
    parsedBaseUrl.username !== "" ||
    parsedBaseUrl.password !== "" ||
    (parsedBaseUrl.pathname !== "" && parsedBaseUrl.pathname !== "/") ||
    parsedBaseUrl.search !== "" ||
    parsedBaseUrl.hash !== ""
  ) {
    // Named part by part, and with the value it should be, because this is a
    // narrowing: a deployment that has run happily on a base URL with a path
    // meets it for the first time on an upgrade, and "must be only the origin"
    // is not something to have to work out at three in the morning. The
    // password is never repeated back; only the fact that one is there is.
    const wrong = [
      parsedBaseUrl.username !== "" || parsedBaseUrl.password !== ""
        ? "a username or password"
        : "",
      parsedBaseUrl.pathname !== "" && parsedBaseUrl.pathname !== "/"
        ? `the path ${parsedBaseUrl.pathname}`
        : "",
      parsedBaseUrl.search !== "" ? "a query" : "",
      parsedBaseUrl.hash !== "" ? "a fragment" : "",
    ].filter((part) => part !== "");
    throw new Error(
      `EGMA_BASE_URL must be only the address Egma is reached at — scheme, host and port, nothing else — and this one carries ${wrong.join(
        " and ",
      )}. Set it to ${parsedBaseUrl.origin} and start Egma again. Egma serves its HTTP interfaces at the root of this address; anything after the port cannot be honoured and is a sign that a proxy is putting Egma under a subpath, which is not supported.`,
    );
  }
  const baseUrl = parsedBaseUrl.origin;
  const currentReleaseSha = releaseSha(environment);

  return {
    smtp: smtpSettings(environment, baseUrl),
    databaseUrl,
    clickhouseUrl,
    host: environment.HOST?.trim() || "0.0.0.0",
    port,
    baseUrl,
    authSecret,
    encryptionKey,
    singleOrganization: flag(environment, "EGMA_SINGLE_ORGANIZATION", true),
    trustProxy: flag(environment, "EGMA_TRUST_PROXY", false),
    rateLimitPerMinute,
    simulatorServiceToken,
    simulatorPreviewUrl: parsedSimulatorPreviewUrl.origin,
    providerCredentials: providerCredentialSource(environment),
    simulationConcurrencyCaps: simulationConcurrencyCaps(environment),
    voiceFleet: voiceFleetSettings(environment, {
      baseUrl,
      releaseSha: currentReleaseSha,
    }),
    releaseSha: currentReleaseSha,
    // The open plug-in, always, and the one setting that can replace it. A
    // deployment that named a Stripe secret has the cloud adapter installed
    // over this at boot; see `billing.ts` and `index.ts`.
    billing: openBillingPlugIn(),
    stripeSecretKey: environment.EGMA_STRIPE_SECRET_KEY?.trim() || undefined,
    stripeWebhookSecret:
      environment.EGMA_STRIPE_WEBHOOK_SECRET?.trim() || undefined,
    carrierRoute: carrierRoute(environment),
    blob: blobStore(environment, parsedBaseUrl),
    ingestion: loadIngestionSettings(environment),
  };
}

/**
 * The deployment credential used to reach the phone carrier.
 *
 * It is ordinary environment configuration, like the provider keys above. Its
 * supplying any of these four strings requires supplying all of them. The
 * username and password stay opaque so any SIP carrier can issue them. An
 * absent bundle keeps chat and room simulations available and leaves phone
 * simulations disabled.
 */
function carrierRoute(environment: NodeJS.ProcessEnv): CarrierRoute | undefined {
  const offered = {
    trunkAddress: environment.EGMA_PHONE_TRUNK_ADDRESS?.trim(),
    sourceNumber: environment.EGMA_PHONE_SOURCE_NUMBER?.trim(),
    trunkUsername: environment.EGMA_PHONE_TRUNK_USERNAME?.trim(),
    trunkPassword: environment.EGMA_PHONE_TRUNK_PASSWORD?.trim(),
  };

  const present = CARRIER_ROUTE_ENVIRONMENT.filter(
    ({ property }) => (offered[property] ?? "") !== "",
  );
  if (present.length === 0) return undefined;
  if (present.length !== CARRIER_ROUTE_ENVIRONMENT.length) {
    const missing = CARRIER_ROUTE_ENVIRONMENT.filter(
      ({ property }) => (offered[property] ?? "") === "",
    ).map(({ variable }) => variable);
    throw new Error(
      "the phone carrier environment requires all four values together. This " +
        `deployment is missing ${missing.join(" and ")}. Set ` +
        "EGMA_PHONE_TRUNK_ADDRESS, EGMA_PHONE_SOURCE_NUMBER, " +
        "EGMA_PHONE_TRUNK_USERNAME and EGMA_PHONE_TRUNK_PASSWORD, or remove " +
        "all four to run Egma without phone simulations.",
    );
  }

  // Completeness above has narrowed all four values to non-empty strings.
  const route = offered as CarrierRoute;
  if (!E164.test(route.sourceNumber)) {
    throw new Error(
      "EGMA_PHONE_SOURCE_NUMBER must be an E.164 phone number such as +15551234567",
    );
  }
  let address: URL;
  try {
    address = new URL(`sip://${route.trunkAddress}`);
  } catch {
    throw new Error(
      "EGMA_PHONE_TRUNK_ADDRESS must be a SIP hostname such as trunk.example.com",
    );
  }
  if (
    address.hostname === "" ||
    address.username !== "" ||
    address.password !== "" ||
    address.pathname !== "" ||
    address.search !== "" ||
    address.hash !== ""
  ) {
    throw new Error(
      "EGMA_PHONE_TRUNK_ADDRESS must be a SIP hostname such as trunk.example.com, " +
        "with no scheme, credentials or path",
    );
  }
  return route;
}

/**
 * Parse recording playback settings and require a complete credential pair.
 * The endpoint must be browser-accessible because signatures bind its host.
 * Use a read-only credential; its permissions are enforced by storage policy.
 * Reject HTTP storage when the Egma page uses HTTPS.
 */
function blobStore(
  environment: NodeJS.ProcessEnv,
  baseUrl: URL,
): BlobStore | undefined {
  const publicUrl = environment.EGMA_BLOB_PUBLIC_URL?.trim() || "";
  if (publicUrl === "") return undefined;

  let parsed: URL;
  try {
    parsed = new URL(publicUrl);
  } catch {
    throw new Error(
      `EGMA_BLOB_PUBLIC_URL is not a URL: ${publicUrl}. It is the address a ` +
        "browser reaches the recording store at, and it looks like " +
        "http://localhost:9000 — never the address this container reaches it " +
        "at, because a signed link only works from the host it was signed for.",
    );
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(
      `EGMA_BLOB_PUBLIC_URL speaks ${parsed.protocol} and a browser fetches a ` +
        "recording over http: or https:",
    );
  }
  // Require HTTPS recordings for an HTTPS page to avoid mixed-content playback
  // failures. HTTP pages may use either storage scheme.
  if (baseUrl.protocol === "https:" && parsed.protocol === "http:") {
    throw new Error(
      `EGMA_BASE_URL is ${baseUrl.origin}, which is https:, and ` +
        `EGMA_BLOB_PUBLIC_URL is ${parsed.origin}, which is http:. A browser ` +
        "will not fetch that: a page loaded over https: blocks audio loaded " +
        "over http: as mixed content, and it blocks it before the request is " +
        "sent — so every recording fails with the store never asked and the " +
        "signature never checked, the player shows an error Egma did not " +
        "send, and the only explanation is a line in the browser's own " +
        "console. Give EGMA_BLOB_PUBLIC_URL an https: address the browser " +
        "reaches the store at — the proxy or certificate the store is " +
        "published behind, alongside the one Egma itself is published behind.",
    );
  }
  // Scheme, host and port, and nothing after them — the same narrowing
  // `EGMA_BASE_URL` makes, for a reason of its own. A signature covers the whole
  // path, prefix included, so a store put behind a proxy on a sub-path only
  // works if that proxy passes its own prefix through to the store; the ordinary
  // arrangement strips it, and then every link is signed for one path and
  // presented at another. That failure looks like `SignatureDoesNotMatch`, names
  // nothing, and would be admitted here by a setting nobody could test. Refused
  // while this setting is new enough that no deployment is on it.
  if (
    parsed.username !== "" ||
    parsed.password !== "" ||
    (parsed.pathname !== "" && parsed.pathname !== "/") ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error(
      `EGMA_BLOB_PUBLIC_URL must be only the address a browser reaches the ` +
        `recording store at — scheme, host and port, nothing else — and this ` +
        `one carries more. Set it to ${parsed.origin}. A signed link covers ` +
        `the path it was signed for, so Egma cannot serve a store under a ` +
        `sub-path a proxy then rewrites.`,
    );
  }

  const accessKeyId = environment.EGMA_BLOB_ACCESS_KEY_ID?.trim() || "";
  const secretAccessKey = environment.EGMA_BLOB_SECRET_ACCESS_KEY?.trim() || "";
  const missing = [
    accessKeyId === "" ? "EGMA_BLOB_ACCESS_KEY_ID" : "",
    secretAccessKey === "" ? "EGMA_BLOB_SECRET_ACCESS_KEY" : "",
  ].filter((name) => name !== "");
  if (missing.length > 0) {
    throw new Error(
      `EGMA_BLOB_PUBLIC_URL names a recording store and this deployment is ` +
        `missing ${missing.join(" and ")}. Both halves are one credential, ` +
        "and it should be the read-only one — the control plane never writes " +
        "to the store, and a leaked read credential must not be usable to " +
        "overwrite a customer's recording.",
    );
  }

  // The bucket name is checked here for the reason the simulator checks its
  // own: a name carrying a separator would put a prefix nobody configured in
  // front of every key, so a reference that resolves for the simulator would
  // resolve to nothing here, and the store's answer would name the object.
  const bucket = environment.EGMA_BLOB_BUCKET?.trim() || DEFAULT_BLOB_BUCKET;
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u.test(bucket)) {
    throw new Error(
      `EGMA_BLOB_BUCKET must be a bucket name — lower case, 3 to 63 ` +
        `characters, letters, digits, dots and hyphens, and no separator; ` +
        `got ${bucket}`,
    );
  }

  return {
    publicUrl: parsed.origin,
    bucket,
    region: blobRegion(environment, parsed),
    accessKeyId,
    secretAccessKey,
  };
}

/**
 * Require an explicit recording region for .amazonaws.com endpoints.
 * Other endpoints use the configured region or the MinIO-compatible default.
 */
function blobRegion(environment: NodeJS.ProcessEnv, address: URL): string {
  const named = environment.EGMA_BLOB_REGION?.trim() || "";
  if (named !== "") return named;

  if (address.hostname.endsWith(".amazonaws.com")) {
    throw new Error(
      `EGMA_BLOB_PUBLIC_URL points at ${address.hostname}, which is Amazon's ` +
        "own S3, and no EGMA_BLOB_REGION was set. A signature carries the " +
        "region and S3 refuses one signed for another, so Egma would sign " +
        "every recording for us-east-1 and every one of them would come back " +
        "SignatureDoesNotMatch. Set EGMA_BLOB_REGION to the bucket's region — " +
        "the same one the simulator uploads with, which is EGMA_S3_REGION if " +
        "you set them from one place.",
    );
  }
  return DEFAULT_BLOB_REGION;
}

/** The bucket the deployment creates on first start; nobody running the compose file names it. */
const DEFAULT_BLOB_BUCKET = "egma-recordings";

/** What a store that ignores regions is signed for. See `blobRegion`. */
const DEFAULT_BLOB_REGION = "us-east-1";
