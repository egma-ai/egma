import { loadIngestionSettings, type IngestionSettings } from "@egma/ingestion";
import { hostname } from "node:os";

/**
 * Validate grader configuration at startup. Store addresses are required;
 * other settings have defaults.
 */
export type Config = {
  readonly databaseUrl: string;
  readonly ingestion: IngestionSettings;
  readonly clickhouseUrl: string;
  /** This copy's own name for itself, in claims and in the log. */
  readonly claimant: string;
  /** How many conversations this copy grades at once. */
  readonly capacity: number;
  /** How often it says it is still alive while it holds one. */
  readonly heartbeatSeconds: number;
  /** How long its claim survives its silence. */
  readonly leaseSeconds: number;
  /** The backstop, for a notification nothing was listening for. */
  readonly sweepSeconds: number;
  /**
   * `EGMA_STRIPE_SECRET_KEY`, as the deployment named it, or `undefined`.
   *
   * **A setting and never a mode**, read here beside every other deployment
   * value rather than off the process where it is used. Its presence selects
   * the cloud billing adapter, which this service asks at its own claim: a
   * grading job's only spend is the judge's model usage, so the claim asks
   * whether Egma's key may fund it before it hands a job out. Empty is every
   * deployment that charges nobody, and nothing is imported at all.
   */
  readonly stripeSecretKey: string | undefined;
  readonly logLevel: LogLevel;
};

export const LOG_LEVELS = ["DEBUG", "INFO", "WARN", "ERROR"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** Maximum grading jobs claimed concurrently by this service instance. */
const DEFAULT_CAPACITY = 4;

/** Heartbeat interval must remain below the job lease to retain long-running work. */
const DEFAULT_HEARTBEAT_SECONDS = 15;

/** How long a claim survives silence before another copy may take the job. */
const DEFAULT_LEASE_SECONDS = 120;

/**
 * Poll as a fallback for notifications missed during restart or disconnect.
 * Normal grading work arrives through Postgres notifications.
 */
const DEFAULT_SWEEP_SECONDS = 30;

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value === "") {
    throw new Error(
      `${name} is not set, and the grader service has nowhere to work without it`,
    );
  }
  return value;
}

function positiveWholeNumber(name: string, fallback: number): number {
  const written = process.env[name]?.trim();
  if (written === undefined || written === "") return fallback;

  const value = Number(written);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} is a positive whole number, and "${written}" is not`);
  }
  return value;
}

function logLevel(): LogLevel {
  const written = process.env["EGMA_GRADER_LOG_LEVEL"]?.trim().toUpperCase();
  if (written === undefined || written === "") return "INFO";

  const found = LOG_LEVELS.find((level) => level === written);
  if (found === undefined) {
    throw new Error(
      `EGMA_GRADER_LOG_LEVEL is one of ${LOG_LEVELS.join(", ")}, and "${written}" is not`,
    );
  }
  return found;
}

/** Default worker name derived from hostname and process ID; operational only. */
function defaultClaimant(): string {
  return `grader-${hostname()}-${process.pid}`;
}

export function loadConfig(): Config {
  const claimant = process.env["EGMA_GRADER_CLAIMANT"]?.trim();

  const config: Config = {
    databaseUrl: required("DATABASE_URL"),
    ingestion: loadIngestionSettings(process.env, { role: "ingest", logDirectory: "/var/lib/egma/grader-ingestion" }),
    clickhouseUrl: required("CLICKHOUSE_URL"),
    claimant: claimant === undefined || claimant === "" ? defaultClaimant() : claimant,
    capacity: positiveWholeNumber("EGMA_GRADER_CAPACITY", DEFAULT_CAPACITY),
    heartbeatSeconds: positiveWholeNumber(
      "EGMA_GRADER_HEARTBEAT_SECONDS",
      DEFAULT_HEARTBEAT_SECONDS,
    ),
    leaseSeconds: positiveWholeNumber(
      "EGMA_GRADER_LEASE_SECONDS",
      DEFAULT_LEASE_SECONDS,
    ),
    sweepSeconds: positiveWholeNumber(
      "EGMA_GRADER_SWEEP_SECONDS",
      DEFAULT_SWEEP_SECONDS,
    ),
    stripeSecretKey: process.env["EGMA_STRIPE_SECRET_KEY"]?.trim() || undefined,
    logLevel: logLevel(),
  };

  // Reject heartbeat intervals that would let active job leases expire.
  if (config.heartbeatSeconds >= config.leaseSeconds) {
    throw new Error(
      "EGMA_GRADER_HEARTBEAT_SECONDS must be well under EGMA_GRADER_LEASE_SECONDS, or a copy loses the job it is working on",
    );
  }

  return config;
}
