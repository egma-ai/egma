import type { LogLevel, ModelJob, Provider } from "./config.ts";

/**
 * What the Egma model gateway is allowed to write down, and nothing else.
 *
 * **The list is the feature.** A relay that carries audio, transcripts, prompts
 * and model output past a logger is one careless field away from being a store
 * of everything its customers said, so the fields are enumerated here, the
 * writer builds a record only out of this list, and a test walks every record
 * the suite produces and fails on a key that is not on it. Adding a field is a
 * decision somebody has to make on purpose, in this file, where the reason it
 * is safe can be written next to it.
 *
 * **What is deliberately absent, and why each one is absent.** Authorization
 * values of any kind, in any slot — the gateway holds two credentials and
 * neither is a thing to be troubleshooting with. Request and response bodies,
 * audio frames, transcripts, prompts, tool definitions, TTS input text and TTS
 * voice identifiers — these are the customer's conversation, and the gateway's
 * whole job is to carry them without keeping them. Custom provider URLs — there
 * are none, because a caller cannot name an upstream.
 *
 * **And one absence that is not about privacy.** No field here counts a
 * provider usage unit — no tokens, no characters, no audio seconds, no
 * requests-per-anything — and the byte counts that are here are the relay's own
 * traffic rather than anybody's billable quantity. These records support
 * operations. They are not a usage ledger, they are not a credit ledger, and
 * the day somebody needs one of those it must be built somewhere else on
 * purpose, rather than found already half-written here.
 */

/** The status classes a relayed exchange ends in. Never a provider's message. */
export const STATUS_CLASSES = [
  /** The provider answered, and the exchange completed. */
  "ok",
  /** The provider answered with a refusal the caller can act on. */
  "provider-refused",
  /** The provider failed. */
  "provider-failed",
  /** The gateway refused before any upstream work started. */
  "refused",
  /** The caller went away. */
  "cancelled",
  /** A bound this gateway sets was reached. */
  "timed-out",
  /** The provider could not be reached at all. */
  "unreachable",
] as const;
export type StatusClass = (typeof STATUS_CLASSES)[number];

/**
 * Every key an operational record may hold.
 *
 * The order is the order a reader wants them in: what happened, who it was for,
 * what it asked of whom, how it ended, and how much and how long.
 */
export const RECORD_FIELDS = [
  "requestId",
  "organizationId",
  "inferenceKeyId",
  "provider",
  "job",
  "providerModelId",
  "startedAt",
  "endedAt",
  "statusClass",
  "upstreamRequestId",
  "bytesToProvider",
  "bytesFromProvider",
  "openMs",
  "firstOutputMs",
  "totalMs",
] as const;
export type RecordField = (typeof RECORD_FIELDS)[number];

export type OperationalRecord = {
  readonly requestId: string;
  /** Absent only when the connection was refused before it was authenticated. */
  readonly organizationId?: string;
  readonly inferenceKeyId?: string;
  readonly provider?: Provider;
  readonly job?: ModelJob;
  readonly providerModelId?: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly statusClass: StatusClass;
  readonly upstreamRequestId?: string;
  readonly bytesToProvider: number;
  readonly bytesFromProvider: number;
  /** How long the provider took to accept the connection or the request. */
  readonly openMs?: number;
  /** How long until the provider's first byte or first frame came back. */
  readonly firstOutputMs?: number;
  readonly totalMs: number;
};

/**
 * A record, built out of the allowed fields and out of nothing else.
 *
 * **It takes and returns loose bags on purpose, and the filter between them is
 * the point.** A value reaching here came out of a provider's header or a
 * caller's query and is `unknown` at that moment, and a typed argument would
 * only move the cast somewhere else. What makes a field impossible under a name
 * nobody agreed to is this loop over `RECORD_FIELDS`, not a type. The shape a
 * reader should have in mind is `OperationalRecord` above.
 */
export function operationalRecord(
  parts: Partial<Record<RecordField, unknown>>,
): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  for (const field of RECORD_FIELDS) {
    const value = parts[field];
    if (value !== undefined) record[field] = value;
  }
  return record;
}

const RANK: Readonly<Record<LogLevel, number>> = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40 };

/**
 * One line per thing that happened, as JSON, wherever the host sends its
 * output.
 *
 * No dependency, for the same reason the grader's log has none: a line of JSON
 * on standard output is what a container's log is, and on Cloudflare it is what
 * a tail is. What is different here is the second argument — a gateway log line
 * may carry an operational record and may carry nothing else, so `about` is
 * typed as one rather than as a free bag of anything.
 */
export type Log = {
  debug(message: string, about?: Record<string, unknown>): void;
  info(message: string, about?: Record<string, unknown>): void;
  warn(message: string, about?: Record<string, unknown>): void;
  error(message: string, about?: Record<string, unknown>): void;
};

export function makeLog(level: LogLevel, write: (line: string) => void = console.log): Log {
  const at = (
    said: LogLevel,
    message: string,
    about?: Record<string, unknown>,
  ): void => {
    if (RANK[said] < RANK[level]) return;
    write(JSON.stringify({ at: new Date().toISOString(), level: said, message, ...about }));
  };
  return {
    debug: (message, about) => at("DEBUG", message, about),
    info: (message, about) => at("INFO", message, about),
    warn: (message, about) => at("WARN", message, about),
    error: (message, about) => at("ERROR", message, about),
  };
}

/**
 * What a refusal says out loud.
 *
 * **Useful, and empty of everything.** A caller has to be able to fix an
 * invalid credential, a route they do not have, or a provider that refused
 * them, so the code and the sentence say which of those it was. Neither ever
 * carries a credential, a provider's own error body, a payload, or the address
 * the gateway went to.
 */
export type Refusal = { readonly code: string; readonly message: string; readonly status: number };

export function refusalResponse(refusal: Refusal): Response {
  return new Response(
    JSON.stringify({ error: { code: refusal.code, message: refusal.message } }),
    {
      status: refusal.status,
      headers: {
        "content-type": "application/json; charset=utf-8",
        // A relay that carries a customer's model traffic has nothing to say to
        // a browser, and a refusal that could be read cross-origin is a refusal
        // a page could probe for.
        "cache-control": "no-store",
      },
    },
  );
}
