import type { Config } from "./config.ts";
import type { Route } from "./routes.ts";

/**
 * What crosses the gateway unchanged, what is taken out, and what is put in.
 *
 * The promise this file keeps is the one the whole relay rests on: **the
 * provider receives its own native request, byte for byte, except for
 * authorization and except for the names that belong to egma.** Everything a
 * provider adapter sends — its path, its query, its content type, its
 * provider-specific headers, its subprotocols, its body — arrives at the
 * provider as the adapter wrote it, which is what keeps Pipecat the simulator's
 * provider-adapter layer and keeps this gateway out of the protocol business.
 */

/** The header the gateway's own authentication travels in. */
export const AUTHENTICATION_HEADER = "egma-inference-key";

/**
 * The query parameter the gateway's own authentication may travel in instead.
 *
 * **A socket client is not always able to set a header.** Cartesia's shipped
 * service builds its whole address as a string and offers no header hook, and a
 * browser's `WebSocket` cannot set one at all — so a gateway that accepted only
 * a header would be a gateway those callers cannot reach, and the workaround
 * would be a second adapter. One alternative carrier, named once, is cheaper
 * than that and is still a slot the gateway owns.
 */
export const AUTHENTICATION_PARAMETER = "egma_inference_key";

/**
 * The namespace the gateway keeps for itself, and the reason it is a namespace
 * rather than a list.
 *
 * The organization a connection acts in is derived from the credential and from
 * nothing else. Enforcing that by listing the names a caller must not use is a
 * list that has to grow every time somebody thinks of a new one — so instead
 * every `egma-` header and every `egma_` query parameter is refused, apart from
 * the one that carries authentication. Nothing a caller can spell in egma's own
 * namespace reaches the provider or this gateway's own reading of a request,
 * and a caller who tries is told so rather than quietly ignored.
 */
const EGMA_HEADER_PREFIX = "egma-";
const EGMA_PARAMETER_PREFIX = "egma_";

/**
 * Headers that never cross, whichever route carries them.
 *
 * Three groups, three reasons. The hop-by-hop names describe *this* connection
 * and are meaningless on the next one. The authorization names are the
 * caller-supplied provider authorization the gateway exists to remove — they go
 * whether or not the caller also used the gateway's own header, so a request
 * carrying a real provider key cannot smuggle it through beside a valid
 * inference credential. `cookie` is neither, and it goes for the same reason as
 * the second group: it is an identity-bearing input, no shipped provider route
 * reads one, and a credential parked in a cookie must not become the exception.
 */
const NEVER_FORWARDED = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
  "authorization",
  "api-key",
  "x-api-key",
  "x-goog-api-key",
  "cookie",
]);

/**
 * Response headers that do not come back.
 *
 * The hop-by-hop names again, plus `set-cookie`: a model provider has no
 * business putting state in the caller's jar, and the one that tried would be
 * writing it into egma's simulator rather than into a browser.
 */
const NEVER_RETURNED = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "transfer-encoding",
  "upgrade",
  "set-cookie",
  "content-encoding",
  "content-length",
]);

/**
 * Response headers the operational record may carry, and the whole of the list.
 *
 * The upstream request identifier is the one thing a provider's answer holds
 * that is worth writing down: it is what a support conversation with the
 * provider is conducted in. Every provider spells it differently and none of
 * them is content.
 */
const UPSTREAM_REQUEST_HEADERS = ["dg-request-id", "x-request-id", "request-id", "cf-ray"];

export type IdentityIntrusion = { readonly at: "header" | "query"; readonly name: string };

/**
 * The name a caller used from egma's namespace that is not the authentication
 * one, or `null`.
 *
 * Refused rather than stripped. Stripping would let a caller believe an
 * organization was named and honoured; the refusal says plainly that this
 * gateway takes its organization from one place.
 */
export function identityIntrusion(url: URL, headers: Headers): IdentityIntrusion | null {
  for (const [name] of headers) {
    const lower = name.toLowerCase();
    if (lower.startsWith(EGMA_HEADER_PREFIX) && lower !== AUTHENTICATION_HEADER) {
      return { at: "header", name: lower };
    }
  }
  for (const [name] of url.searchParams) {
    const lower = name.toLowerCase();
    if (lower.startsWith(EGMA_PARAMETER_PREFIX) && lower !== AUTHENTICATION_PARAMETER) {
      return { at: "query", name: lower };
    }
  }
  return null;
}

/**
 * The credential the caller offered, from the one slot the gateway owns or,
 * failing that, from the provider's own authorization slot.
 *
 * The fallback is what makes a shipped provider adapter able to reach this
 * gateway with no change at all: the adapter is handed the Egma credential
 * where it expects a provider key, sends it where it always sends one, and the
 * gateway takes it out of that slot and never forwards it. Either way the
 * caller's value stops here.
 */
export function offeredCredential(url: URL, headers: Headers, route: Route): string | null {
  const own =
    headers.get(AUTHENTICATION_HEADER) ?? url.searchParams.get(AUTHENTICATION_PARAMETER);
  if (own !== null && own.trim() !== "") return own.trim();

  if (route.credential.at === "query") {
    const value = url.searchParams.get(route.credential.name);
    return value === null || value.trim() === "" ? null : value.trim();
  }

  const header = headers.get(route.credential.name);
  if (header === null || header.trim() === "") return null;
  // `Token abc` and `Bearer abc` and a bare `abc` all mean the same thing here:
  // whatever the adapter wrapped the value in, the value is what is offered.
  const written = header.trim();
  const space = written.indexOf(" ");
  if (space === -1) return written;
  return written.slice(space + 1).trim();
}

/**
 * The address the provider is really asked, built from the route and from the
 * caller's query — never from anything else the caller sent.
 *
 * The query crosses whole, minus egma's namespace and minus the provider's own
 * authorization parameter, which the gateway supplies itself.
 */
export function upstreamAddress(url: URL, route: Route, config: Config): URL {
  const upstream = new URL(config.providerHome[route.provider] + route.upstreamPath);
  for (const [name, value] of url.searchParams) {
    const lower = name.toLowerCase();
    if (lower.startsWith(EGMA_PARAMETER_PREFIX)) continue;
    if (route.credential.at === "query" && lower === route.credential.name) continue;
    upstream.searchParams.append(name, value);
  }
  if (route.credential.at === "query") {
    upstream.searchParams.set(route.credential.name, config.providerCredentials[route.provider]);
  }
  return upstream;
}

/**
 * The headers the provider receives: the caller's, minus what never crosses,
 * minus egma's namespace, plus Egma's own provider authorization.
 */
export function upstreamHeaders(headers: Headers, route: Route, config: Config): Headers {
  const forwarded = new Headers();
  for (const [name, value] of headers) {
    const lower = name.toLowerCase();
    if (NEVER_FORWARDED.has(lower)) continue;
    if (lower.startsWith(EGMA_HEADER_PREFIX)) continue;
    // A socket handshake's own machinery is rebuilt by whatever opens the
    // upstream socket, so passing this connection's copy on would describe the
    // wrong connection. The subprotocol is the exception and is carried
    // deliberately by the socket relay, because it is the caller's choice
    // rather than the transport's bookkeeping.
    if (lower.startsWith("sec-websocket-") && lower !== "sec-websocket-protocol") continue;
    forwarded.append(name, value);
  }
  if (route.credential.at === "header") {
    forwarded.set(
      route.credential.name,
      `${route.credential.scheme} ${config.providerCredentials[route.provider]}`,
    );
  }
  return forwarded;
}

/** The headers the caller receives: the provider's, minus what never returns. */
export function downstreamHeaders(headers: Headers): Headers {
  const returned = new Headers();
  for (const [name, value] of headers) {
    if (NEVER_RETURNED.has(name.toLowerCase())) continue;
    returned.append(name, value);
  }
  return returned;
}

/** The provider's own identifier for this exchange, if it named one. */
export function upstreamRequestId(headers: Headers): string | undefined {
  for (const name of UPSTREAM_REQUEST_HEADERS) {
    const value = headers.get(name);
    if (value !== null && value !== "") return value;
  }
  return undefined;
}

/** The provider model this route named in its address, where it names one there. */
export function providerModel(url: URL, route: Route): string | undefined {
  if (route.modelParameter === undefined) return undefined;
  return url.searchParams.get(route.modelParameter) ?? undefined;
}
