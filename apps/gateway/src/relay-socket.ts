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
 * selected be the subprotocol the caller is told about, rather than a guess
 * made before anybody had chosen.
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

export async function relaySocket(
  host: SocketHost,
  request: Request,
  route: Route,
  config: Config,
): Promise<SocketRelay> {
  const startedAt = Date.now();
  const url = new URL(request.url);
  const offered = (request.headers.get("sec-websocket-protocol") ?? "")
    .split(",")
    .map((one) => one.trim())
    .filter((one) => one !== "");

  let upstream: UpstreamSocket;
  try {
    upstream = await withinMs(
      host.connectUpstream(
        upstreamAddress(url, route, config),
        upstreamHeaders(request.headers, route, config),
        offered,
      ),
      config.firstOutputTimeoutMs,
    );
  } catch (error) {
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
      ...(upstreamRequestId(upstream.headers) === undefined
        ? {}
        : { upstreamRequestId: upstreamRequestId(upstream.headers) as string }),
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
   * regrouping, no reading of what is in them. The only thing looked at is how
   * big one is, and the only reason for that is the bound.
   */
  const carry = (from: Duplex, to: Duplex, count: (bytes: number) => void): void => {
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
      }
    });
    from.onError(() => {
      end("provider-failed", CLOSE_INTERNAL, "the connection failed");
    });
  };

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

function withinMs<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Timeout()), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
