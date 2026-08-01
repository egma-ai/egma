import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";

/**
 * Mounting a `Request → Response` handler on Fastify.
 *
 * The auth provider ships its HTTP surface as one web-standard function and no
 * Fastify module, so egma writes and tests this. The snippet in the provider's
 * documentation is not usable as written and each of its faults is a real
 * failure rather than a style point, so each is answered here by name:
 *
 * **It routes GET and POST only.** The provider serves `DELETE /revoke-session`
 * today and its plugins add more; a `PUT` or a `DELETE` would 404 with nothing
 * to suggest why.
 *
 * **It re-serializes the body as JSON while forwarding the original content
 * type.** A form-encoded request — which is what RFC 8628's token endpoint
 * sends, so this is the CLI login path — arrives as `grant_type=…` and leaves
 * as `"grant_type=…"` still labelled `application/x-www-form-urlencoded`. The
 * provider then parses the JSON string as a form and finds nothing. The body
 * here is never parsed and never re-encoded: it is read as bytes and passed
 * through unchanged.
 *
 * **It copies response headers with `forEach`, which merges every `Set-Cookie`
 * into one comma-joined line.** A sign-in that sets a session cookie and a
 * `__Secure-` counterpart sends one malformed header instead of two, and the
 * browser stores neither. `getSetCookie()` is the only way to read them apart.
 *
 * **It builds the request URL from the `Host` header.** Behind a TLS-terminating
 * proxy the provider then believes it is on plain HTTP and drops the `Secure`
 * attribute from the cookie it is about to set. The URL here is built from what
 * Fastify resolved, which honours the forwarded headers when — and only when —
 * the server was told to trust its proxy.
 */

/** The web-standard shape the provider hands over: bytes in, bytes out. */
export type WebHandler = (request: Request) => Promise<Response>;

export type WebHandlerOptions = {
  readonly handler: WebHandler;
};

/**
 * Everything Fastify will route. `HEAD` is registered explicitly rather than
 * derived from `GET`, because the handler behind this decides for itself what a
 * `HEAD` means.
 */
export const WEB_HANDLER_METHODS = [
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
] as const;

/** Methods that carry no body, so no body is forwarded for them. */
const BODILESS = new Set(["GET", "HEAD"]);

/**
 * Fastify computes these from what it is actually about to write. Copying the
 * upstream values would describe a body that is no longer the one being sent.
 */
const RECOMPUTED = new Set(["content-length", "transfer-encoding"]);

/**
 * The origin the caller reached, as Fastify resolved it.
 *
 * Fastify reads `x-forwarded-proto` and `x-forwarded-host` when the server was
 * configured to trust its proxy, and ignores them otherwise — which is the
 * right split, because believing them with nothing in front means any client
 * can claim any origin.
 */
function originOf(request: FastifyRequest): string {
  return `${request.protocol}://${request.host}`;
}

function requestHeaders(request: FastifyRequest): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    // A header sent more than once arrives as an array, and each occurrence is
    // its own line. Joining them would invent a value nobody sent.
    if (Array.isArray(value)) {
      for (const each of value) headers.append(name, each);
    } else {
      headers.append(name, String(value));
    }
  }
  return headers;
}

function requestBody(request: FastifyRequest): Uint8Array | null {
  if (BODILESS.has(request.method)) return null;
  const body = request.body;
  if (!Buffer.isBuffer(body) || body.byteLength === 0) return null;
  // A copy, because Fastify may reuse the buffer once the reply is sent and the
  // handler is free to read the body whenever it likes.
  return new Uint8Array(body);
}

/**
 * A Fastify request as a web-standard one. The same conversion the route below
 * performs, exported because resolving an identity out of a session cookie
 * needs a `Request` too, and the provider is entitled to see the same headers
 * either way.
 */
export function toWebRequest(request: FastifyRequest): Request {
  return new Request(new URL(request.url, originOf(request)), {
    method: request.method,
    headers: requestHeaders(request),
    body: requestBody(request),
  });
}

/**
 * A Fastify plugin serving everything under its prefix from one web handler.
 *
 * Register it with a prefix — `app.register(webHandler, { prefix: "/api/auth",
 * handler })` — and everything below that path goes through. It is deliberately
 * not wrapped in `fastify-plugin`: the body parser it installs replaces every
 * other one, and Fastify's encapsulation is what keeps that replacement inside
 * this prefix rather than turning every JSON route in the API into bytes.
 */
export async function webHandler(
  app: FastifyInstance,
  options: WebHandlerOptions,
): Promise<void> {
  // The body reaches the handler exactly as it arrived. Removing the inherited
  // parsers first is what makes that true for `application/json` as well —
  // otherwise Fastify would parse it into an object, and re-encoding an object
  // is the defect this whole file exists to avoid.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser(
    "*",
    { parseAs: "buffer" },
    (_request, body, done) => {
      done(null, body);
    },
  );

  app.route({
    method: [...WEB_HANDLER_METHODS],
    url: "/",
    exposeHeadRoute: false,
    handler: serve,
  });
  app.route({
    method: [...WEB_HANDLER_METHODS],
    url: "/*",
    exposeHeadRoute: false,
    handler: serve,
  });

  async function serve(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const response = await options.handler(toWebRequest(request));

    reply.code(response.status);

    for (const [name, value] of response.headers) {
      const lower = name.toLowerCase();
      if (lower === "set-cookie" || RECOMPUTED.has(lower)) continue;
      reply.header(name, value);
    }

    // Every cookie as its own line. Fastify accumulates repeated `set-cookie`
    // headers into a list rather than overwriting, which is what makes this the
    // whole of it.
    for (const cookie of response.headers.getSetCookie()) {
      reply.header("set-cookie", cookie);
    }

    if (request.method === "HEAD" || response.body === null) {
      await reply.send();
      return;
    }

    await reply.send(Buffer.from(await response.arrayBuffer()));
  }
}
