import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ROUTES } from "../src/routes.ts";
import {
  eventually,
  GATEWAY_SECRET,
  openSocket,
  providerOf,
  reach,
  records,
  standUp,
  watch,
  type Standing,
} from "./support/world.ts";

/**
 * What the Egma model gateway will carry, and everything it will not.
 *
 * The routes are fixed, and this is where that word is cashed. Every row in the
 * table is reachable and behaves like the provider's own address; nothing
 * outside the table is reachable at all — not another path, not another method,
 * not another transport, and above all not a host somebody named in a request.
 * A relay that can be talked into going somewhere is a proxy, and a public
 * proxy carrying Egma's provider credentials is the thing this design exists to
 * refuse.
 */

let standing: Standing;

beforeAll(async () => {
  standing = await standUp();
});

afterAll(async () => {
  await standing.world.stop();
});

const AUTHENTICATED = { "egma-inference-key": GATEWAY_SECRET };

describe("the shipped routes", () => {
  it("are exactly the provider and model-job pairs this release proved", () => {
    expect(
      ROUTES.map((route) => `${route.provider}/${route.job} ${route.method} ${route.path}`).sort(),
    ).toEqual([
      "cartesia/tts GET /cartesia/tts/websocket",
      "deepgram/stt GET /deepgram/v1/listen",
      "openai/llm POST /openai/v1/chat/completions",
      "openai/stt GET /openai/v1/realtime",
      "openai/tts POST /openai/v1/audio/speech",
    ]);
  });

  /**
   * **Driven from the table itself rather than route by route**, so a row added
   * to `ROUTES` without a provider behind it fails here rather than shipping as
   * a path that answers `404` in a customer's voice simulation. Every check
   * below is the same question asked of every row.
   */
  for (const route of ROUTES) {
    describe(`${route.provider}/${route.job}`, () => {
      it("carries the provider's own path onto the provider's own address", async () => {
        const provider = providerOf(standing, route);
        await reach(standing, route);
        expect(provider.last()?.path).toBe(route.upstreamPath);
      });

      it("refuses the methods it does not carry, without asking the provider", async () => {
        const provider = providerOf(standing, route);
        const before = provider.attempts();
        for (const method of ["PUT", "DELETE", "PATCH"] as const) {
          const answered = await fetch(`${standing.world.origin}${route.path}`, {
            method,
            headers: AUTHENTICATED,
          });
          expect(answered.status).toBe(405);
          await answered.text();
        }
        expect(provider.attempts()).toBe(before);
      });

      it("refuses the transport it does not carry, without asking the provider", async () => {
        const provider = providerOf(standing, route);
        const before = provider.attempts();

        if (route.transport === "socket") {
          const answered = await fetch(`${standing.world.origin}${route.path}`, {
            method: route.method,
            headers: AUTHENTICATED,
          });
          // A socket route asked without an upgrade: the row was found and
          // used wrongly, which is a different answer from a row nobody ships.
          expect(answered.status).toBe(400);
          await answered.text();
        } else {
          const socket = openSocket(standing.world, route.path, { headers: AUTHENTICATED });
          await expect(watch(socket).opened).rejects.toThrow();
        }

        expect(provider.attempts()).toBe(before);
      });

      it("is refused with a suffix on it, so no row is a prefix anybody can extend", async () => {
        const provider = providerOf(standing, route);
        const before = provider.attempts();
        const answered = await fetch(`${standing.world.origin}${route.path}/extra`, {
          method: route.method,
          headers: AUTHENTICATED,
        });
        expect(answered.status).toBe(404);
        await answered.text();
        expect(provider.attempts()).toBe(before);
      });
    });
  }
});

describe("everything that is not a shipped route", () => {
  /**
   * The table is written as the shapes somebody would really try, rather than
   * as a list of strings: a path that looks like a provider's, a path that
   * tries to name an upstream, a traversal out of a route's prefix, and the
   * provider's own address written in full.
   */
  const refused = [
    { what: "a path nobody ships", path: "/anthropic/v1/messages", status: 404 },
    { what: "a provider's root", path: "/openai", status: 404 },
    { what: "an upstream named in the path", path: "/https://api.openai.com/v1/models", status: 404 },
    {
      what: "an upstream named in a query",
      path: "/openai/v1/chat/completions?url=https://elsewhere.example",
      status: 405,
    },
    { what: "a traversal out of a route", path: "/deepgram/v1/../../v1/models", status: 404 },
    { what: "the gateway's own root", path: "/", status: 404 },
  ] as const;

  for (const { what, path, status } of refused) {
    it(`refuses ${what}, and says nothing about what is behind it`, async () => {
      const answered = await fetch(`${standing.world.origin}${path}`, { headers: AUTHENTICATED });
      expect(answered.status).toBe(status);
      const body = (await answered.json()) as { error: { code: string; message: string } };
      expect(body.error.message).not.toContain("api.");
      expect(body.error.message).not.toContain("127.0.0.1");
    });
  }

});

describe("the health check", () => {
  it("answers without a credential, because a deployment asking is not a customer", async () => {
    const answered = await fetch(`${standing.world.origin}/health`);
    expect(answered.status).toBe(200);
    expect(await answered.json()).toEqual({ status: "ok" });
  });

  it("writes no record, because it belongs to no organization", async () => {
    const before = records(standing.world).length;
    await fetch(`${standing.world.origin}/health`);
    await new Promise((wait) => setTimeout(wait, 50));
    expect(records(standing.world).length).toBe(before);
  });

  it("is not a route that can be made to reach a provider", async () => {
    const attempts =
      standing.openai.attempts() + standing.deepgram.attempts() + standing.cartesia.attempts();
    await fetch(`${standing.world.origin}/health?url=https://api.openai.com`);
    expect(
      standing.openai.attempts() + standing.deepgram.attempts() + standing.cartesia.attempts(),
    ).toBe(attempts);
  });
});

describe("a refused request", () => {
  it("still leaves a record, so a refusal is visible to whoever operates this", async () => {
    await fetch(`${standing.world.origin}/anthropic/v1/messages`, { headers: AUTHENTICATED });
    const written = await eventually(() =>
      records(standing.world).find((line) => line["statusClass"] === "refused"),
    );
    expect(written["requestId"]).toMatch(/^gwr_[0-9A-HJKMNP-TV-Z]{26}$/);
  });
});
