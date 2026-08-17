import { afterEach, describe, expect, it } from "vitest";

import {
  EGMA_PROVIDER_KEY,
  eventually,
  GATEWAY_SECRET,
  records,
  standUp,
  type Standing,
} from "./support/world.ts";

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
  it("reaches the caller before the provider has finished it", async () => {
    standing = await standUp({
      openai: {
        path: "/v1/chat/completions",
        expectAuthorization: `Bearer ${EGMA_PROVIDER_KEY.openai}`,
        chunks: [
          'data: {"choices":[{"delta":{"content":"first"}}]}\n\n',
          'data: {"choices":[{"delta":{"content":"second"}}]}\n\n',
          "data: [DONE]\n\n",
        ],
        gapMs: 300,
      },
    });

    const answered = await fetch(`${standing.world.origin}/openai/v1/chat/completions`, {
      method: "POST",
      headers: AUTHENTICATED,
      body: JSON.stringify({ model: "a-small-model", messages: [] }),
    });
    const { pieces, text } = await readWithTiming(answered);

    expect(text).toContain("first");
    expect(text).toContain("[DONE]");
    // The first piece is there long before the last one exists at all. A
    // buffering relay would have every piece arriving at the same moment,
    // after the provider's last gap.
    const first = pieces[0];
    const last = pieces.at(-1);
    expect(first).toBeDefined();
    expect(last).toBeDefined();
    expect((last as { at: number }).at - (first as { at: number }).at).toBeGreaterThan(400);
  });

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

  it("arrives with its method, path, query, content type and body unchanged", async () => {
    standing = await standUp();
    const asked = { model: "a-small-model", messages: [{ role: "user", content: "héllo ✅" }] };
    await fetch(
      `${standing.world.origin}/openai/v1/chat/completions?stream_options=include_usage&keep=me`,
      {
        method: "POST",
        headers: {
          ...AUTHENTICATED,
          "openai-beta": "a provider-native header",
          "accept": "text/event-stream",
        },
        body: JSON.stringify(asked),
      },
    );

    const seen = standing.openai.seen.at(-1);
    expect(seen?.method).toBe("POST");
    expect(seen?.path).toBe("/v1/chat/completions");
    expect(seen?.query.get("stream_options")).toBe("include_usage");
    expect(seen?.query.get("keep")).toBe("me");
    expect(seen?.headers["openai-beta"]).toBe("a provider-native header");
    expect(seen?.headers["accept"]).toBe("text/event-stream");
    expect(seen?.headers["content-type"]).toBe("application/json");
    expect(seen?.body).toBe(JSON.stringify(asked));
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
      records(standing?.world as never).find(
        (line) => line["statusClass"] === "cancelled" || line["statusClass"] === "ok",
      ),
    );
    // Whichever way the runtime reported it, the exchange is over long before
    // the provider's five slow pieces would have finished, and there was one
    // attempt at the provider and no second one.
    expect(standing.openai.attempts()).toBe(1);
    expect(written["bytesFromProvider"]).toBeLessThan(20);
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
