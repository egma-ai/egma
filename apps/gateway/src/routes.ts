import type { ModelJob, Provider } from "./config.ts";

/**
 * The fixed routes, and the whole of what this gateway will carry.
 *
 * **A route is a literal path, one method, one transport, and one upstream
 * path — all four written down here and none of them assembled from anything a
 * caller sent.** That is the difference between a relay and a proxy: a proxy
 * takes a target and goes there, and this cannot be asked to go anywhere. A
 * request that does not match a row exactly is refused before authentication is
 * even read, so an arbitrary host, an arbitrary path, an unexpected method and
 * an upgrade on a route that does not take one are all one refusal with one
 * shape.
 *
 * The public path is the provider's own path under the provider's own name.
 * That is not decoration: it is what lets a shipped provider adapter reach this
 * gateway by being told a different base address and nothing else. Pipecat's
 * Deepgram service appends `/v1/listen` to whatever base it is given, so the
 * base is `…/deepgram`; the OpenAI chat client appends `/chat/completions` to
 * its base, so the base is `…/openai/v1`; Cartesia's service is told a whole
 * socket address, so that is the row's own path. Nothing here translates a
 * protocol, and nothing here has to.
 */

export type Transport = "http" | "socket";

export type Route = {
  /** The exact path this gateway answers on. Never a pattern, never a prefix. */
  readonly path: string;
  /** The one method allowed. A socket route is opened with `GET`, as the protocol says. */
  readonly method: "GET" | "POST";
  readonly transport: Transport;
  readonly provider: Provider;
  readonly job: ModelJob;
  /** The provider's own path, appended to the provider's configured home. */
  readonly upstreamPath: string;
  /**
   * Where this provider expects its own authorization, so the gateway knows
   * what to take out and where to put Egma's back.
   *
   * Deepgram and OpenAI read an `Authorization` header; Cartesia reads an
   * `api_key` query parameter, because its socket is opened by a browser-shaped
   * client that cannot set one. The scheme word is the provider's own —
   * `Token` for Deepgram, `Bearer` for OpenAI — and getting it wrong is a
   * refusal at the handshake rather than something subtle.
   */
  readonly credential:
    | { readonly at: "header"; readonly name: string; readonly scheme: string }
    | { readonly at: "query"; readonly name: string };
  /**
   * The query parameter that names the provider model, where the provider puts
   * it in the address.
   *
   * **Recorded only from here, and never from a body.** The operational record
   * may hold the provider model ID, and Deepgram's arrives in the query string
   * where reading it costs nothing. OpenAI's and Cartesia's arrive inside the
   * payload, and the gateway does not read payloads — so those records carry no
   * model, which is the honest answer rather than a parsed one.
   */
  readonly modelParameter?: string;
};

export const ROUTES: readonly Route[] = [
  {
    path: "/deepgram/v1/listen",
    method: "GET",
    transport: "socket",
    provider: "deepgram",
    job: "stt",
    upstreamPath: "/v1/listen",
    credential: { at: "header", name: "authorization", scheme: "Token" },
    modelParameter: "model",
  },
  {
    path: "/openai/v1/chat/completions",
    method: "POST",
    transport: "http",
    provider: "openai",
    job: "llm",
    upstreamPath: "/v1/chat/completions",
    credential: { at: "header", name: "authorization", scheme: "Bearer" },
  },
  {
    path: "/cartesia/tts/websocket",
    method: "GET",
    transport: "socket",
    provider: "cartesia",
    job: "tts",
    upstreamPath: "/tts/websocket",
    credential: { at: "query", name: "api_key" },
  },
];

/** The one path that answers without authentication and without an upstream. */
export const HEALTH_PATH = "/health";

export type RouteMatch =
  | { readonly kind: "route"; readonly route: Route }
  | { readonly kind: "health" }
  | { readonly kind: "no-such-route" }
  /** The path is a route; the method or the transport is not the one it carries. */
  | { readonly kind: "wrong-method"; readonly allowed: string }
  | { readonly kind: "wrong-transport"; readonly route: Route };

/**
 * Which row a request is, read from its path, its method, and whether it asks
 * to upgrade — and nothing else.
 *
 * The three answers are kept apart on purpose. An unknown path is a caller
 * asking for something this gateway does not ship; a known path with the wrong
 * method or the wrong transport is a caller who found the right row and used it
 * wrongly. They deserve different status codes and a reader of the log deserves
 * to be able to tell them apart.
 */
export function matchRoute(
  pathname: string,
  method: string,
  upgrading: boolean,
): RouteMatch {
  if (pathname === HEALTH_PATH) return { kind: "health" };

  const byPath = ROUTES.filter((route) => route.path === pathname);
  if (byPath.length === 0) return { kind: "no-such-route" };

  const byMethod = byPath.find((route) => route.method === method.toUpperCase());
  if (byMethod === undefined) {
    return { kind: "wrong-method", allowed: byPath.map((route) => route.method).join(", ") };
  }

  const wantsSocket = byMethod.transport === "socket";
  if (wantsSocket !== upgrading) return { kind: "wrong-transport", route: byMethod };

  return { kind: "route", route: byMethod };
}
