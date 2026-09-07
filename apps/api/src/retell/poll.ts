import { AGENT_POV_BOUND_SECONDS } from "@egma/db";

import { getRetellCall, type RetellReach, type RetrievedCall } from "./api.ts";
import { retellCallHasFinalTranscript } from "./normalise.ts";

/** Planned gaps: every five seconds for one minute, then bounded backoff. */
const RETRY_WAITS_MILLISECONDS = [
  5_000, 5_000, 5_000, 5_000, 5_000, 5_000,
  5_000, 5_000, 5_000, 5_000, 5_000, 5_000,
  10_000, 20_000, 40_000, 60_000, 50_000,
] as const;

const REQUEST_TIMEOUT_MILLISECONDS = 5_000;

export type RetellSimulationPollOptions = {
  /** Gaps between planned attempts. Empty makes the immediate attempt final. */
  readonly retryWaitsMilliseconds?: readonly number[] | undefined;
  /** The default wait uses an unreferenced timer. */
  readonly sleep?: ((milliseconds: number) => Promise<void>) | undefined;
};

function waiting(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds).unref());
}

/** Bound both the request and its response body with the same abort signal. */
async function askWithin(
  apiKey: string,
  callId: string,
  reach: RetellReach,
  timeoutMilliseconds: number,
): Promise<RetrievedCall> {
  const controller = new AbortController();
  const upstream = reach.signal;
  const abortFromUpstream = (): void => controller.abort(upstream?.reason);
  if (upstream?.aborted === true) abortFromUpstream();
  else upstream?.addEventListener("abort", abortFromUpstream, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMilliseconds);
  timer.unref();
  try {
    return await getRetellCall(apiKey, callId, { ...reach, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    upstream?.removeEventListener("abort", abortFromUpstream);
  }
}

/**
 * Read at fixed offsets from the first request; request time does not extend
 * the schedule. Yield each result so the report can await just the first read.
 * Only a final transcript stops polling successfully. Never overlap requests.
 */
export async function* pollRetellSimulationCall(
  apiKey: string,
  callId: string,
  reach: RetellReach,
  options: RetellSimulationPollOptions = {},
): AsyncGenerator<RetrievedCall, void> {
  const waits = options.retryWaitsMilliseconds ?? RETRY_WAITS_MILLISECONDS;
  const sleep = options.sleep ?? waiting;
  const canceled = (): boolean => reach.signal?.aborted === true;
  const startedAt = Date.now();
  const deadline = startedAt + AGENT_POV_BOUND_SECONDS * 1_000;
  let plannedAt = startedAt;
  let retryAfter = startedAt;

  for (const gap of [0, ...waits]) {
    plannedAt += gap;
    if (canceled() || plannedAt >= deadline) return;
    if (plannedAt < retryAfter) continue;
    const wait = plannedAt - Date.now();
    if (wait > 0) await sleep(wait);
    const remaining = deadline - Date.now();
    if (canceled() || remaining <= 0) return;

    const answer = await askWithin(
      apiKey,
      callId,
      reach,
      Math.min(REQUEST_TIMEOUT_MILLISECONDS, remaining),
    );
    if (answer.kind === "refused" && answer.retryAfterMilliseconds !== undefined) {
      retryAfter = Date.now() + answer.retryAfterMilliseconds;
    }
    yield answer;
    if (
      answer.kind === "invalid-key" ||
      (answer.kind === "call" && retellCallHasFinalTranscript(answer.call))
    ) return;
  }
}
