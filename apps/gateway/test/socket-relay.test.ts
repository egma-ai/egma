import { afterEach, describe, expect, it } from "vitest";

import {
  CALLER_PROVIDER_KEY,
  EGMA_PROVIDER_KEY,
  eventually,
  GATEWAY_SECRET,
  openSocket,
  records,
  standUp,
  watch,
  type Standing,
} from "./support/world.ts";

/**
 * The two speech legs: sockets that carry audio one way and words the other,
 * and that have to end when either end says so.
 *
 * A voice simulation lives on these. The listening leg is fed the agent's
 * audio while the agent is still talking and answers while it is still
 * listening; the speaking leg is handed a sentence and answers with audio
 * before the sentence has finished being synthesised. Neither one has a
 * request and a response — they have frames, in order, until somebody hangs
 * up — so what is proved here is order, both directions, close codes, and the
 * bounds that stop one abandoned socket costing the gateway a slot forever.
 */

let standing: Standing | undefined;

afterEach(async () => {
  await standing?.world.stop();
  standing = undefined;
});

const AUTHENTICATED = { "egma-inference-key": GATEWAY_SECRET };

describe("a relayed socket", () => {
  it("carries frames both ways, in order, text and binary alike", async () => {
    standing = await standUp();
    const socket = openSocket(standing.world, "/deepgram/v1/listen", { headers: AUTHENTICATED });
    const seen = watch(socket);
    await seen.opened;
    const provider = await standing.deepgram.opened();

    // Audio the way a listening leg really sends it: many small binary frames,
    // with one text frame of control in the middle, exactly as Deepgram's own
    // keep-alive and finalize messages arrive.
    const sent: (string | Buffer)[] = [];
    for (let index = 0; index < 10; index += 1) {
      const frame = Buffer.from([index, index, index, index]);
      sent.push(frame);
      socket.send(frame);
      if (index === 5) {
        sent.push('{"type":"Finalize"}');
        socket.send('{"type":"Finalize"}');
      }
    }

    await eventually(() =>
      provider.frames.length === sent.length ? provider.frames : undefined,
    );
    expect(provider.frames.map(String)).toEqual(sent.map(String));

    // The strict provider echoes, so the same order comes back the other way.
    await eventually(() => (seen.frames.length === sent.length ? seen.frames : undefined));
    expect(seen.frames.map(String)).toEqual(sent.map(String));

    socket.close(1000, "done");
  });

  it("carries frames while the exchange is still open, rather than at the end of it", async () => {
    standing = await standUp();
    const socket = openSocket(standing.world, "/cartesia/tts/websocket", { headers: AUTHENTICATED });
    const seen = watch(socket);
    await seen.opened;
    const provider = await standing.cartesia.opened();

    socket.send('{"transcript":"hello there"}');
    // The answer is here while the socket is still open and while more could
    // still be sent — which is the whole difference between a relay and a
    // request-and-response.
    await eventually(() => (seen.frames.length > 0 ? seen.frames : undefined));
    expect(seen.closed).toBeUndefined();
    expect(socket.readyState).toBe(socket.OPEN);
    expect(provider.frames).toHaveLength(1);

    socket.close(1000, "done");
  });

  it("arrives at the provider with its own path, query and native headers", async () => {
    standing = await standUp();
    const socket = openSocket(
      standing.world,
      "/deepgram/v1/listen?model=nova-3-general&encoding=linear16&sample_rate=16000&interim_results=true",
      { headers: { ...AUTHENTICATED, "user-agent": "pipecat-shaped-client/1.0" } },
    );
    await watch(socket).opened;
    const provider = await standing.deepgram.opened();

    expect(provider.path).toBe("/v1/listen");
    expect(provider.query.get("model")).toBe("nova-3-general");
    expect(provider.query.get("encoding")).toBe("linear16");
    expect(provider.query.get("sample_rate")).toBe("16000");
    expect(provider.query.get("interim_results")).toBe("true");
    expect(provider.headers["user-agent"]).toBe("pipecat-shaped-client/1.0");
    expect(provider.headers["authorization"]).toBe(`Token ${EGMA_PROVIDER_KEY.deepgram}`);

    socket.close(1000, "done");
  });

  it("offers the caller's subprotocols to the provider and answers with the one it chose", async () => {
    standing = await standUp({
      deepgram: {
        path: "/v1/listen",
        expect: {
          at: "header",
          name: "authorization",
          value: `Token ${EGMA_PROVIDER_KEY.deepgram}`,
        },
        selectProtocol: "the-second-one",
      },
    });
    const socket = openSocket(standing.world, "/deepgram/v1/listen", {
      headers: AUTHENTICATED,
      protocols: ["the-first-one", "the-second-one"],
    });
    await watch(socket).opened;
    const provider = await standing.deepgram.opened();

    expect(provider.protocols).toEqual(["the-first-one", "the-second-one"]);
    expect(socket.protocol).toBe("the-second-one");

    socket.close(1000, "done");
  });
});

describe("hanging up", () => {
  it("closes the provider's side with the caller's own code", async () => {
    standing = await standUp();
    const socket = openSocket(standing.world, "/deepgram/v1/listen", { headers: AUTHENTICATED });
    await watch(socket).opened;
    const provider = await standing.deepgram.opened();

    socket.close(4001, "the simulation ended");

    const how = await eventually(() => provider.closedWith);
    expect(how.code).toBe(4001);
    expect(how.reason).toBe("the simulation ended");
  });

  it("closes the caller's side when the provider goes away", async () => {
    standing = await standUp();
    const socket = openSocket(standing.world, "/cartesia/tts/websocket", { headers: AUTHENTICATED });
    const seen = watch(socket);
    await seen.opened;
    const provider = await standing.cartesia.opened();

    provider.socket?.close(1011, "the provider gave up");

    const how = await eventually(() => seen.closed);
    expect(how.code).toBe(1011);
    expect(how.reason).toBe("the provider gave up");
  });

  it("closes the caller's side when the provider's connection breaks", async () => {
    standing = await standUp();
    const socket = openSocket(standing.world, "/cartesia/tts/websocket", { headers: AUTHENTICATED });
    const seen = watch(socket);
    await seen.opened;
    const provider = await standing.cartesia.opened();

    provider.socket?.terminate();

    const how = await eventually(() => seen.closed);
    // A broken connection is not a code anybody sent, so it becomes the one it
    // really means rather than being passed on as itself.
    expect(how.code).toBe(1011);
  });
});

describe("the bounds a shared gateway has to have", () => {
  it("refuses a handshake the provider never completes, within a finite bound", async () => {
    standing = await standUp({
      deepgram: {
        path: "/v1/listen",
        expect: {
          at: "header",
          name: "authorization",
          value: `Token ${EGMA_PROVIDER_KEY.deepgram}`,
        },
        silentForMs: 30_000,
      },
      settings: { EGMA_GATEWAY_FIRST_OUTPUT_TIMEOUT_MS: "400" },
    });
    const startedAt = Date.now();
    const socket = openSocket(standing.world, "/deepgram/v1/listen", { headers: AUTHENTICATED });
    await expect(watch(socket).opened).rejects.toThrow(/504/);
    expect(Date.now() - startedAt).toBeLessThan(3_000);
  });

  it("closes a socket that has carried nothing for too long", async () => {
    standing = await standUp({ settings: { EGMA_GATEWAY_SOCKET_IDLE_TIMEOUT_MS: "300" } });
    const socket = openSocket(standing.world, "/deepgram/v1/listen", { headers: AUTHENTICATED });
    const seen = watch(socket);
    await seen.opened;

    const how = await eventually(() => seen.closed);
    expect(how.code).toBe(1001);

    const written = await eventually(() => records(standing?.world as never).at(-1));
    expect(written["statusClass"]).toBe("timed-out");
  });

  it("closes a socket that sends one frame bigger than the bound, and carries it nowhere", async () => {
    standing = await standUp({ settings: { EGMA_GATEWAY_MAX_FRAME_BYTES: "1024" } });
    const socket = openSocket(standing.world, "/deepgram/v1/listen", { headers: AUTHENTICATED });
    const seen = watch(socket);
    await seen.opened;
    const provider = await standing.deepgram.opened();

    socket.send(Buffer.alloc(64, 7));
    await eventually(() => (provider.frames.length === 1 ? provider.frames : undefined));

    socket.send(Buffer.alloc(4096, 9));
    const how = await eventually(() => seen.closed);
    expect(how.code).toBe(1009);
    // The oversized frame never crossed; the one before it did.
    expect(provider.frames).toHaveLength(1);
  });
});

describe("when the provider refuses the connection", () => {
  it("refuses the caller's handshake, once, with nothing about the provider in it", async () => {
    standing = await standUp({
      deepgram: {
        path: "/v1/listen",
        expect: {
          at: "header",
          name: "authorization",
          value: `Token ${EGMA_PROVIDER_KEY.deepgram}`,
        },
        refuseWith: 403,
      },
    });
    const socket = openSocket(standing.world, "/deepgram/v1/listen", { headers: AUTHENTICATED });
    await expect(watch(socket).opened).rejects.toThrow(/403/);
    expect(standing.deepgram.attempts()).toBe(1);

    const written = await eventually(() => records(standing?.world as never).at(-1));
    expect(written["statusClass"]).toBe("provider-refused");
    expect(standing.world.raw.join("\n")).not.toContain(EGMA_PROVIDER_KEY.deepgram);
  });

  it("never falls back to another provider or another route", async () => {
    standing = await standUp({
      cartesia: {
        path: "/tts/websocket",
        expect: { at: "query", name: "api_key", value: EGMA_PROVIDER_KEY.cartesia },
        refuseWith: 402,
      },
    });
    const before = {
      deepgram: standing.deepgram.attempts(),
      openai: standing.openai.attempts(),
    };
    const socket = openSocket(standing.world, "/cartesia/tts/websocket", {
      headers: { ...AUTHENTICATED, authorization: `Bearer ${CALLER_PROVIDER_KEY}` },
    });
    await expect(watch(socket).opened).rejects.toThrow();
    expect(standing.cartesia.attempts()).toBe(1);
    expect(standing.deepgram.attempts()).toBe(before.deepgram);
    expect(standing.openai.attempts()).toBe(before.openai);
  });
});
