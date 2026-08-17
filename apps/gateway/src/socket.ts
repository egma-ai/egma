/**
 * The one thing about a relayed socket that differs between hosts, and the
 * relay that does not.
 *
 * Cloudflare hands a Worker a `WebSocketPair` and returns the caller's end
 * inside a `101` response; Node hands a server a raw upgrade and a library
 * completes the handshake on it. Those are twenty lines each and they are the
 * whole difference — so they are behind this seam, and everything that decides
 * what a relayed socket *does* is in `relay-socket.ts`, written once.
 */

export type Frame = string | ArrayBuffer;

/** One end of a relayed socket, reduced to what a relay needs of it. */
export type Duplex = {
  send(frame: Frame): void;
  /** Codes travel as the protocol allows; a reason is never invented. */
  close(code?: number, reason?: string): void;
  onMessage(handler: (frame: Frame) => void): void;
  onClose(handler: (code: number, reason: string) => void): void;
  onError(handler: (error: unknown) => void): void;
};

export type UpstreamSocket = {
  readonly socket: Duplex;
  /** The subprotocol the provider selected, or null if it selected none. */
  readonly protocol: string | null;
  readonly headers: Headers;
};

/**
 * What a host can do that the relay cannot do for itself.
 *
 * One of these is made for one exchange, because `acceptClient` on Node needs
 * the raw upgrade that arrived with the request and there is nowhere else to
 * keep it.
 */
export type SocketHost = {
  /**
   * Open the provider's socket. Rejects if the provider refuses the handshake,
   * and the rejection carries the status where the provider gave one.
   */
  connectUpstream(
    url: URL,
    headers: Headers,
    protocols: readonly string[],
  ): Promise<UpstreamSocket>;

  /**
   * Complete the caller's handshake, selecting the subprotocol the provider
   * selected, and hand back this end of it together with the response the
   * handler returns.
   */
  acceptClient(protocol: string | null): { readonly socket: Duplex; readonly response: Response };
};

/** A provider that refused the handshake, with its status where it gave one. */
export class UpstreamHandshakeRefused extends Error {
  readonly status: number | null;

  constructor(status: number | null, message: string) {
    super(message);
    this.status = status;
  }
}

/** How many bytes one frame is, without copying it. */
export function frameBytes(frame: Frame): number {
  return typeof frame === "string" ? new TextEncoder().encode(frame).length : frame.byteLength;
}

/**
 * The close code to send onward when one side closed with this one.
 *
 * `1005` and `1006` are not codes anybody sends — they are what a library
 * reports when no code arrived and when the connection broke — so sending
 * either one on is a protocol error. They become the two things they really
 * mean: a close with no code, and a connection that failed.
 */
export function forwardableCloseCode(code: number): number | undefined {
  if (code === 1005) return undefined;
  if (code === 1006) return 1011;
  if (code < 1000 || code > 4999) return 1011;
  return code;
}
