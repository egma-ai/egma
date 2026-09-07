import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";

/**
 * Adapt a web Request/Response handler to Fastify. Forward supported methods
 * and raw request bytes, preserve separate Set-Cookie headers, and build URLs
 * from Fastify's resolved host/protocol. Forwarded headers depend on trustProxy.
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
 * A Fastify request as a web-standard one, body and all. What the route below
 * hands the provider, whose endpoints are the ones that genuinely read a body —
 * a sign-in posts credentials, RFC 8628's token endpoint posts a form.
 */
export function toWebRequest(request: FastifyRequest): Request {
  return new Request(new URL(request.url, originOf(request)), {
    method: request.method,
    headers: requestHeaders(request),
    body: requestBody(request),
  });
}

/**
 * Build a bodyless request for identity resolution. Authentication needs
 * headers and URL, so copying an ingestion payload would waste memory.
 */
export function toIdentityRequest(request: FastifyRequest): Request {
  return new Request(new URL(request.url, originOf(request)), {
    method: request.method,
    headers: requestHeaders(request),
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
