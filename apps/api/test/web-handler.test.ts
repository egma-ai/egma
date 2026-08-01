import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import {
  webHandler,
  WEB_HANDLER_METHODS,
  type WebHandler,
} from "../src/http/web-handler.ts";

/**
 * The Fastify adapter, on its own.
 *
 * It is tested against an echo rather than against the auth provider, because
 * what is under test is the carriage and not the cargo: whether every method
 * routes, whether the bytes that were sent are the bytes that arrive, whether
 * two cookies stay two cookies, and whether a proxy's word about the origin is
 * taken when — and only when — the server was told to take it. Answering those
 * against the provider would test the provider.
 */

let app: FastifyInstance;

afterEach(async () => {
  await app?.close();
});

/** Reports back exactly what it was handed, so the test can compare. */
const echo: WebHandler = async (request) => {
  const body = Buffer.from(await request.arrayBuffer());
  return Response.json({
    method: request.method,
    url: request.url,
    contentType: request.headers.get("content-type"),
    body: body.toString("utf8"),
    bodyBytes: [...body],
    cookie: request.headers.get("cookie"),
    forwardedProto: request.headers.get("x-forwarded-proto"),
  });
};

async function mount(
  handler: WebHandler,
  options: { trustProxy?: boolean } = {},
): Promise<FastifyInstance> {
  app = Fastify({ logger: false, trustProxy: options.trustProxy ?? false });
  // A JSON route outside the adapter's prefix, to prove that replacing every
  // body parser stays inside it.
  app.post("/outside", async (request) => ({ body: request.body }));
  void app.register(webHandler, { prefix: "/api/auth", handler });
  await app.ready();
  return app;
}

describe("every HTTP method", () => {
  it.each(WEB_HANDLER_METHODS)("routes to the handler: %s", async (method) => {
    await mount(echo);

    const response = await app.inject({
      method,
      url: "/api/auth/anything/at/all",
    });

    expect(response.statusCode).toBe(200);
    // A HEAD carries no body to read back, and its status is the point.
    if (method === "HEAD") {
      expect(response.body).toBe("");
      return;
    }
    expect(response.json().method).toBe(method);
  });

  it("reaches the prefix itself, not only what is under it", async () => {
    await mount(echo);

    const response = await app.inject({ method: "GET", url: "/api/auth" });
    expect(response.statusCode).toBe(200);
  });
});

describe("the body", () => {
  it("passes through form encoding unmodified, which is the CLI login path", async () => {
    await mount(echo);

    const payload =
      "grant_type=urn:ietf:params:oauth:grant-type:device_code&device_code=dvc_1";
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/device/token",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload,
    });

    const seen = response.json();
    expect(seen.body).toBe(payload);
    expect(seen.contentType).toBe("application/x-www-form-urlencoded");
  });

  it("passes JSON through as the bytes that were sent, not as a re-serialization", async () => {
    await mount(echo);

    // Whitespace and key order survive only if nothing parsed and re-encoded.
    const payload = '{  "b" : 2,\n  "a" : 1 }';
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      headers: { "content-type": "application/json" },
      payload,
    });

    expect(response.json().body).toBe(payload);
  });

  it("passes bytes that are not text at all", async () => {
    await mount(echo);

    const payload = Buffer.from([0x00, 0xff, 0x10, 0x7f, 0x00]);
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/anything",
      headers: { "content-type": "application/octet-stream" },
      payload,
    });

    expect(response.json().bodyBytes).toEqual([...payload]);
  });

  it("is left parsed for every route outside the prefix", async () => {
    await mount(echo);

    const response = await app.inject({
      method: "POST",
      url: "/outside",
      payload: { a: 1 },
    });

    expect(response.json()).toEqual({ body: { a: 1 } });
  });
});

describe("cookies coming back", () => {
  it("stay one header each, rather than being merged into one line", async () => {
    await mount(async () => {
      const headers = new Headers();
      headers.append("set-cookie", "egma.session_token=one; Path=/; HttpOnly");
      headers.append("set-cookie", "__Secure-egma.session=two; Path=/; Secure");
      return new Response("ok", { headers });
    });

    const response = await app.inject({ method: "GET", url: "/api/auth/x" });

    expect(response.headers["set-cookie"]).toEqual([
      "egma.session_token=one; Path=/; HttpOnly",
      "__Secure-egma.session=two; Path=/; Secure",
    ]);
  });

  it("reach the handler on the way in", async () => {
    await mount(echo);

    const response = await app.inject({
      method: "GET",
      url: "/api/auth/get-session",
      headers: { cookie: "egma.session_token=abc; other=def" },
    });

    expect(response.json().cookie).toBe("egma.session_token=abc; other=def");
  });
});

describe("the origin the handler is told about", () => {
  it("comes from the proxy when the server was told to trust one", async () => {
    await mount(echo, { trustProxy: true });

    const response = await app.inject({
      method: "GET",
      url: "/api/auth/x",
      headers: {
        host: "api.internal:3100",
        "x-forwarded-proto": "https",
        "x-forwarded-host": "egma.acme.example",
      },
    });

    // Without this the provider would believe it is on plain HTTP and drop the
    // Secure attribute from the session cookie it is about to set.
    expect(response.json().url).toBe("https://egma.acme.example/api/auth/x");
  });

  it("ignores the proxy when it was not, because anyone can send those headers", async () => {
    await mount(echo, { trustProxy: false });

    const response = await app.inject({
      method: "GET",
      url: "/api/auth/x",
      headers: {
        host: "api.internal:3100",
        "x-forwarded-proto": "https",
        "x-forwarded-host": "attacker.example",
      },
    });

    expect(response.json().url).toBe("http://api.internal:3100/api/auth/x");
    // The headers still reach the handler, which may have its own opinion.
    expect(response.json().forwardedProto).toBe("https");
  });

  it("keeps the query string, which is where a device code arrives", async () => {
    await mount(echo);

    const response = await app.inject({
      method: "GET",
      url: "/api/auth/device?user_code=WDJB-MJHT",
    });

    expect(response.json().url).toContain("?user_code=WDJB-MJHT");
  });
});

describe("the response", () => {
  it("carries the handler's status and headers", async () => {
    await mount(
      async () =>
        new Response("no", {
          status: 418,
          headers: { "content-type": "text/plain", "x-egma": "yes" },
        }),
    );

    const response = await app.inject({ method: "GET", url: "/api/auth/x" });

    expect(response.statusCode).toBe(418);
    expect(response.headers["x-egma"]).toBe("yes");
    expect(response.body).toBe("no");
  });

  it("carries a status with no body without inventing one", async () => {
    await mount(async () => new Response(null, { status: 204 }));

    const response = await app.inject({ method: "DELETE", url: "/api/auth/x" });

    expect(response.statusCode).toBe(204);
    expect(response.body).toBe("");
  });

  it("survives bytes that are not text", async () => {
    const payload = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
    await mount(
      async () =>
        new Response(payload, {
          headers: { "content-type": "application/octet-stream" },
        }),
    );

    const response = await app.inject({ method: "GET", url: "/api/auth/x" });
    expect(response.rawPayload.equals(payload)).toBe(true);
  });
});
