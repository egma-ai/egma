import { afterEach, describe, expect, it } from "vitest";

import { ROUTES } from "../src/routes.ts";
import {
  CALLER_PROVIDER_KEY,
  EGMA_PROVIDER_KEY,
  eventually,
  GATEWAY_SECRET,
  openSocket,
  records,
  socketUpstreamOf,
  standUp,
  watch,
  type Standing,
} from "./support/world.ts";

/** Every row this gateway carries over a WebSocket. */
const SOCKET_ROUTES = ROUTES.filter((route) => route.transport === "socket");

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

  it("offers the provider no subprotocol of the caller's, because one of them is how a key travels", async () => {
    /**
     * `Sec-WebSocket-Protocol: token, <key>` is Deepgram's own documented way
     * for a client that cannot set a header to send its key. A relay that
     * forwarded a caller's requested list would therefore be forwarding a
     * caller's credential, on a route whose whole job is to remove one — so the
     * list the provider is offered comes from the route table and the caller's
     * is dropped.
     */
    standing = await standUp();
    const before = standing.deepgram.attempts();
    const socket = openSocket(standing.world, "/deepgram/v1/listen", {
      headers: AUTHENTICATED,
      protocols: ["token", "a-key-a-caller-brought"],
    });

    // Refused rather than dropped: a caller who put a key here believes it was
    // honoured, and the expensive version of this is the one where they go on
    // believing it. The provider is never asked.
    await expect(watch(socket).opened).rejects.toThrow(/400/);
    expect(standing.deepgram.attempts()).toBe(before);
  });

  it("has no shipped route that offers one, so nothing is offered at all today", () => {
    // The mechanism exists for the day a provider's own auth subprotocol has to
    // be injected from a deployment's credential. Until then this is the
    // assertion that keeps the answer at "none", and it fails the day somebody
    // adds one without meaning to.
    for (const route of ROUTES) {
      expect(route.upstreamProtocols ?? []).toEqual([]);
    }
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

  it("closes the provider's socket when the caller gives up during the handshake", async () => {
    /**
     * The one window where nothing else is watching. The caller's own socket
     * does not exist yet, so a caller who walks away here used to leave the
     * provider's socket open — and paid for — until the idle bound noticed it
     * two minutes later. The bound below is a fraction of that on purpose: what
     * is being proved is promptness, not eventual cleanup.
     */
    standing = await standUp({
      deepgram: {
        path: "/v1/listen",
        expect: {
          at: "header",
          name: "authorization",
          value: `Token ${EGMA_PROVIDER_KEY.deepgram}`,
        },
        silentForMs: 500,
      },
      settings: { EGMA_GATEWAY_SOCKET_IDLE_TIMEOUT_MS: "120000" },
    });
    const socket = openSocket(standing.world, "/deepgram/v1/listen", { headers: AUTHENTICATED });
    const seen = watch(socket);
    seen.opened.catch(() => undefined);
    // Gone before the provider has finished shaking hands.
    await new Promise((wait) => setTimeout(wait, 100));
    socket.terminate();

    const closed = await eventually(() => standing?.deepgram.seen.at(0)?.closedWith, 5_000);
    expect(closed.code).toBe(1001);

    const written = await eventually(() => records(standing?.world as never).at(-1));
    expect(written["statusClass"]).toBe("cancelled");
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

  /**
   * A talker that does not stop, into a listener that has.
   *
   * The volume is deliberately far past the bound: loopback kernel buffers
   * absorb a couple of megabytes on their own, so a smaller test would pass
   * against a relay with no bound at all — which is exactly what the first
   * version of this test did.
   */
  const OFFERED_FRAMES = 1024;
  const FRAME = 32 * 1024;

  async function shoutInto(socket: ReturnType<typeof openSocket>): Promise<void> {
    const frame = Buffer.alloc(FRAME, 7);
    for (let index = 0; index < OFFERED_FRAMES; index += 1) {
      socket.send(frame);
      // Every so often, so the relay's own turn on the loop actually happens.
      if (index % 64 === 0) await new Promise((wait) => setTimeout(wait, 10));
    }
  }

  it("stops reading a peer that is outrunning the other one, rather than buffering it", async () => {
    /**
     * The bound that is not about one frame.
     *
     * A listening leg sends audio continuously, and a provider that stops
     * keeping up does not say so — it simply reads more slowly. Every send on
     * both hosts is fire-and-forget into a buffer the host owns, so a relay
     * with no aggregate bound grows that buffer for as long as the fast side
     * keeps talking, and the first thing anybody learns about it is the isolate
     * dying.
     *
     * What is asserted is where the backpressure ends up. Thirty-two megabytes
     * are offered into a sixty-four kilobyte bound: if the gateway took them,
     * the caller would have written them all and be holding nothing. Instead
     * the caller is left holding most of it, which is what a full pipe feels
     * like from the far end of it.
     */
    standing = await standUp({
      settings: {
        EGMA_GATEWAY_MAX_BUFFERED_BYTES: "65536",
        EGMA_GATEWAY_BUFFER_DRAIN_MS: "60000",
      },
    });
    const socket = openSocket(standing.world, "/deepgram/v1/listen", { headers: AUTHENTICATED });
    const seen = watch(socket);
    await seen.opened;
    const provider = await standing.deepgram.opened();

    standing.deepgram.stopReading();
    await shoutInto(socket);

    expect(socket.bufferedAmount).toBeGreaterThan(8 * 1024 * 1024);
    expect(provider.frames.length).toBeLessThan(OFFERED_FRAMES);
    expect(seen.closed).toBeUndefined();

    // And when the far side starts keeping up again the exchange carries on,
    // having lost nothing: a held frame is never a dropped frame.
    standing.deepgram.startReading();
    await eventually(
      () => (provider.frames.length === OFFERED_FRAMES ? provider.frames : undefined),
      30_000,
    );
    expect(seen.closed).toBeUndefined();
    expect(provider.frames.every((one) => one.length === FRAME)).toBe(true);

    socket.close(1000, "done");
  }, 60_000);

  it("closes a socket whose far side never starts keeping up, loudly", async () => {
    standing = await standUp({
      settings: {
        EGMA_GATEWAY_MAX_BUFFERED_BYTES: "65536",
        EGMA_GATEWAY_BUFFER_DRAIN_MS: "500",
      },
    });
    const socket = openSocket(standing.world, "/deepgram/v1/listen", { headers: AUTHENTICATED });
    const seen = watch(socket);
    await seen.opened;
    await standing.deepgram.opened();

    standing.deepgram.stopReading();
    await shoutInto(socket).catch(() => undefined);

    // Never silently dropped and never grown without end: the exchange ends,
    // with the code that says which of the two happened.
    const how = await eventually(() => seen.closed, 30_000);
    expect(how.code).toBe(1013);

    const written = await eventually(() => records(standing?.world as never).at(-1));
    expect(written["statusClass"]).toBe("refused");
  }, 60_000);

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

/**
 * The same questions asked of every socket row.
 *
 * **What a relayed socket promises is the same promise on every route it
 * carries**: frames in the order they were sent, in both directions, until one
 * end hangs up — and then the hang-up itself crossing, with its own code. A
 * row whose provider is reached with the wrong path or whose close code is
 * rewritten is a voice simulation that ends silently rather than visibly, so
 * every row is asked rather than the two somebody wrote tests for.
 */
describe("every socket route this gateway carries", () => {
  for (const route of SOCKET_ROUTES) {
    describe(`${route.provider}/${route.job}`, () => {
      it("carries frames both ways, in order, text and binary alike", async () => {
        standing = await standUp();
        const socket = openSocket(standing.world, route.path, { headers: AUTHENTICATED });
        const seen = watch(socket);
        await seen.opened;
        const provider = await socketUpstreamOf(standing, route).opened();

        const sent: (string | Buffer)[] = [];
        for (let index = 0; index < 10; index += 1) {
          const frame = Buffer.from([index, index, index, index]);
          sent.push(frame);
          socket.send(frame);
          if (index === 5) {
            sent.push('{"type":"a native control message"}');
            socket.send('{"type":"a native control message"}');
          }
        }

        await eventually(() =>
          provider.frames.length === sent.length ? provider.frames : undefined,
        );
        expect(provider.frames.map(String)).toEqual(sent.map(String));

        // The strict stand-ins echo, so the same order comes back the other way
        // — which is the half a relay that buffered would get wrong.
        await eventually(() => (seen.frames.length === sent.length ? seen.frames : undefined));
        expect(seen.frames.map(String)).toEqual(sent.map(String));

        socket.close(1000, "done");
      });

      it("arrives at the provider with its own path, query and native headers", async () => {
        standing = await standUp();
        const socket = openSocket(
          standing.world,
          `${route.path}?intent=transcription&model=a-model-id&sample_rate=16000`,
          { headers: { ...AUTHENTICATED, "user-agent": "pipecat-shaped-client/1.0" } },
        );
        await watch(socket).opened;
        const provider = await socketUpstreamOf(standing, route).opened();

        expect(provider.path).toBe(route.upstreamPath);
        expect(provider.query.get("intent")).toBe("transcription");
        expect(provider.query.get("model")).toBe("a-model-id");
        expect(provider.query.get("sample_rate")).toBe("16000");
        expect(provider.headers["user-agent"]).toBe("pipecat-shaped-client/1.0");

        socket.close(1000, "done");
      });

      it("refuses a caller's subprotocol rather than forwarding it, and never asks the provider", async () => {
        standing = await standUp();
        const upstream = socketUpstreamOf(standing, route);
        const before = upstream.attempts();
        const socket = openSocket(standing.world, route.path, {
          headers: AUTHENTICATED,
          protocols: ["token", "a-key-a-caller-brought"],
        });

        await expect(watch(socket).opened).rejects.toThrow(/400/);
        expect(upstream.attempts()).toBe(before);
      });

      it("closes the provider's side with the caller's own code", async () => {
        standing = await standUp();
        const socket = openSocket(standing.world, route.path, { headers: AUTHENTICATED });
        await watch(socket).opened;
        const provider = await socketUpstreamOf(standing, route).opened();

        socket.close(4001, "the simulation ended");

        const how = await eventually(() => provider.closedWith);
        expect(how.code).toBe(4001);
        expect(how.reason).toBe("the simulation ended");
      });

      it("closes the caller's side when the provider goes away", async () => {
        standing = await standUp();
        const socket = openSocket(standing.world, route.path, { headers: AUTHENTICATED });
        const seen = watch(socket);
        await seen.opened;
        const provider = await socketUpstreamOf(standing, route).opened();

        provider.socket?.close(1011, "the provider gave up");

        const how = await eventually(() => seen.closed);
        expect(how.code).toBe(1011);
        expect(how.reason).toBe("the provider gave up");
      });

      it("closes a socket that sends one frame bigger than the bound, and carries it nowhere", async () => {
        standing = await standUp({ settings: { EGMA_GATEWAY_MAX_FRAME_BYTES: "4096" } });
        const socket = openSocket(standing.world, route.path, { headers: AUTHENTICATED });
        const seen = watch(socket);
        await seen.opened;
        const provider = await socketUpstreamOf(standing, route).opened();

        socket.send(Buffer.alloc(8192, 7));

        const how = await eventually(() => seen.closed);
        expect(how.code).toBe(1009);
        expect(provider.frames).toHaveLength(0);
      });
    });
  }
});
