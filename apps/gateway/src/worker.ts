import { type Environment, loadConfig } from "./config.ts";
import { handle } from "./gateway.ts";
import { makeLog } from "./record.ts";
import {
  type Duplex,
  type Frame,
  type SocketHost,
  UpstreamHandshakeRefused,
} from "./socket.ts";
import { staticSecretVerifier } from "./verify.ts";

/**
 * The deployed host: the Egma model gateway as a Cloudflare Worker.
 *
 * Everything this file does is adapt. The routing, the authentication, the
 * stripping and injecting, the streaming and the records are all in the modules
 * beside it, written against the web platform, and this is the twenty lines
 * that turn Cloudflare's socket vocabulary into the seam the relay speaks. That
 * split is what lets the same application be exercised on a developer's machine
 * and in the deterministic suite without a second implementation of anything
 * that matters.
 *
 * Cloudflare is where Egma hosts this. It is infrastructure, and the product is
 * the Egma model gateway.
 */

/**
 * The two pieces of Cloudflare's runtime this file needs, declared rather than
 * depended on.
 *
 * A types package for the whole Workers runtime would be a build dependency for
 * a surface of exactly two names, and it would put a second, larger definition
 * of `Request` and `Response` in front of the ones the relay is written
 * against. These are what the runtime really offers, and no more.
 */
declare class WebSocketPair {
  0: WebSocket;
  1: WebSocket;
}
type CloudflareWebSocket = WebSocket & { accept(): void };
type CloudflareResponseInit = ResponseInit & { webSocket?: WebSocket };
type ExecutionContext = { waitUntil(work: Promise<unknown>): void };

/** Cloudflare's socket, as the relay wants to see it. */
function asDuplex(socket: CloudflareWebSocket): Duplex {
  return {
    send: (frame: Frame) => socket.send(frame as string | ArrayBufferLike),
    close: (code?: number, reason?: string) => socket.close(code, reason),
    onMessage: (handler) =>
      socket.addEventListener("message", (event) => handler(event.data as Frame)),
    onClose: (handler) =>
      socket.addEventListener("close", (event) => handler(event.code, event.reason)),
    onError: (handler) => socket.addEventListener("error", (event) => handler(event)),
  };
}

function socketHostFor(): SocketHost {
  let client: WebSocket | undefined;
  let server: CloudflareWebSocket | undefined;

  return {
    async connectUpstream(url, headers, protocols) {
      const asked = new Headers(headers);
      asked.set("Upgrade", "websocket");
      if (protocols.length > 0) asked.set("Sec-WebSocket-Protocol", protocols.join(", "));

      const answered = await fetch(url.toString(), { headers: asked });
      const socket = (answered as Response & { webSocket?: CloudflareWebSocket }).webSocket;
      if (answered.status !== 101 || socket === undefined || socket === null) {
        throw new UpstreamHandshakeRefused(
          answered.status,
          "the provider did not complete the handshake",
        );
      }
      socket.accept();
      return {
        socket: asDuplex(socket),
        protocol: answered.headers.get("sec-websocket-protocol"),
        headers: answered.headers,
      };
    },

    acceptClient(protocol) {
      const pair = new WebSocketPair();
      client = pair[0];
      server = pair[1] as CloudflareWebSocket;
      server.accept();
      const headers = new Headers();
      if (protocol !== null && protocol !== "") headers.set("Sec-WebSocket-Protocol", protocol);
      return {
        socket: asDuplex(server),
        response: new Response(null, {
          status: 101,
          webSocket: client,
          headers,
        } as CloudflareResponseInit),
      };
    },
  };
}

export default {
  async fetch(request: Request, env: Environment, ctx: ExecutionContext): Promise<Response> {
    const config = loadConfig(env);
    return handle(request, {
      config,
      verifier: staticSecretVerifier(config),
      log: makeLog(config.logLevel),
      socketHostFor: () => socketHostFor(),
      waitUntil: (work) => ctx.waitUntil(work),
    });
  },
};
