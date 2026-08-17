import { ConfigurationFault, type Environment, loadConfig } from "./config.ts";
import { handle } from "./gateway.ts";
import { makeLog, refusalResponse } from "./record.ts";
import {
  type Duplex,
  type Frame,
  type SocketHost,
  UpstreamHandshakeRefused,
} from "./socket.ts";
import { deployedVerifier } from "./verify.ts";

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
/** What the runtime says about the build that is answering. Read-only. */
type VersionMetadata = { id?: string; tag?: string };

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
    bufferedBytes: () => socket.bufferedAmount,
    /**
     * No `pauseReading` here, deliberately.
     *
     * This runtime delivers frames as events and offers no way to stop taking
     * them, so there is no read flow control to expose. The aggregate bound
     * therefore has one outcome on this host rather than two: an exchange whose
     * far side does not start keeping up within the drain window is closed
     * loudly. That is the honest behaviour available here, and it is why the
     * relay treats both methods as optional rather than assuming them.
     */
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
  async fetch(
    request: Request,
    env: Environment & { EGMA_GATEWAY_VERSION?: VersionMetadata },
    ctx: ExecutionContext,
  ): Promise<Response> {
    /**
     * A misconfigured build answers, rather than throwing.
     *
     * On this runtime an exception out of the entry point is the platform's own
     * generic error page and a status nobody can act on — and the way a build
     * gets here misconfigured is banal: a version uploaded by a step that only
     * meant to set one secret carries only the bindings that step knew about,
     * and every request to it fails opaquely. Found exactly that way, on a
     * canary. So the fault is caught where the configuration is read and comes
     * back as this gateway's own refusal, with the missing name in it.
     */
    let config;
    try {
      config = loadConfig(env);
    } catch (fault) {
      if (!(fault instanceof ConfigurationFault)) throw fault;
      return refusalResponse({
        status: 503,
        code: "gateway_misconfigured",
        message: fault.message,
      });
    }
    const build = env.EGMA_GATEWAY_VERSION;
    return handle(request, {
      config,
      verifier: deployedVerifier(config),
      log: makeLog(config.logLevel),
      socketHostFor: () => socketHostFor(),
      waitUntil: (work) => ctx.waitUntil(work),
      ...(build?.id === undefined ? {} : { version: build.tag ?? build.id }),
    });
  },
};
