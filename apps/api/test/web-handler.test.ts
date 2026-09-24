import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { webHandler, type WebHandler } from "../src/http/web-handler.ts";

/**
 * Use an echo handler to test HTTP method and body forwarding, separate
 * Set-Cookie headers, and explicitly trusted proxy origin headers.
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
  void app.register(webHandler, { prefix: "/api/auth", handler });
  await app.ready();
  return app;
}

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
});
