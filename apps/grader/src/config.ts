import { hostname } from "node:os";

/**
 * What the grader service is configured with, and where a bad value is caught.
 *
 * Everything has a working default except where the two stores are, and those
 * are required on the same terms the API requires them: a grader that started
 * without somewhere to read conversations from and somewhere to write verdicts
 * to would look healthy and judge nothing. A misconfigured deployment is loud at
 * boot rather than silent for a week.
 */
export type Config = {
  readonly databaseUrl: string;
  readonly clickhouseUrl: string;
  /** This copy's own name for itself, in claims and in the log. */
  readonly claimant: string;
  /** How many conversations this copy judges at once. */
  readonly capacity: number;
  /** How often it says it is still alive while it holds one. */
  readonly heartbeatSeconds: number;
  /** How long its claim survives its silence. */
  readonly leaseSeconds: number;
  /** The backstop, for a notification nothing was listening for. */
  readonly sweepSeconds: number;
  /** How long a production trace has to be quiet before it is judged anyway. */
  readonly traceIdleSeconds: number;
  readonly logLevel: LogLevel;
};

export const LOG_LEVELS = ["DEBUG", "INFO", "WARN", "ERROR"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/**
 * How many conversations one copy judges at once.
 *
 * Four, matching the simulator's, and for the same reason: a copy claims only
 * what it has room for, so a burst of finished simulations degrades to a queue
 * rather than to overload. Raise it, or start a second copy, and they distribute
 * between themselves with nothing in front of them.
 */
const DEFAULT_CAPACITY = 4;

/**
 * How often a copy holding work says so. Well inside the lease, so that an
 * ordinary pause — a slow judge model, a long transcript — is never mistaken for
 * a copy that died.
 */
const DEFAULT_HEARTBEAT_SECONDS = 15;

/** How long a claim survives silence before another copy may take the job. */
const DEFAULT_LEASE_SECONDS = 120;

/**
 * How often a copy asks anyway.
 *
 * **This is not how work arrives.** Work arrives on a notification raised by the
 * transaction that finished the conversation, which is why nothing here promises
 * a latency and why no interval is on the path a verdict travels. This is the
 * backstop underneath it: a notification raised while every copy was restarting
 * reaches nobody, and the queue would otherwise wait for the next conversation
 * to wake somebody up. Half a minute, because it costs one indexed query and
 * catches the case that would otherwise look like grading having stopped.
 */
const DEFAULT_SWEEP_SECONDS = 30;

/**
 * How long a production trace has to be quiet before egma judges it without a
 * closed root span.
 *
 * **This is the idle-timeout fallback, and it is the only path in this service
 * where a conversation waits on a clock.** A well-behaved exporter closes the
 * root span when the call ends, egma is woken by it, and this number decides
 * nothing. It exists for the exporter that never closes one — a crashed agent, a
 * framework that does not emit a session span — where the event to wait for is
 * the absence of events and no notification can ever arrive.
 *
 * Five minutes, matching the queue's own default, and the number is a
 * compromise: too short judges a caller left on hold halfway through their call,
 * too long leaves a broken exporter's conversations unjudged all afternoon.
 * Erring long, because the deployment paying for it is already misconfigured and
 * a verdict arriving late is a thing this product promises nothing about.
 */
const DEFAULT_TRACE_IDLE_SECONDS = 300;

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

/**
 * A name for this copy, when the deployment did not give it one.
 *
 * The host and the process, which is what tells two copies apart on one machine
 * and two containers apart in one compose project. Operational only: it is never
 * an identity in egma's tables, and nothing is ever resolved from it.
 */
function defaultClaimant(): string {
  return `grader-${hostname()}-${process.pid}`;
}

export function loadConfig(): Config {
  const claimant = process.env["EGMA_GRADER_CLAIMANT"]?.trim();

  const config: Config = {
    databaseUrl: required("DATABASE_URL"),
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
    traceIdleSeconds: positiveWholeNumber(
      "EGMA_GRADER_TRACE_IDLE_SECONDS",
      DEFAULT_TRACE_IDLE_SECONDS,
    ),
    logLevel: logLevel(),
  };

  // A heartbeat slower than the lease is a copy that loses every job it holds
  // while it is working on it — the queue would hand the same conversation
  // round the fleet forever, and every copy would look fine.
  if (config.heartbeatSeconds >= config.leaseSeconds) {
    throw new Error(
      "EGMA_GRADER_HEARTBEAT_SECONDS must be well under EGMA_GRADER_LEASE_SECONDS, or a copy loses the job it is working on",
    );
  }

  return config;
}
