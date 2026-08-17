import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.ts";
import { relaySocket } from "../src/relay-socket.ts";
import { ROUTES } from "../src/routes.ts";
import type { Duplex, Frame, SocketHost } from "../src/socket.ts";
import { EGMA_PROVIDER_KEY, GATEWAY_SECRET, ORGANIZATION } from "./support/world.ts";

/**
 * What the bound is worth on a host that cannot stop reading.
 *
 * Every other socket test in this suite drives the local host over real
 * sockets, which is the right seam and the one a simulator uses. **This file
 * cannot, and that is the whole reason it exists.** The deployed host is
 * Cloudflare's runtime, which delivers frames as events and offers no way to
 * stop taking them — so its adapter has no `pauseReading`, and the behaviour
 * that follows from that absence is invisible to a suite driving a host which
 * has one. The local host would pass a test the deployed host fails.
 *
 * So the seam here is `relaySocket` and the `SocketHost` it is handed: the real
 * relay, with a host of exactly the shape the deployed one has. Nothing about
 * the relay is mocked; what is supplied is a host, which is the thing hosts are
 * for.
 *
 * The failure being held down is a memory one, and it belongs to whoever is
 * sharing the isolate rather than to the caller who caused it. A sender that
 * keeps talking into a provider that has stopped listening used to have the
 * whole drain window — ten seconds — to hand frames to a stalled socket at
 * whatever rate it could manage, because the pause that window exists to wait
 * for is a no-op there.
 */

const ROUTE = ROUTES.find((one) => one.path === "/deepgram/v1/listen");
if (ROUTE === undefined) throw new Error("the listening route is not in the table");

/** A bound small enough to reach in a test, and a window long enough that
 * reaching it cannot be what ended the exchange. */
const BOUND = 64 * 1024;
const CEILING = BOUND * 2;
const FRAME = 8 * 1024;

function configuration(extra: Record<string, string> = {}) {
  return loadConfig({
    EGMA_GATEWAY_ORGANIZATION_SECRET: GATEWAY_SECRET,
    EGMA_GATEWAY_ORGANIZATION_ID: ORGANIZATION,
    EGMA_GATEWAY_INFERENCE_KEY_ID: "inference-key-preview-1",
    EGMA_GATEWAY_DEEPGRAM_KEY: EGMA_PROVIDER_KEY.deepgram,
    EGMA_GATEWAY_OPENAI_KEY: EGMA_PROVIDER_KEY.openai,
    EGMA_GATEWAY_CARTESIA_KEY: EGMA_PROVIDER_KEY.cartesia,
    EGMA_GATEWAY_MAX_BUFFERED_BYTES: String(BOUND),
    // Ten minutes. If the exchange ends inside this test, the drain window is
    // not what ended it.
    EGMA_GATEWAY_BUFFER_DRAIN_MS: "600000",
    ...extra,
  });
}

/** One end of a socket, as a host offers it. */
type Peer = Duplex & {
  /** Everything it was ever asked to close with. */
  readonly closes: { code: number | undefined; reason: string | undefined }[];
  /** The most it was ever holding at once. */
  peak: number;
  /** Hand a frame to whoever is listening on this end. */
  deliver(frame: Frame): void;
  /** Let some of what it is holding go, as a peer catching up would. */
  drain(bytes: number): void;
  readonly paused: () => boolean;
};

/**
 * A peer that takes frames and never finishes with them.
 *
 * `withFlowControl` is what tells the two hosts apart, and it is the only
 * difference between them: with it, the relay can stop the frames arriving;
 * without it — the deployed host — frames keep coming whatever the relay wants.
 */
function stalledPeer({ withFlowControl }: { withFlowControl: boolean }): Peer {
  let buffered = 0;
  let paused = false;
  let listener: ((frame: Frame) => void) | undefined;
  const closes: { code: number | undefined; reason: string | undefined }[] = [];

  const peer: Peer = {
    send(frame: Frame) {
      buffered += frame instanceof ArrayBuffer ? frame.byteLength : frame.length;
      peer.peak = Math.max(peer.peak, buffered);
    },
    close(code, reason) {
      closes.push({ code, reason });
    },
    onMessage(handler) {
      listener = handler;
    },
    onClose() {},
    onError() {},
    bufferedBytes: () => buffered,
    ...(withFlowControl
      ? {
          pauseReading: () => {
            paused = true;
          },
          resumeReading: () => {
            paused = false;
          },
        }
      : {}),
    closes,
    peak: 0,
    deliver(frame: Frame) {
      // A host that has been asked to stop reading stops delivering. A host
      // that cannot be asked keeps going, which is the case under test.
      if (withFlowControl && paused) return;
      listener?.(frame);
    },
    drain(bytes: number) {
      buffered = Math.max(0, buffered - bytes);
    },
    paused: () => paused,
  };
  return peer;
}

function hostOf(caller: Peer, provider: Peer): SocketHost {
  return {
    connectUpstream: async () => ({
      socket: provider,
      protocol: null,
      headers: new Headers(),
    }),
    acceptClient: () => ({
      socket: caller,
      response: new Response(null, { status: 200 }),
    }),
  };
}

function anUpgrade(): Request {
  return new Request("https://gateway.example/deepgram/v1/listen?model=nova-3-general", {
    headers: { upgrade: "websocket" },
  });
}

describe("a sender at line rate into a provider that has stopped listening", () => {
  it("is bounded absolutely on a host that cannot stop reading, and is told so", async () => {
    const caller = stalledPeer({ withFlowControl: false });
    const provider = stalledPeer({ withFlowControl: false });
    const relay = await relaySocket(
      hostOf(caller, provider),
      anUpgrade(),
      ROUTE,
      configuration(),
    );

    // Ten megabytes offered as fast as the loop will carry them, which is what
    // an audio leg with nothing throttling it looks like. Delivery continues
    // regardless of anything the relay asks for, exactly as the deployed
    // runtime's does.
    const frame = new ArrayBuffer(FRAME);
    for (let index = 0; index < 1280; index += 1) caller.deliver(frame);

    const outcome = await relay.finished;

    // The invariant: never more than the ceiling plus the one frame that
    // carried it over. Before this fix the provider's buffer held all ten
    // megabytes.
    expect(provider.peak).toBeLessThanOrEqual(CEILING + FRAME);
    expect(provider.peak).toBeGreaterThan(BOUND);

    // Loudly, and with the code and the class that say what happened.
    expect(caller.closes.at(-1)?.code).toBe(1013);
    expect(provider.closes.at(-1)?.code).toBe(1013);
    expect(outcome.statusClass).toBe("refused");
  });

  it("counts only what it really handed over, so nothing is dropped silently", async () => {
    const caller = stalledPeer({ withFlowControl: false });
    const provider = stalledPeer({ withFlowControl: false });
    const relay = await relaySocket(
      hostOf(caller, provider),
      anUpgrade(),
      ROUTE,
      configuration(),
    );

    const frame = new ArrayBuffer(FRAME);
    for (let index = 0; index < 1280; index += 1) caller.deliver(frame);
    const outcome = await relay.finished;

    // Every byte on the record is a byte that crossed. The frames after the
    // ceiling were never counted and never sent — the exchange ended instead,
    // which is the difference between a bound and a silent drop.
    expect(outcome.bytesToProvider).toBe(provider.peak);
  });

  it("is waited for rather than hung up on where the host can stop reading", async () => {
    const caller = stalledPeer({ withFlowControl: true });
    const provider = stalledPeer({ withFlowControl: true });
    const relay = await relaySocket(
      hostOf(caller, provider),
      anUpgrade(),
      ROUTE,
      configuration(),
    );

    const frame = new ArrayBuffer(FRAME);
    for (let index = 0; index < 1280; index += 1) caller.deliver(frame);

    // The read stopped at the soft bound, so the ceiling was never approached
    // and nothing was closed: a provider that hesitated is being waited for.
    expect(caller.paused()).toBe(true);
    expect(provider.peak).toBeLessThanOrEqual(BOUND + FRAME);
    expect(caller.closes).toHaveLength(0);

    // And when it catches up the exchange carries on, having lost nothing.
    provider.drain(provider.peak);
    await new Promise((wait) => setTimeout(wait, 60));
    expect(caller.paused()).toBe(false);
    expect(caller.closes).toHaveLength(0);

    caller.close(1000, "done");
    void relay;
  });
});
