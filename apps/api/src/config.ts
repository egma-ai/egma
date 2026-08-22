import type { PlatformSettingValues } from "@egma/db";
import {
  providerCredentialSource,
  type ProviderCredentialSource,
} from "@egma/provider-credentials";

import { SERVICE_TOKEN_PREFIX } from "./auth/service-token.ts";
import type { SmtpSettings } from "./auth/email.ts";
import type { IngestionStore } from "./ingestion/object-store.ts";
import type { BlobStore } from "./recordings/signed-link.ts";

/** Which source owns the carrier route after the platform has started. */
export type CarrierSettingsSource = "platform" | "environment";

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

/**
 * Everything the durable ingestion path is told, in one place.
 *
 * **The numbers here are documented starting values, not proven capacity.**
 * Each one is set where the code that reads it can survive it and where the
 * bound it sits under is known — the segment byte bound sits under the trace
 * store's own insert bound, the flush interval sits inside the product's
 * two-second visibility target — and the release's capacity proof is what
 * turns any of them into a claim.
 */
export type IngestionSettings = {
  readonly role: DeploymentRole;
  /**
   * The ingestion bucket, or `undefined` on a deployment that has named no
   * endpoint. Naming the endpoint is what selects it, the way naming the
   * browser's address selects the recording store above.
   */
  readonly store: IngestionStore | undefined;
  /** Where the local write-ahead log lives. A writable directory, on a volume. */
  readonly logDirectory: string;
  readonly logMaxBytes: number;
  readonly logMaxRecords: number;
  /** How long the oldest staged record waits for company before its segment seals. */
  readonly flushMilliseconds: number;
  /** Uncompressed NDJSON bytes, under the trace store's own insert bound. */
  readonly segmentMaxBytes: number;
  readonly segmentMaxRecords: number;
  /** Past this, a request is answered retryably with its staged record retained. */
  readonly requestTimeoutMilliseconds: number;
  /** How often the whole pending prefix is listed, restart scan aside. */
  readonly scanIntervalMilliseconds: number;
};

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
   * What carrier and connection credentials are sealed under before they touch a row —
   * 32 random bytes as 64 hex characters (`openssl rand -hex 32`). Malformed
   * or absent means the service will not start. Model-provider keys do not use
   * this path: they stay in the deployment credential source and are read only
   * when model work starts.
   */
  readonly encryptionKey: string;
  /**
   * One organization on this deployment, and the first person to sign up claims
   * it. Sentry's flag, and Sentry's reason: without it anyone who can reach the
   * URL signs up, joins the only organization, and — because everyone defaults
   * to `admin` — administers somebody else's egma.
   *
   * On by default, because the default deployment is a self-hosted one. A
   * multi-tenant deployment turns it off; nothing derives from which one this
   * is.
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
   * What the simulator shows this API to claim simulation work — `egma_st_`
   * and then a secret, the same value both containers read. Absent means the
   * service will not start: the claim answers carry customers' live provider
   * credentials, port 3100 is published on the host, and a claim door that
   * quietly served whoever asked would hand those credentials to the LAN.
   * The compose file has no default for it, on the `EGMA_AUTH_SECRET` pattern:
   * a token written into a public repository is a token every reader of it
   * holds, so a deployment that states none is refused at start by name rather
   * than started with a claim door the world already has the key to.
   */
  readonly simulatorServiceToken: string;
  /**
   * Where a claimed simulation reads the current provider-key bundle.
   *
   * Cloud reads AWS Secrets Manager for every unit of work. Self-host reads
   * the operator's provider variables. Neither path writes a model key to
   * Postgres, and neither keeps a cross-work key cache.
   */
  readonly providerCredentials: ProviderCredentialSource;
  /**
   * Which source owns the carrier route.
   *
   * `platform` is the default. Environment values seed a missing route, and a
   * complete route already in the platform store stays unchanged.
   *
   * `environment` makes the deployment environment the source of truth.
   * Startup reconciles the carrier route after seeding on every start. A
   * changed complete route replaces the stored route, and no carrier values
   * removes it.
   *
   * This decision is independent of whether the deployment serves one or
   * several organizations. Tenancy does not say who owns a carrier route.
   */
  readonly carrierSettingsSource: CarrierSettingsSource;
  /**
   * The carrier route this environment offers the platform on start.
   *
   * A self-host operator can write the route through `egma self-host setup`.
   * An automated deployment can provide the same complete route through its
   * environment. Model, speech, voice, VAD and media choices are not platform
   * settings and cannot enter through this value.
   *
   * Empty is ordinary and means this deployment has no shared phone route.
   *
   * See `carrierSettingsSource` for the explicit choice that lets environment
   * input replace or remove an existing route.
   */
  readonly platformSettings: PlatformSettingValues;
  /**
   * The object store voice simulations' recordings live in, or `undefined` on a
   * deployment that has named none.
   *
   * **Naming the browser's address is what selects it**, the way naming an
   * endpoint is what sends the simulator's recordings to object storage in the
   * first place. Absent, the control plane can still read and report every
   * simulation it could before; it simply cannot hand anybody a link to the
   * audio, and it says so in a sentence naming the variable rather than
   * answering an empty player.
   *
   * The address here is **the browser's**, and this process holds no other one.
   * It never opens a connection to the store — signing is arithmetic — so there
   * is no internal endpoint in this configuration for a future reader to sign
   * against by mistake. See `recordings/signed-link.ts`.
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

function carrierSettingsSource(
  environment: NodeJS.ProcessEnv,
): CarrierSettingsSource {
  const raw = environment.EGMA_CARRIER_SETTINGS_SOURCE?.trim();
  if (raw === undefined || raw === "") return "platform";
  if (raw === "platform" || raw === "environment") return raw;
  throw new Error(
    "EGMA_CARRIER_SETTINGS_SOURCE must be platform or environment, not " + raw,
  );
}

/** Which halves of ingestion this process serves. See `DeploymentRole`. */
function deploymentRole(environment: NodeJS.ProcessEnv): DeploymentRole {
  const raw = environment.EGMA_ROLE?.trim();
  if (raw === undefined || raw === "") return "all";
  if (raw === "all" || raw === "ingest" || raw === "drain") return raw;
  throw new Error("EGMA_ROLE must be all, ingest or drain, not " + raw);
}

/**
 * One ingestion bound, as a positive whole number.
 *
 * Refused by name rather than coerced, because every one of these is a bound
 * that decides what happens under load: a zero or a stray unit suffix would
 * turn a bound into a refusal of everything, at the moment there is most
 * traffic to refuse.
 */
function bound(
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number {
  const raw = environment[name]?.trim();
  if (raw === undefined || raw === "") return fallback;
  const held = Number(raw);
  if (!Number.isInteger(held) || held <= 0) {
    throw new Error(`${name} is not a positive whole number: ${raw}`);
  }
  return held;
}

/**
 * The ingestion bucket and the credential confined to it, or `undefined` where
 * nobody named an endpoint.
 *
 * **This address is Egma's own, and that is the difference from
 * `EGMA_BLOB_PUBLIC_URL` next door.** The control plane has never opened a
 * connection to an object store before this release — recordings are signed
 * arithmetic and fetched by a browser — so this is the first setting in the
 * file that names where *this container* reaches a store. On the bundled
 * deployment that is `http://minio:9000`, which is exactly the value the
 * recordings setting must never hold.
 *
 * All of it or none of it, refused at startup by name, on the recording store's
 * discipline: half a credential accepts evidence it cannot make durable, and a
 * request that answers `503` for a reason nobody can see is worse than a
 * process that refuses to start naming the variable.
 */
function ingestionStore(
  environment: NodeJS.ProcessEnv,
): IngestionStore | undefined {
  const endpoint = environment.EGMA_INGEST_ENDPOINT?.trim() || "";
  if (endpoint === "") return undefined;

  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error(
      `EGMA_INGEST_ENDPOINT is not a URL: ${endpoint}. It is the address this ` +
        "container reaches the ingestion bucket at, and on the bundled " +
        "deployment it looks like http://minio:9000.",
    );
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(
      `EGMA_INGEST_ENDPOINT speaks ${parsed.protocol} and Egma reaches an ` +
        "object store over http: or https:",
    );
  }
  // Scheme, host and port, and nothing after them — the narrowing the recording
  // store's address makes, for a reason of its own. A credential in this URL
  // would be a second place a credential lives, silently outranking the pair
  // below; a path would be read as part of the bucket's address by one client
  // and dropped by another, and a segment written under one reading would be
  // invisible to a listing made under the other.
  if (
    parsed.username !== "" ||
    parsed.password !== "" ||
    (parsed.pathname !== "" && parsed.pathname !== "/") ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error(
      `EGMA_INGEST_ENDPOINT must be only the address Egma reaches the ` +
        `ingestion store at — scheme, host and port, nothing else — and this ` +
        `one carries more. Set it to ${parsed.origin}, and set the credential ` +
        `in EGMA_INGEST_ACCESS_KEY_ID and EGMA_INGEST_SECRET_ACCESS_KEY rather ` +
        `than in the address.`,
    );
  }

  const accessKeyId = environment.EGMA_INGEST_ACCESS_KEY_ID?.trim() || "";
  const secretAccessKey = environment.EGMA_INGEST_SECRET_ACCESS_KEY?.trim() || "";
  const missing = [
    accessKeyId === "" ? "EGMA_INGEST_ACCESS_KEY_ID" : "",
    secretAccessKey === "" ? "EGMA_INGEST_SECRET_ACCESS_KEY" : "",
  ].filter((name) => name !== "");
  if (missing.length > 0) {
    throw new Error(
      `EGMA_INGEST_ENDPOINT names an ingestion store and this deployment is ` +
        `missing ${missing.join(" and ")}. Both halves are one credential, and ` +
        "it is its own — never the recording store's read pair and never the " +
        "simulator's write pair. It is confined to this bucket's pending " +
        "prefix, so one workload cannot read, delete or expire the other's " +
        "objects.",
    );
  }

  const bucket = environment.EGMA_INGEST_BUCKET?.trim() || DEFAULT_INGEST_BUCKET;
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u.test(bucket)) {
    throw new Error(
      `EGMA_INGEST_BUCKET must be a bucket name — lower case, 3 to 63 ` +
        `characters, letters, digits, dots and hyphens, and no separator; ` +
        `got ${bucket}`,
    );
  }

  return {
    endpoint: parsed.origin,
    bucket,
    region: ingestRegion(environment, parsed),
    accessKeyId,
    secretAccessKey,
  };
}

/**
 * What the ingestion client signs for.
 *
 * The recording store's rule, one bucket over and for the same two reasons:
 * MinIO ignores the region and every signature must still carry one, so a
 * deployment that named none works; and on Amazon's own S3 the default is not a
 * default but a wrong answer, refused by name rather than signed with. A bucket
 * in `eu-west-1` signed for `us-east-1` refuses every upload with
 * `SignatureDoesNotMatch`, which names neither the region nor the variable —
 * and here that is not a recording that will not play, it is acceptance
 * answering `503` for every request the deployment receives.
 */
function ingestRegion(environment: NodeJS.ProcessEnv, address: URL): string {
  const named = environment.EGMA_INGEST_REGION?.trim() || "";
  if (named !== "") return named;

  if (address.hostname.endsWith(".amazonaws.com")) {
    throw new Error(
      `EGMA_INGEST_ENDPOINT points at ${address.hostname}, which is Amazon's ` +
        "own S3, and no EGMA_INGEST_REGION was set. A signature carries the " +
        "region and S3 refuses one signed for another, so Egma would sign " +
        "every segment for us-east-1 and every acceptance would fail. Set " +
        "EGMA_INGEST_REGION to the ingestion bucket's region.",
    );
  }
  return DEFAULT_INGEST_REGION;
}

/** Everything the durable ingestion path is told. See `IngestionSettings`. */
function ingestionSettings(
  environment: NodeJS.ProcessEnv,
): IngestionSettings {
  return {
    role: deploymentRole(environment),
    store: ingestionStore(environment),
    logDirectory:
      environment.EGMA_INGESTION_LOG_DIR?.trim() || DEFAULT_INGESTION_LOG_DIR,
    logMaxBytes: bound(environment, "EGMA_INGESTION_LOG_MAX_BYTES", 536_870_912),
    logMaxRecords: bound(environment, "EGMA_INGESTION_LOG_MAX_RECORDS", 200_000),
    flushMilliseconds: bound(
      environment,
      "EGMA_INGESTION_FLUSH_MILLISECONDS",
      500,
    ),
    segmentMaxBytes: bound(
      environment,
      "EGMA_INGESTION_SEGMENT_MAX_BYTES",
      8_388_608,
    ),
    segmentMaxRecords: bound(
      environment,
      "EGMA_INGESTION_SEGMENT_MAX_RECORDS",
      5_000,
    ),
    requestTimeoutMilliseconds: bound(
      environment,
      "EGMA_INGESTION_REQUEST_TIMEOUT_MILLISECONDS",
      10_000,
    ),
    scanIntervalMilliseconds: bound(
      environment,
      "EGMA_INGESTION_SCAN_INTERVAL_MILLISECONDS",
      30_000,
    ),
  };
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
    carrierSettingsSource: carrierSettingsSource(environment),
    trustProxy: flag(environment, "EGMA_TRUST_PROXY", false),
    rateLimitPerMinute,
    simulatorServiceToken,
    providerCredentials: providerCredentialSource(environment),
    platformSettings: platformSettings(environment),
    blob: blobStore(environment, parsedBaseUrl),
    ingestion: ingestionSettings(environment),
  };
}

/**
 * The one live platform choice: how a phone call reaches the carrier.
 *
 * Model, speech, voice, VAD and media choices are deliberately absent. Model
 * and voice choices are immutable persona content; provider keys come from the
 * source above; VAD and media are simulator deployment details. Putting any of
 * them back into independent platform rows would recreate the mixed STT state
 * that failed before the first turn in production.
 */
function platformSettings(
  environment: NodeJS.ProcessEnv,
): PlatformSettingValues {
  const offered = {
    // The carrier keeps the variable names the old phone setup already wrote,
    // so an operator upgrading meets the same words they were given before.
    carrier_trunk_address: environment.EGMA_PHONE_TRUNK_ADDRESS?.trim(),
    carrier_trunk_number: environment.EGMA_PHONE_SOURCE_NUMBER?.trim(),
    carrier_trunk_username: environment.EGMA_PHONE_TRUNK_USERNAME?.trim(),
    carrier_trunk_password: environment.EGMA_PHONE_TRUNK_PASSWORD?.trim(),
  };

  const carrierVariables = [
    ["carrier_trunk_address", "EGMA_PHONE_TRUNK_ADDRESS"],
    ["carrier_trunk_number", "EGMA_PHONE_SOURCE_NUMBER"],
    ["carrier_trunk_username", "EGMA_PHONE_TRUNK_USERNAME"],
    ["carrier_trunk_password", "EGMA_PHONE_TRUNK_PASSWORD"],
  ] as const;
  const carrierPresent = carrierVariables.filter(
    ([name]) => (offered[name] ?? "") !== "",
  );
  const ipAuthenticatedCarrier =
    offered.carrier_trunk_address !== undefined &&
    offered.carrier_trunk_address !== "" &&
    offered.carrier_trunk_number !== undefined &&
    offered.carrier_trunk_number !== "" &&
    (offered.carrier_trunk_username ?? "") === "" &&
    (offered.carrier_trunk_password ?? "") === "";
  const credentialAuthenticatedCarrier =
    carrierPresent.length === carrierVariables.length;
  if (
    carrierPresent.length > 0 &&
    !ipAuthenticatedCarrier &&
    !credentialAuthenticatedCarrier
  ) {
    const missing = carrierVariables
      .filter(([name]) => (offered[name] ?? "") === "")
      .map(([, variable]) => variable);
    throw new Error(
      "the phone carrier environment is either a trunk address and source " +
        "number for source-IP authentication, or those two plus a SIP " +
        `username and password. This deployment is missing ${missing.join(" and ")}. ` +
        "Set EGMA_PHONE_TRUNK_ADDRESS and EGMA_PHONE_SOURCE_NUMBER together, " +
        "and if this carrier uses credentials, also set both " +
        "EGMA_PHONE_TRUNK_USERNAME and EGMA_PHONE_TRUNK_PASSWORD.",
    );
  }

  // Compose passes an unset optional through as an empty string rather than
  // leaving it out, so "" and "never set" have to mean the same thing.
  return Object.fromEntries(
    Object.entries(offered).filter(([, value]) => (value ?? "") !== ""),
  ) as PlatformSettingValues;
}

/**
 * The bucket that holds recordings and the read-only credential that reaches
 * it, or `undefined` where nobody named one.
 *
 * **The address is the browser's, and that is this whole setting's reason for
 * existing.** A signed link is bound by signature to the host it was signed for.
 * The API reaches MinIO at `minio:9000` inside the compose network and a browser
 * reaches it at whatever the deployment publishes — sign for one, fetch from the
 * other, and the store answers `SignatureDoesNotMatch`, which names neither
 * address and costs whoever meets it a day. So the browser's address is its own
 * variable from the first commit rather than after the first report, and it is
 * the only address this process holds.
 *
 * **The credential is read-only**, separate from the write credential the
 * simulator holds. A leaked read credential must not be usable to overwrite a
 * customer's call recording — the compose file's bucket job creates a MinIO user
 * that can do nothing but `s3:GetObject`.
 *
 * All of it or none of it, refused at startup by name, on the simulator's
 * discipline: half a credential resolves no recording at all and would be
 * discovered by somebody pressing play, one simulation at a time, with the
 * store's own refusal in a log they cannot see.
 *
 * **`baseUrl` is here for one reason: the two addresses have to agree about
 * scheme.** Both are addresses of *the same browser* — one to egma, one to the
 * store — and an `https:` page may not fetch `http:` audio. See the mixed
 * content refusal below.
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
  // The two settings are one browser's two addresses, and a browser will not
  // mix their schemes. A page served over https: may not fetch audio over
  // http:: every browser blocks it as mixed content *before the request is
  // made*, so the store is never asked, the signature is never checked, and
  // the only sentence naming the reason is in a console the person pressing
  // play is not looking at. That is this effort's own bug class arriving by a
  // third route — a setting whose wrong value fails while naming nothing —
  // after the address binding and the region defaulting from nothing. Both of
  // those were closed by refusing here, by name, and so is this.
  //
  // Only this one pair is incoherent. An http: egma with an https: store is
  // fine — a plaintext page may fetch encrypted bytes — and an http: egma with
  // an http: store is the ordinary deployment this compose file ships, so
  // `http://localhost:9000` must keep starting and does.
  //
  // A plaintext store on a *remote* address is allowed and not refused,
  // deliberately: it is only reachable from an egma that is itself plaintext,
  // where the session cookie granting access to every recording already
  // crosses the same network in the clear. Refusing the audio while serving
  // the cookie would be a rule egma applies to one byte stream and not the
  // other. What it costs is said beside the example, in `.env.example`, the
  // compose file and the README, rather than decided for a self-hoster on a
  // private network egma cannot see.
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
 * What to sign for.
 *
 * MinIO ignores the region entirely and every signature must still carry one,
 * so `us-east-1` is the value that lets a deployment with no region at all
 * work — the same default the simulator uses, because the two halves sign
 * against one store and a disagreement between them is every upload working and
 * every playback failing.
 *
 * **On real S3 the default is not a default, it is a wrong answer**, and it is
 * refused rather than signed with. A bucket in `eu-west-1` signed for
 * `us-east-1` answers `SignatureDoesNotMatch` on every single recording, naming
 * neither the region nor the variable — the same nameless failure the public
 * address is a separate setting to prevent, arriving by a second route. The one
 * deployment that can be *known* to be wrong is the one whose store is AWS's
 * own, where a region is never optional, so that is the one this refuses.
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

/** The second bucket on the same store, created beside the recordings one. */
const DEFAULT_INGEST_BUCKET = "egma-ingestion";

/** What a store that ignores regions is signed for. See `ingestRegion`. */
const DEFAULT_INGEST_REGION = "us-east-1";

/**
 * Where staged evidence waits, on the named volume the deployment gives the
 * api service. It is the one path in this file that must be writable and must
 * survive a container replacement: what is in it is evidence that has been
 * accepted and is not durable yet.
 */
const DEFAULT_INGESTION_LOG_DIR = "/var/lib/egma/ingestion";
