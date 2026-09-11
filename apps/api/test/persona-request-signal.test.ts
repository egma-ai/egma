import { request as httpRequest } from "node:http";

import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { requestSignal } from "../src/routes/personas.ts";

describe("persona request cancellation", () => {
  const app = Fastify();

  afterEach(async () => {
    await app.close();
  });

  it("aborts upstream work when a client disconnects after uploading the body", async () => {
    let upstreamAborted!: () => void;
    const aborted = new Promise<void>((resolve) => { upstreamAborted = resolve; });
    let requestStarted!: () => void;
    const started = new Promise<void>((resolve) => { requestStarted = resolve; });
    app.post("/preview", async (request, reply) => {
      const signal = requestSignal(request, reply);
      requestStarted();
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => {
          upstreamAborted();
          resolve();
        }, { once: true });
      });
      return reply.send({ canceled: true });
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (address === null || typeof address === "string") throw new Error("Fastify did not bind a TCP port");

    const client = httpRequest({
      host: "127.0.0.1",
      port: address.port,
      path: "/preview",
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    client.on("error", () => undefined);
    client.end("{}");
    await started;
    client.destroy();

    await expect(aborted).resolves.toBeUndefined();
  });
});
