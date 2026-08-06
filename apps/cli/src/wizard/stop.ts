/**
 * The two ways a walk ends early, and how they are told apart.
 *
 * Both cancel the same way — one abort signal, which shuts the driven agent
 * down — but they are different events and the exit line must say which
 * happened. The reason rides on the signal.
 */

import type { ExitReport } from "./exit-line.ts";

export type StopReason = "quit" | "interrupt";

export function stopReasonOf(signal: AbortSignal): StopReason {
  return signal.reason === "quit" ? "quit" : "interrupt";
}

export function stopReport(signal: AbortSignal, agentName: string | null): ExitReport {
  return stopReasonOf(signal) === "quit" ? { kind: "quit" } : { kind: "interrupted", agentName };
}

/** Settles when `work` settles, or as soon as the signal aborts. */
export function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
  if (signal.aborted) return Promise.resolve(undefined);
  return new Promise<T | undefined>((resolve, reject) => {
    const onAbort = (): void => resolve(undefined);
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
