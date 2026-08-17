import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ROUTES } from "../src/routes.ts";
import {
  eventually,
  GATEWAY_SECRET,
  openSocket,
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
  it("are exactly three provider and model-job pairs, one for each shipped job", () => {
    expect(
      ROUTES.map((route) => `${route.provider}/${route.job} ${route.method} ${route.path}`).sort(),
    ).toEqual([
      "cartesia/tts GET /cartesia/tts/websocket",
      "deepgram/stt GET /deepgram/v1/listen",
      "openai/llm POST /openai/v1/chat/completions",
    ]);
  });

  it("each carry the provider's own path onto the provider's own address", async () => {
    const { world, openai, deepgram, cartesia } = standing;

    const answered = await fetch(`${world.origin}/openai/v1/chat/completions`, {
      method: "POST",
      headers: { ...AUTHENTICATED, "content-type": "application/json" },
      body: JSON.stringify({ model: "a-small-model", messages: [] }),
    });
    expect(answered.status).toBe(200);
    expect(openai.seen.at(-1)?.path).toBe("/v1/chat/completions");

    const listening = openSocket(world, "/deepgram/v1/listen?model=nova-3-general", {
      headers: AUTHENTICATED,
    });
    await watch(listening).opened;
    expect((await deepgram.opened()).path).toBe("/v1/listen");
    listening.close(1000, "done");

    const speaking = openSocket(world, "/cartesia/tts/websocket?cartesia_version=2025-04-16", {
      headers: AUTHENTICATED,
    });
    await watch(speaking).opened;
    expect((await cartesia.opened()).path).toBe("/tts/websocket");
    speaking.close(1000, "done");
  });
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
    { what: "a route with a suffix", path: "/openai/v1/chat/completions/extra", status: 404 },
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

  it("refuses a shipped route asked with the wrong method, without asking the provider", async () => {
    const before = standing.openai.attempts();
    const answered = await fetch(`${standing.world.origin}/openai/v1/chat/completions`, {
      method: "GET",
      headers: AUTHENTICATED,
    });
    expect(answered.status).toBe(405);
    expect(standing.openai.attempts()).toBe(before);
  });

  it("refuses an upgrade on a route that does not carry one", async () => {
    const before = standing.openai.attempts();
    const socket = openSocket(standing.world, "/openai/v1/chat/completions", {
      headers: AUTHENTICATED,
    });
    await expect(watch(socket).opened).rejects.toThrow();
    expect(standing.openai.attempts()).toBe(before);
  });

  it("refuses an ordinary request on a route that only carries a socket", async () => {
    const before = standing.deepgram.attempts();
    const answered = await fetch(`${standing.world.origin}/deepgram/v1/listen`, {
      headers: AUTHENTICATED,
    });
    expect(answered.status).toBe(400);
    expect(standing.deepgram.attempts()).toBe(before);
  });
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
