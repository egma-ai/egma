import type { IngestionStore } from "./object-store.ts";
import type { IngestionSettings } from "./settings.ts";
type DeploymentRole = IngestionSettings["role"];

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
 * Configure the ingestion bucket using an endpoint this API can reach and
 * a separate ingestion credential. If an endpoint is set, require both key
 * fields. This address serves server traffic, unlike EGMA_BLOB_PUBLIC_URL.
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
 * Require an explicit ingestion region for .amazonaws.com endpoints.
 * Other endpoints use the configured region or the MinIO-compatible default.
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
export function loadIngestionSettings(
  environment: NodeJS.ProcessEnv,
  defaults: { readonly role?: DeploymentRole; readonly logDirectory?: string } = {},
): IngestionSettings {
  return {
    role: defaults.role ?? deploymentRole(environment),
    store: ingestionStore(environment),
    logDirectory:
      environment.EGMA_INGESTION_LOG_DIR?.trim() || defaults.logDirectory || DEFAULT_INGESTION_LOG_DIR,
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
