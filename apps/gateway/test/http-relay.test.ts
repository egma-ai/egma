import { afterEach, describe, expect, it } from "vitest";

import { ROUTES } from "../src/routes.ts";
import {
  EGMA_PROVIDER_KEY,
  eventually,
  GATEWAY_SECRET,
  providerOf,
  records,
  standUp,
  withUpstream,
  type Standing,
} from "./support/world.ts";

/** Every row this gateway carries over ordinary HTTP. */
const HTTP_ROUTES = ROUTES.filter((route) => route.transport === "http");

/**
 * The LLM leg: a streaming HTTP request that starts moving before either end
 * has finished.
 *
 * **Every assertion here is about time, not about content.** A relay that
 * buffered would still return the right bytes — it would simply return them
 * late, and on a voice path late is the whole failure. So the provider is made
 * to answer in pieces with gaps between them, and the tests read *when* each
 * piece arrived rather than only that it did.
 *
 * The other half is what happens when something goes wrong: a provider that
 * refuses, one that cannot be reached, one that goes quiet, and a caller who
 * hangs up. Each has to end visibly, once, without a second attempt at anybody.
 */

let standing: Standing | undefined;

afterEach(async () => {
  await standing?.world.stop();
  standing = undefined;
});

const AUTHENTICATED = {
  "egma-inference-key": GATEWAY_SECRET,
  "content-type": "application/json",
};

/** Read a streamed answer, recording when each piece arrived. */
async function readWithTiming(
  response: Response,
): Promise<{ pieces: { at: number; text: string }[]; text: string }> {
  const startedAt = Date.now();
  const pieces: { at: number; text: string }[] = [];
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const piece = decoder.decode(value, { stream: true });
    text += piece;
    pieces.push({ at: Date.now() - startedAt, text: piece });
  }
  return { pieces, text };
}

describe("the provider's answer", () => {
  it("comes back with the provider's own status, headers and body, apart from what never returns", async () => {
    standing = await standUp({
      openai: {
        path: "/v1/chat/completions",
        expectAuthorization: `Bearer ${EGMA_PROVIDER_KEY.openai}`,
        chunks: ["one-piece"],
        headers: {
          "x-provider-said": "a native header",
          "set-cookie": "provider_state=should-not-cross",
        },
      },
    });
    const answered = await fetch(`${standing.world.origin}/openai/v1/chat/completions`, {
      method: "POST",
      headers: AUTHENTICATED,
      body: JSON.stringify({ model: "a-small-model", messages: [] }),
    });
    expect(answered.status).toBe(200);
    expect(answered.headers.get("x-provider-said")).toBe("a native header");
    expect(answered.headers.get("content-type")).toBe("text/event-stream");
    expect(answered.headers.get("set-cookie")).toBeNull();
    expect(await answered.text()).toBe("one-piece");
  });
});

describe("the caller's request", () => {
  it("reaches the provider before the caller has finished writing it", async () => {
    standing = await standUp();
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(new TextEncoder().encode('{"model":"a-small-model","messages":['));
        await new Promise((wait) => setTimeout(wait, 400));
        controller.enqueue(new TextEncoder().encode('{"role":"user","content":"hello"}]}'));
        controller.close();
      },
    });

    const answered = await fetch(`${standing.world.origin}/openai/v1/chat/completions`, {
      method: "POST",
      headers: AUTHENTICATED,
      body,
      duplex: "half",
    } as RequestInit);
    await answered.text();

    const seen = standing.openai.seen.at(-1);
    expect(seen?.body).toContain('"content":"hello"');
    // The provider had the first bytes long before the last ones were written.
    expect(seen?.bodyFirstByteMs).toBeLessThan(200);
    expect(seen?.bodyEndedMs).toBeGreaterThan(350);
  });
});

describe("when the exchange does not go well", () => {
  it("returns a provider's refusal as it stands, and does not try again", async () => {
    standing = await standUp({
      openai: {
        path: "/v1/chat/completions",
        // The strict provider answers 401 to anything that is not this, and
        // this is deliberately not what the gateway injects — so what comes
        // back is a real provider refusal rather than a simulated one.
        expectAuthorization: "Bearer a-key-this-deployment-does-not-hold",
      },
    });
    const answered = await fetch(`${standing.world.origin}/openai/v1/chat/completions`, {
      method: "POST",
      headers: AUTHENTICATED,
      body: "{}",
    });
    expect(answered.status).toBe(401);
    expect(standing.openai.attempts()).toBe(1);

    const written = await eventually(() => records(standing?.world as never).at(-1));
    expect(written["statusClass"]).toBe("provider-refused");
  });

  it("gives up on a provider that went quiet, within a finite bound", async () => {
    standing = await standUp({
      openai: {
        path: "/v1/chat/completions",
        expectAuthorization: `Bearer ${EGMA_PROVIDER_KEY.openai}`,
        silentForMs: 30_000,
      },
      settings: {
        EGMA_GATEWAY_FIRST_OUTPUT_TIMEOUT_MS: "400",
        EGMA_GATEWAY_EXCHANGE_TIMEOUT_MS: "5000",
      },
    });
    const startedAt = Date.now();
    const answered = await fetch(`${standing.world.origin}/openai/v1/chat/completions`, {
      method: "POST",
      headers: AUTHENTICATED,
      body: "{}",
    });
    expect(answered.status).toBe(504);
    expect(Date.now() - startedAt).toBeLessThan(3_000);
    expect(standing.openai.attempts()).toBe(1);

    const written = await eventually(() => records(standing?.world as never).at(-1));
    expect(written["statusClass"]).toBe("timed-out");
  });

  it("stops the provider's work when the caller hangs up", async () => {
    standing = await standUp({
      openai: {
        path: "/v1/chat/completions",
        expectAuthorization: `Bearer ${EGMA_PROVIDER_KEY.openai}`,
        chunks: ["one", "two", "three", "four", "five"],
        gapMs: 300,
      },
    });

    const giveUp = new AbortController();
    const answered = await fetch(`${standing.world.origin}/openai/v1/chat/completions`, {
      method: "POST",
      headers: AUTHENTICATED,
      body: "{}",
      signal: giveUp.signal,
    });
    const reader = (answered.body as ReadableStream<Uint8Array>).getReader();
    await reader.read();
    giveUp.abort();

    const written = await eventually(() =>
      records(standing?.world as never).find((line) => line["provider"] === "openai"),
    );
    /**
     * `cancelled`, and not `ok`.
     *
     * The provider's status is known when its headers arrive, which on a
     * streamed answer is at the very beginning — so a record frozen at that
     * moment says `200`, and a stream the caller walked out on is filed as a
     * completed one. That is the failure this assertion exists for, and
     * accepting either answer here is what hid it.
     */
    expect(written["statusClass"]).toBe("cancelled");
    // One attempt at the provider and no second one, and the exchange ended
    // long before the provider's five slow pieces would have finished.
    expect(standing.openai.attempts()).toBe(1);
    expect(written["bytesFromProvider"]).toBeLessThan(20);
  });

  it("settles at once when the provider breaks the body it had already started", async () => {
    /**
     * The failure with no status line to report it with. The provider answered
     * `200`, some of the answer crossed, and then it died — so there is no
     * status to classify and no end of stream to notice. A relay that only
     * settles its record on a clean finish waits out its own timeout here, and
     * files a provider that broke as an exchange that ran long.
     */
    standing = await standUp({
      openai: {
        path: "/v1/chat/completions",
        expectAuthorization: `Bearer ${EGMA_PROVIDER_KEY.openai}`,
        chunks: ["first", "second", "third", "fourth"],
        gapMs: 30,
        breakAfterChunks: 2,
      },
      // Far longer than this test may take: what is being proved is that the
      // record does not wait for either of them.
      settings: {
        EGMA_GATEWAY_EXCHANGE_TIMEOUT_MS: "60000",
        EGMA_GATEWAY_FIRST_OUTPUT_TIMEOUT_MS: "30000",
      },
    });

    const startedAt = Date.now();
    const answered = await fetch(`${standing.world.origin}/openai/v1/chat/completions`, {
      method: "POST",
      headers: AUTHENTICATED,
      body: "{}",
    });
    expect(answered.status).toBe(200);

    // Downstream is terminated rather than left hanging: reading the rest of
    // the body fails instead of waiting for an end that is never coming.
    await expect(readWithTiming(answered)).rejects.toThrow();

    const written = await eventually(() =>
      records(standing?.world as never).find((line) => line["provider"] === "openai"),
    );
    expect(written["statusClass"]).toBe("provider-failed");
    expect(Date.now() - startedAt).toBeLessThan(10_000);
    // What had already crossed is on the record rather than being lost with it.
    expect(written["bytesFromProvider"]).toBeGreaterThan(0);
  });

  it("says a provider is unreachable without saying where it is", async () => {
    standing = await standUp({
      settings: { EGMA_GATEWAY_OPENAI_HOME: "http://127.0.0.1:1" },
    });
    const answered = await fetch(`${standing.world.origin}/openai/v1/chat/completions`, {
      method: "POST",
      headers: AUTHENTICATED,
      body: "{}",
    });
    expect(answered.status).toBe(502);
    const body = await answered.text();
    expect(body).not.toContain("127.0.0.1");
    expect(body).not.toContain("ECONNREFUSED");
  });
});

/**
 * The same questions asked of every HTTP row, rather than of the one somebody
 * wrote a test for.
 *
 * **A relay is only a relay if it is one for every route it carries.** The
 * behaviours below are the ones a buffering or a rewriting implementation gets
 * wrong quietly: a first piece that arrives with the last, a body that reached
 * the provider changed, a caller who hung up whose work carried on being paid
 * for, and a provider that went silent forever. Each is asked of every row, so
 * a route added to the table cannot ship with any of them untested.
 */
describe("every HTTP route this gateway carries", () => {
  for (const route of HTTP_ROUTES) {
    describe(`${route.provider}/${route.job}`, () => {
      it("hands the caller the provider's first piece long before its last exists", async () => {
        standing = await standUp(
          withUpstream(route, {
            chunks: ["first-piece", "second-piece", "last-piece"],
            gapMs: 300,
          }),
        );

        const answered = await fetch(`${standing.world.origin}${route.path}`, {
          method: route.method,
          headers: AUTHENTICATED,
          body: JSON.stringify({ model: "a-small-model", input: "two words" }),
        });
        const { pieces, text } = await readWithTiming(answered);

        expect(text).toContain("first-piece");
        expect(text).toContain("last-piece");
        const first = pieces[0];
        const last = pieces.at(-1);
        expect(first).toBeDefined();
        expect(last).toBeDefined();
        expect((last as { at: number }).at - (first as { at: number }).at).toBeGreaterThan(400);
      });

      it("arrives with its method, path, query, content type and body unchanged", async () => {
        standing = await standUp();
        const asked = { model: "a-small-model", input: "héllo ✅", speed: 1.25, voice: "a-voice" };
        await fetch(`${standing.world.origin}${route.path}?stream_options=include_usage&keep=me`, {
          method: route.method,
          headers: {
            ...AUTHENTICATED,
            "openai-beta": "a provider-native header",
            accept: "text/event-stream",
          },
          body: JSON.stringify(asked),
        });

        const seen = providerOf(standing, route).last();
        expect(seen?.path).toBe(route.upstreamPath);
        expect(seen?.query.get("stream_options")).toBe("include_usage");
        expect(seen?.query.get("keep")).toBe("me");
        expect(seen?.headers["openai-beta"]).toBe("a provider-native header");
        expect(seen?.headers["content-type"]).toBe("application/json");
        expect(standing.openai.seen.at(-1)?.method).toBe(route.method);
        // The model, the voice and the speed all ride inside the payload for
        // these routes, and the payload crosses byte for byte.
        expect(standing.openai.seen.at(-1)?.body).toBe(JSON.stringify(asked));
      });

      it("stops the provider's work when the caller hangs up", async () => {
        standing = await standUp(
          withUpstream(route, {
            chunks: ["one", "two", "three", "four", "five"],
            gapMs: 200,
          }),
        );

        const giveUp = new AbortController();
        const answered = await fetch(`${standing.world.origin}${route.path}`, {
          method: route.method,
          headers: AUTHENTICATED,
          body: JSON.stringify({ model: "a-small-model", input: "two words" }),
          signal: giveUp.signal,
        });
        const reader = (answered.body as ReadableStream<Uint8Array>).getReader();
        await reader.read();
        giveUp.abort();

        // The exchange is recorded as the cancellation it was, rather than as
        // the `200` the headers had already promised.
        const written = await eventually(() =>
          records(standing?.world as NonNullable<typeof standing>["world"]).find(
            (line) => line["statusClass"] === "cancelled" && line["job"] === route.job,
          ),
        );
        expect(written["provider"]).toBe(route.provider);
      });

      it("gives up on a provider that went quiet, within a finite bound", async () => {
        standing = await standUp({
          ...withUpstream(route, { silentForMs: 5_000 }),
          settings: { EGMA_GATEWAY_FIRST_OUTPUT_TIMEOUT_MS: "300" },
        });

        const began = Date.now();
        const answered = await fetch(`${standing.world.origin}${route.path}`, {
          method: route.method,
          headers: AUTHENTICATED,
          body: JSON.stringify({ model: "a-small-model", input: "two words" }),
        });
        const body = (await answered.json()) as { error: { code: string } };

        expect(answered.status).toBe(504);
        expect(body.error.code).toBe("provider_timed_out");
        expect(Date.now() - began).toBeLessThan(3_000);
      });
    });
  }
});
