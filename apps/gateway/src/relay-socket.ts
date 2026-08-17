import type { Config } from "./config.ts";
import type { StatusClass } from "./record.ts";
import type { Route } from "./routes.ts";
import {
  type Duplex,
  type Frame,
  forwardableCloseCode,
  frameBytes,
  type SocketHost,
  UpstreamHandshakeRefused,
  type UpstreamSocket,
} from "./socket.ts";
import { upstreamAddress, upstreamHeaders, upstreamRequestId } from "./wire.ts";

/**
 * The WebSocket relay: two sockets, frames in the order they arrived, and the
 * close code that really happened.
 *
 * **The provider's socket is opened before the caller's is accepted, and the
 * order is the design.** A relay that accepted the caller first would be
 * telling a speech adapter that the path is open while the far half of it is
 * not — and a streaming adapter starts sending audio the moment its handshake
 * completes, so the first turn of a simulation would go into a queue this
 * gateway would then have to hold, bound, and eventually drop. Opening the
 * provider first makes the caller's `101` mean what it says: everything between
 * the persona and the provider is up. It also lets the subprotocol the provider
 * selected be the subprotocol the caller is told about, rather than a guess made
 * before anybody had chosen.
 *
 * **What the provider is offered comes from the route, never from the caller.**
 * A subprotocol list is one of the places a provider takes a key — Deepgram
 * documents `token, <key>` for clients that cannot set a header — so forwarding
 * the caller's would be forwarding a credential. See `Route.upstreamProtocols`.
 *
 * The cost is that the caller waits for the provider's handshake, which is the
 * truth about how long the path took to open and is exactly what the latency
 * comparison measures.
 */

export type SocketOutcome = {
  readonly statusClass: StatusClass;
  readonly upstreamRequestId?: string;
  readonly openMs: number;
  readonly firstOutputMs?: number;
  readonly bytesToProvider: number;
  readonly bytesFromProvider: number;
};

export type SocketRelay = {
  readonly response: Response;
  /** Resolves when both ends are closed, however that happened. */
  readonly finished: Promise<SocketOutcome>;
};

/** The provider refused the handshake, so the caller's is refused too. */
export class SocketRefused extends Error {
  readonly statusClass: StatusClass;
  readonly status: number;
  readonly code: string;

  constructor(statusClass: StatusClass, status: number, code: string, message: string) {
    super(message);
    this.statusClass = statusClass;
    this.status = status;
    this.code = code;
  }
}

/** Codes this gateway sends when the reason is its own rather than a peer's. */
const CLOSE_GOING_AWAY = 1001;
const CLOSE_INTERNAL = 1011;
const CLOSE_TOO_BIG = 1009;
/** "Try again later" — the honest code for a peer that could not keep up. */
const CLOSE_OVERLOADED = 1013;

/** How often a held direction asks whether the far side has caught up. */
const DRAIN_POLL_MS = 20;

export async function relaySocket(
  host: SocketHost,
  request: Request,
  route: Route,
  config: Config,
): Promise<SocketRelay> {
  const startedAt = Date.now();
  const url = new URL(request.url);

  /**
   * The caller going away, from the moment the request arrived.
   *
   * **The window this covers is the upstream handshake**, which is the one
   * stretch of a relayed socket where nothing else is watching: the caller's own
   * socket does not exist yet, so a caller who gave up during it would leave the
   * provider's socket open and paid for until the idle bound noticed, two
   * minutes later. Everything after this window is covered by the close
   * handlers, which is why this listener is removed as soon as it closes.
   */
  const abandoned = new AbortController();
  const giveUp = (): void => abandoned.abort();
  if (request.signal.aborted) giveUp();
  request.signal.addEventListener("abort", giveUp, { once: true });
  const stopWatchingForAbandonment = (): void =>
    request.signal.removeEventListener("abort", giveUp);

  const connecting = host.connectUpstream(
    upstreamAddress(url, route, config),
    upstreamHeaders(request.headers, route, config),
    route.upstreamProtocols ?? [],
  );

  /**
   * A handshake nobody is waiting for any more.
   *
   * Giving up on the wait does not cancel the work: the provider may still
   * complete the handshake a moment later, and an open socket with nothing on
   * the other end of it is a provider resource this gateway is holding for no
   * reason. So whichever way the wait ended, the late arrival is closed.
   */
  let stillWanted = true;
  void connecting.then(
    (late) => {
      if (!stillWanted) late.socket.close(CLOSE_GOING_AWAY, "nobody is waiting for this");
    },
    () => undefined,
  );

  let upstream: UpstreamSocket;
  try {
    upstream = await withinMs(connecting, config.firstOutputTimeoutMs, abandoned.signal);
  } catch (error) {
    stillWanted = false;
    stopWatchingForAbandonment();
    if (error instanceof Abandoned) {
      throw new SocketRefused(
        "cancelled",
        499,
        "caller_went_away",
        "the caller closed the connection before the provider answered",
      );
    }
    if (error instanceof Timeout) {
      throw new SocketRefused(
        "timed-out",
        504,
        "provider_timed_out",
        "the provider did not complete the handshake within the gateway's bound",
      );
    }
    if (error instanceof UpstreamHandshakeRefused) {
      // The provider's own status is worth keeping — it is how a caller tells
      // an invalid credential from an invalid model — and its body is not,
      // because a handshake body is where a provider echoes what it was sent.
      const status = error.status ?? 502;
      throw new SocketRefused(
        status >= 500 || error.status === null ? "provider-failed" : "provider-refused",
        status === 101 ? 502 : status,
        "provider_refused_the_socket",
        "the provider refused the connection",
      );
    }
    throw new SocketRefused(
      "unreachable",
      502,
      "provider_unreachable",
      "the provider could not be reached",
    );
  }

  const openMs = Date.now() - startedAt;
  const providersOwn = upstreamRequestId(upstream.headers);

  /**
   * The caller gave up while the provider was still shaking hands.
   *
   * The provider's socket exists and nobody is on the other end of it, so it is
   * closed here rather than left for the idle bound. `1001` is the honest code:
   * the endpoint that wanted this is going away.
   */
  if (abandoned.signal.aborted) {
    stopWatchingForAbandonment();
    upstream.socket.close(CLOSE_GOING_AWAY, "the caller went away");
    throw new SocketRefused(
      "cancelled",
      499,
      "caller_went_away",
      "the caller closed the connection before the provider answered",
    );
  }
  stopWatchingForAbandonment();

  const accepted = host.acceptClient(upstream.protocol);

  let bytesToProvider = 0;
  let bytesFromProvider = 0;
  let firstOutputMs: number | undefined;
  let statusClass: StatusClass = "ok";
  let over = false;

  let settle: (outcome: SocketOutcome) => void = () => {};
  const finished = new Promise<SocketOutcome>((resolve) => {
    settle = resolve;
  });

  /**
   * Both clocks, restarted by traffic.
   *
   * The idle bound is what closes an exchange whose simulator disappeared
   * without closing — on a voice socket, silence in both directions is not a
   * quiet moment, it is an abandoned one. The exchange bound is the backstop
   * underneath it, for an exchange that keeps talking forever.
   */
  let idle: ReturnType<typeof setTimeout> | undefined;
  const restartIdle = (): void => {
    if (idle !== undefined) clearTimeout(idle);
    idle = setTimeout(() => end("timed-out", CLOSE_GOING_AWAY, "idle"), config.socketIdleTimeoutMs);
  };
  const whole = setTimeout(
    () => end("timed-out", CLOSE_GOING_AWAY, "exchange bound reached"),
    config.exchangeTimeoutMs,
  );

  function end(
    why: StatusClass,
    code: number | undefined,
    reason: string,
    closeClient = true,
    closeUpstream = true,
  ): void {
    if (over) return;
    over = true;
    statusClass = why;
    if (idle !== undefined) clearTimeout(idle);
    clearTimeout(whole);
    for (const stop of holdings) stop();
    /**
     * Reading starts again before anything is closed.
     *
     * A closing handshake is two frames, and a socket this relay has stopped
     * reading cannot receive the second one — so an exchange ended while one
     * side was held would send its close, never read the reply, and leave that
     * peer in `CLOSING` until something else gave up. Ending is exactly when
     * backpressure has stopped being useful.
     */
    accepted.socket.resumeReading?.();
    upstream.socket.resumeReading?.();
    try {
      if (closeUpstream) upstream.socket.close(code, reason);
    } catch {
      // A socket already gone is the state this wanted; nothing to report.
    }
    try {
      if (closeClient) accepted.socket.close(code, reason);
    } catch {
      // Same.
    }
    settle({
      statusClass,
      ...(providersOwn === undefined ? {} : { upstreamRequestId: providersOwn }),
      openMs,
      ...(firstOutputMs === undefined ? {} : { firstOutputMs }),
      bytesToProvider,
      bytesFromProvider,
    });
  }

  /**
   * One direction, wired.
   *
   * Frames go straight across in the order they arrived — no reordering, no
   * regrouping, no reading of what is in them. Two things are looked at and
   * neither is the content: how big one frame is, and how much the far side is
   * still holding.
   *
   * **The second is the aggregate bound, and it is the one that matters on a
   * voice path.** A per-frame bound stops one enormous frame; it does nothing
   * about a listening leg sending audio continuously into a provider that has
   * slowed down, which is the ordinary shape of trouble here. Every send on
   * both hosts is fire-and-forget into a buffer the host owns, so what happens
   * next is decided entirely by whether anybody is watching that buffer.
   *
   * When it crosses the bound the fast side stops being read, which is real
   * backpressure: the peer's own socket fills and the peer discovers it cannot
   * write. Crossing is not a failure — a provider that hesitated deserves to be
   * waited for — so the exchange carries on as soon as the buffer drains, and
   * no frame is ever dropped. Only a peer that never starts keeping up ends the
   * exchange, loudly, with the code that says exactly that.
   */
  const carry = (from: Duplex, to: Duplex, count: (bytes: number) => void): void => {
    let holding = false;
    let watching: ReturnType<typeof setTimeout> | undefined;

    /** Half the bound: far enough down that it is not crossed again at once. */
    const drainedTo = Math.max(1, Math.floor(config.maxBufferedBytes / 2));

    const watch = (until: number): void => {
      watching = undefined;
      if (over) return;
      if (to.bufferedBytes() <= drainedTo) {
        holding = false;
        from.resumeReading?.();
        return;
      }
      if (Date.now() >= until) {
        end("refused", CLOSE_OVERLOADED, "the far side is not keeping up");
        return;
      }
      watching = setTimeout(() => watch(until), DRAIN_POLL_MS);
    };

    from.onMessage((frame: Frame) => {
      if (over) return;
      const size = frameBytes(frame);
      if (size > config.maxFrameBytes) {
        end("refused", CLOSE_TOO_BIG, "frame over the gateway's bound");
        return;
      }
      count(size);
      restartIdle();
      try {
        to.send(frame);
      } catch {
        end("provider-failed", CLOSE_INTERNAL, "the far side would not take the frame");
        return;
      }
      if (!holding && to.bufferedBytes() > config.maxBufferedBytes) {
        holding = true;
        from.pauseReading?.();
        if (watching === undefined) {
          watching = setTimeout(() => watch(Date.now() + config.bufferDrainMs), DRAIN_POLL_MS);
        }
      }
    });
    from.onError(() => {
      end("provider-failed", CLOSE_INTERNAL, "the connection failed");
    });

    holdings.push(() => {
      if (watching !== undefined) clearTimeout(watching);
    });
  };

  /** What each direction has to stop doing when the exchange ends. */
  const holdings: (() => void)[] = [];

  carry(accepted.socket, upstream.socket, (size) => {
    bytesToProvider += size;
  });
  carry(upstream.socket, accepted.socket, (size) => {
    if (firstOutputMs === undefined) firstOutputMs = Date.now() - startedAt;
    bytesFromProvider += size;
  });

  /**
   * A close on either side is the other side's close, with the same code.
   *
   * This is what makes cancellation real in both directions: a simulator that
   * hung up stops the provider's work and stops paying for it, and a provider
   * that dropped the connection is a failure the simulator sees at once rather
   * than a silence it waits out.
   */
  accepted.socket.onClose((code, reason) => {
    end(code === 1000 || code === 1005 ? "ok" : "cancelled", forwardableCloseCode(code), reason, false);
  });
  upstream.socket.onClose((code, reason) => {
    end(
      code === 1000 || code === 1005 ? "ok" : "provider-failed",
      forwardableCloseCode(code),
      reason,
      true,
      false,
    );
  });

  restartIdle();

  return { response: accepted.response, finished };
}

class Timeout extends Error {}
class Abandoned extends Error {}

/**
 * The handshake, or the two ways of not waiting for it.
 *
 * The work is not cancelled by either — a host that has already opened a socket
 * still returns it, and the caller of this closes it. What this decides is only
 * whether anybody is still waiting.
 */
function withinMs<T>(work: Promise<T>, ms: number, abandoned?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Timeout()), ms);
    const gaveUp = (): void => reject(new Abandoned());
    abandoned?.addEventListener("abort", gaveUp, { once: true });
    const done = (): void => {
      clearTimeout(timer);
      abandoned?.removeEventListener("abort", gaveUp);
    };
    work.then(
      (value) => {
        done();
        resolve(value);
      },
      (error: unknown) => {
        done();
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
