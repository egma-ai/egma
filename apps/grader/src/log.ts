import pino, { type Logger } from "pino";

import type { LogLevel } from "./config.ts";

/** The small part of Pino the grader service writes through. */
export type Log = Pick<Logger, "debug" | "info" | "warn" | "error">;

type Attribute = string | number | boolean;

/**
 * Pino writes one JSON line to standard output. The deployment collector reads
 * that line and exports it as OTLP. Pino's OpenTelemetry instrumentation adds
 * active trace context without creating a second log export path.
 */
export function makeLog(level: LogLevel, claimant: string): Logger {
  return pino({
    level: level.toLowerCase(),
    base: { "service.instance.id": claimant },
  });
}

/** Stable fields common to every deliberate grader event. */
export function platformEvent(
  name: `egma.${string}`,
  attributes: Readonly<Record<string, Attribute>> = {},
): Record<string, Attribute> {
  return {
    "otel.event.name": name,
    "egma.log_schema_version": 1,
    ...attributes,
  };
}

/** What an error says for the queue's own stored retry reason. */
export function saying(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A useful exception class without copying a message or stack into telemetry.
 * Either may contain provider output, a prompt, or another customer value.
 */
export function safeExceptionType(error: unknown): string {
  const type = error instanceof Error ? error.name : typeof error;
  return /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(type) ? type : "Error";
}
