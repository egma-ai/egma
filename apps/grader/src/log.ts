import type { LogLevel } from "./config.ts";

/**
 * One line per thing that happened, as JSON on standard output.
 *
 * No dependency, because there is nothing here worth one: a container's log is
 * whatever the process writes to its output, and a service with no inbound
 * surface has no request to correlate. What it must never carry is a
 * credential — nothing here reads one, and nothing here is ever handed a
 * conversation's contents.
 */

const RANK: Readonly<Record<LogLevel, number>> = {
  DEBUG: 10,
  INFO: 20,
  WARN: 30,
  ERROR: 40,
};

export type Log = {
  debug(message: string, about?: Record<string, unknown>): void;
  info(message: string, about?: Record<string, unknown>): void;
  warn(message: string, about?: Record<string, unknown>): void;
  error(message: string, about?: Record<string, unknown>): void;
};

export function makeLog(level: LogLevel, claimant: string): Log {
  const write = (
    at: LogLevel,
    message: string,
    about?: Record<string, unknown>,
  ): void => {
    if (RANK[at] < RANK[level]) return;
    process.stdout.write(
      `${JSON.stringify({
        at: new Date().toISOString(),
        level: at,
        claimant,
        message,
        ...about,
      })}\n`,
    );
  };

  return {
    debug: (message, about) => write("DEBUG", message, about),
    info: (message, about) => write("INFO", message, about),
    warn: (message, about) => write("WARN", message, about),
    error: (message, about) => write("ERROR", message, about),
  };
}

/** What an error says, without a stack and without whatever it wrapped. */
export function saying(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
