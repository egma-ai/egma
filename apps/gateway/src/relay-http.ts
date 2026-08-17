import type { Config } from "./config.ts";
import type { StatusClass } from "./record.ts";
import type { Route } from "./routes.ts";
import { downstreamHeaders, upstreamAddress, upstreamHeaders, upstreamRequestId } from "./wire.ts";

/**
 * The streaming HTTP relay: one request out, one response back, nothing kept.
 *
 * **Nothing here waits for a whole anything.** The caller's body is handed to
 * the provider as a stream, so the provider sees the first bytes of a long
 * prompt while the caller is still writing it; the provider's body is handed
 * back as a stream, so the caller sees the first token of an answer long before
 * the answer is finished. A relay that read either one into memory would add
 * the whole of that side's duration to the exchange, and on a voice path that
 * is the difference between a persona that answers and a persona that pauses.
 *
 * **And exactly one attempt is made, ever.** There is no retry here — not on a
 * refusal, not on a failure, not on a timeout. A model request that was retried
 * after output started would be a second charge and a second, different answer;
 * a model request retried before output started would still be egma deciding to
 * ask a provider twice for something the caller asked once. Both are the same
 * silent-fallback problem, and the product's answer to it is that the caller
 * sees what really happened.
 */

export type HttpOutcome = {
  readonly response: Response;
  readonly statusClass: StatusClass;
  readonly upstreamRequestId?: string;
  readonly openMs: number;
  readonly firstOutputMs: number | undefined;
  readonly bytesFromProvider: () => number;
  /** Resolves when the last byte has crossed, however the exchange ended. */
  readonly finished: Promise<void>;
};

/** Which class a provider's own status belongs to. Never its body, never its text. */
function classOf(status: number): StatusClass {
  if (status >= 500) return "provider-failed";
  if (status >= 400) return "provider-refused";
  return "ok";
}

export async function relayHttp(
  request: Request,
  route: Route,
  config: Config,
): Promise<HttpOutcome> {
  const startedAt = Date.now();
  const url = new URL(request.url);

  /**
   * Two clocks and one signal, and the caller's own signal folded into them.
   *
   * The first-output bound is what catches a provider that accepted a request
   * and then said nothing; the whole-exchange bound is what catches one that
   * says a little forever. The caller's signal is in the same abort, so a
   * simulator that gave up stops the provider's work rather than leaving it
   * running and paid for.
   */
  const abort = new AbortController();
  const cancel = (): void => abort.abort();
  request.signal.addEventListener("abort", cancel, { once: true });
  const exchangeTimer = setTimeout(cancel, config.exchangeTimeoutMs);
  let firstOutputTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(
    cancel,
    config.firstOutputTimeoutMs,
  );

  const stopTimers = (): void => {
    clearTimeout(exchangeTimer);
    if (firstOutputTimer !== undefined) clearTimeout(firstOutputTimer);
    firstOutputTimer = undefined;
    request.signal.removeEventListener("abort", cancel);
  };

  let upstream: Response;
  try {
    upstream = await fetch(
      upstreamAddress(url, route, config).toString(),
      {
        method: request.method,
        headers: upstreamHeaders(request.headers, route, config),
        body: request.body,
        signal: abort.signal,
        // Node requires this to send a body it has not already read; Workers
        // does not mind being told. Without it a streamed prompt is refused
        // before it leaves the gateway.
        duplex: "half",
        redirect: "manual",
      } as RequestInit,
    );
  } catch (error) {
    stopTimers();
    const cancelled = request.signal.aborted;
    return refused(
      startedAt,
      cancelled ? "cancelled" : abort.signal.aborted ? "timed-out" : "unreachable",
      error,
    );
  }

  const openMs = Date.now() - startedAt;
  let firstOutputMs: number | undefined;
  let bytes = 0;

  /**
   * A pass-through that counts and times, and holds nothing.
   *
   * `TransformStream` is the web platform's own back-pressured pipe: the
   * provider is read only as fast as the caller is written, so a slow caller
   * slows the provider down instead of filling this gateway with the
   * difference. That is the whole of the buffering story on this transport,
   * and it is why there is no buffer size to configure here.
   */
  let settle: () => void = () => {};
  const finished = new Promise<void>((resolve) => {
    settle = resolve;
  });

  const counter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      if (firstOutputMs === undefined) {
        firstOutputMs = Date.now() - startedAt;
        if (firstOutputTimer !== undefined) {
          clearTimeout(firstOutputTimer);
          firstOutputTimer = undefined;
        }
      }
      bytes += chunk.byteLength;
      controller.enqueue(chunk);
    },
    flush() {
      stopTimers();
      settle();
    },
  });

  // A caller who went away mid-stream ends the exchange here: the abort stops
  // the provider's work, and the record is written with what had crossed rather
  // than waiting for a stream nobody is reading any more.
  abort.signal.addEventListener(
    "abort",
    () => {
      stopTimers();
      settle();
    },
    { once: true },
  );

  const body = upstream.body === null ? null : upstream.body.pipeThrough(counter);
  if (upstream.body === null) {
    stopTimers();
    settle();
  }

  return {
    response: new Response(body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: downstreamHeaders(upstream.headers),
    }),
    statusClass: classOf(upstream.status),
    ...(upstreamRequestId(upstream.headers) === undefined
      ? {}
      : { upstreamRequestId: upstreamRequestId(upstream.headers) as string }),
    openMs,
    get firstOutputMs() {
      return firstOutputMs;
    },
    bytesFromProvider: () => bytes,
    finished,
  };
}

/**
 * What the caller is told when the provider could not be reached, gave up, or
 * was given up on.
 *
 * The provider's own error is not in it. A relay that echoed a transport
 * exception would be putting an address, a certificate chain or a resolver's
 * opinion in front of a customer, and none of those is theirs to see.
 */
function refused(startedAt: number, statusClass: StatusClass, _error: unknown): HttpOutcome {
  const said: Record<StatusClass, { status: number; code: string; message: string }> = {
    cancelled: {
      status: 499,
      code: "caller_went_away",
      message: "the caller closed the request before the provider answered",
    },
    "timed-out": {
      status: 504,
      code: "provider_timed_out",
      message: "the provider did not answer within the gateway's bound",
    },
    unreachable: {
      status: 502,
      code: "provider_unreachable",
      message: "the provider could not be reached",
    },
    ok: { status: 502, code: "provider_unreachable", message: "the provider could not be reached" },
    "provider-refused": {
      status: 502,
      code: "provider_unreachable",
      message: "the provider could not be reached",
    },
    "provider-failed": {
      status: 502,
      code: "provider_unreachable",
      message: "the provider could not be reached",
    },
    refused: {
      status: 502,
      code: "provider_unreachable",
      message: "the provider could not be reached",
    },
  };
  const chosen = said[statusClass];
  return {
    response: new Response(
      JSON.stringify({ error: { code: chosen.code, message: chosen.message } }),
      {
        status: chosen.status,
        headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
      },
    ),
    statusClass,
    openMs: Date.now() - startedAt,
    firstOutputMs: undefined,
    bytesFromProvider: () => 0,
    finished: Promise.resolve(),
  };
}
