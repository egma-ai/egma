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
  /**
   * How the exchange ended, read after it has.
   *
   * **A getter rather than a value, and the difference is a real bug that was
   * here.** The provider's status is known when its headers arrive, which on a
   * streamed answer is at the very beginning; a stream that was then cancelled
   * by the caller or cut off by a bound was recorded as `ok`, because the
   * status it was frozen at was `200`. What ended the exchange is not knowable
   * until the exchange has ended, so this is read at the same moment the record
   * is written.
   */
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

  /**
   * The caller who was already gone before this relay was reached.
   *
   * **A listener added to a signal that has already aborted never fires**, so
   * subscribing without checking first loses the abort entirely: the controller
   * below stays live, the fetch opens a real connection, and a request nobody
   * is waiting for becomes billable provider work holding a connection until
   * the whole-exchange bound notices — ten minutes later.
   *
   * **The window this covers is authentication, and it grew.** A connection is
   * authenticated before it reaches here, and for an inference key that means
   * one request to Egma Cloud every time one opens — hundreds of milliseconds
   * in which a simulator that gave up has already aborted. `relay-socket.ts`
   * takes the same precaution for the same reason.
   *
   * This transport can go further than that one does, and does: a socket has an
   * upstream handshake to race, so there the provider is spoken to and then
   * closed. Here there is nothing to race, so the provider is never spoken to
   * at all — no request leaves, and the record says `cancelled` because that is
   * what happened.
   */
  if (request.signal.aborted) return refused(startedAt, "cancelled", undefined);

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
  let crossedWhole = false;
  let endedBadly: StatusClass | undefined;

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
  });

  // A caller who went away mid-stream ends the exchange here: the abort stops
  // the provider's work, and the record is written with what had crossed rather
  // than waiting for a stream nobody is reading any more. Which of the two it
  // was is decided here, where it is still knowable — the caller's own signal
  // means they left, and this gateway's own timer means a bound was reached.
  abort.signal.addEventListener(
    "abort",
    () => {
      if (!crossedWhole) {
        endedBadly = request.signal.aborted ? "cancelled" : "timed-out";
      }
      stopTimers();
      settle();
    },
    { once: true },
  );

  /**
   * The pipe is driven here rather than by `pipeThrough`, and the reason is one
   * failure that has no status line to report it with.
   *
   * A provider that answers `200`, sends half its answer and then dies leaves a
   * relay with nothing to notice: there is no status to classify, and a
   * transformer's `flush` runs on a clean end and never on a broken one.
   * `pipeThrough` hands back a readable and swallows the outcome, so the
   * exchange settled only when this gateway's own exchange bound fired — ten
   * minutes later, on a record that said `timed-out` about a provider that had
   * broken in the first second, with the work held open the whole time.
   *
   * Driving the pipe means both endings are seen. A clean one settles the
   * record as it always did; a broken one settles it at once, as a provider
   * failure, and the error reaches the caller's own stream rather than being
   * turned into a tidy end that would present half an answer as a whole one.
   */
  let body: ReadableStream<Uint8Array> | null = null;
  if (upstream.body === null) {
    crossedWhole = true;
    stopTimers();
    settle();
  } else {
    body = counter.readable;
    void upstream.body.pipeTo(counter.writable, { signal: abort.signal }).then(
      () => {
        crossedWhole = true;
        stopTimers();
        settle();
      },
      () => {
        if (!crossedWhole && endedBadly === undefined) {
          endedBadly = request.signal.aborted
            ? "cancelled"
            : abort.signal.aborted
              ? "timed-out"
              : "provider-failed";
        }
        stopTimers();
        settle();
      },
    );
  }

  const providersOwn = upstreamRequestId(upstream.headers);

  return {
    response: new Response(body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: downstreamHeaders(upstream.headers),
    }),
    get statusClass() {
      return endedBadly ?? classOf(upstream.status);
    },
    ...(providersOwn === undefined ? {} : { upstreamRequestId: providersOwn }),
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
  const said: Partial<Record<StatusClass, { status: number; code: string; message: string }>> = {
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
  };
  // Only three things reach here — a caller who left, a bound that was reached,
  // and a provider that could not be spoken to at all — so the third is the
  // fallback rather than four more rows saying the same sentence.
  const chosen = said[statusClass] ?? {
    status: 502,
    code: "provider_unreachable",
    message: "the provider could not be reached",
  };
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
