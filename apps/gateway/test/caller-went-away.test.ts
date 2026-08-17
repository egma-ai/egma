import { afterEach, describe, expect, it } from "vitest";

import type { Verifier } from "../src/verify.ts";
import {
  eventually,
  GATEWAY_SECRET,
  INFERENCE_KEY_ID,
  openSocket,
  ORGANIZATION,
  records,
  standUp,
  watch,
  type Standing,
} from "./support/world.ts";

/**
 * The caller who was already gone before the relay was reached.
 *
 * **A listener added to a signal that has already aborted never fires.** That
 * one line of platform behaviour is the whole of what is held down here, and
 * getting it wrong costs real money: the abort is lost, the relay's own
 * controller stays live, and a request nobody is waiting for opens a real
 * connection to a real provider and holds it until a bound notices — ten
 * minutes later on the HTTP transport, two on a socket.
 *
 * **The window is authentication, and it is not theoretical.** A connection is
 * authenticated before either relay is reached, and for an inference key that
 * means one request to Egma Cloud every time one opens. A simulator whose run
 * was cancelled during that ask has already aborted by the time the relay
 * starts. So this file makes that window wide on purpose — a verifier that
 * takes its time — and hangs up inside it, which is the same race a slow
 * control plane produces on its own and the only way to drive it every time
 * rather than sometimes.
 *
 * The two transports promise different things and both are asserted:
 *
 * - **HTTP has nothing to race**, so the provider is never spoken to at all.
 * - **A socket has an upstream handshake to race**, so the provider may be
 *   spoken to and is then closed at once rather than left for the idle bound.
 *
 * Either way the record says `cancelled`, because that is what happened.
 */

let standing: Standing | undefined;

afterEach(async () => {
  await standing?.world.stop();
  standing = undefined;
});

/** How long authentication takes here. Long enough to hang up inside. */
const VERIFYING_MS = 1_500;

/** How long to wait before hanging up, well inside the window above. */
const BEFORE_HANGING_UP_MS = 150;

/**
 * A verifier that eventually says yes, slowly.
 *
 * Deliberately a real answer rather than a refusal: what is being proved is
 * that a caller who left is not charged for a provider request *they would
 * otherwise have been entitled to*. A verifier that refused would stop the
 * exchange for a different reason and prove nothing about this one.
 */
const SLOW_VERIFIER: Verifier = {
  verify: async () => {
    await new Promise((wait) => setTimeout(wait, VERIFYING_MS));
    return { organizationId: ORGANIZATION, inferenceKeyId: INFERENCE_KEY_ID };
  },
};

describe("a caller who hangs up while the gateway is still authenticating them", () => {
  it("costs the provider nothing at all on an HTTP route", async () => {
    standing = await standUp({ verifier: SLOW_VERIFIER });

    const giveUp = new AbortController();
    setTimeout(() => giveUp.abort(), BEFORE_HANGING_UP_MS);

    await expect(
      fetch(`${standing.world.origin}/openai/v1/chat/completions`, {
        method: "POST",
        headers: {
          "egma-inference-key": GATEWAY_SECRET,
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: "a-small-model", messages: [] }),
        signal: giveUp.signal,
      }),
    ).rejects.toThrow();

    /**
     * The assertion this file exists for. Not "the provider answered quickly"
     * and not "the exchange ended" — **the provider was never asked**. The
     * strict stand-in counts every connection it receives, so zero is a fact
     * about the wire rather than about timing.
     */
    const written = await eventually(() =>
      records(standing?.world as NonNullable<typeof standing>["world"]).find(
        (line) => line["statusClass"] === "cancelled",
      ),
    );
    expect(standing.openai.attempts()).toBe(0);

    // And the record is the honest one: nothing crossed, nothing came back,
    // and the exchange is filed as the cancellation it was.
    expect(written["provider"]).toBe("openai");
    expect(written["job"]).toBe("llm");
    expect(written["bytesFromProvider"]).toBe(0);
    expect(written["firstOutputMs"]).toBeUndefined();
  });

  it("settles well inside the bound it would otherwise have waited out", async () => {
    /**
     * The cost of getting this wrong, measured.
     *
     * Without the check, the fetch below opens a real provider connection and
     * the exchange is held until the whole-exchange bound — which a deployment
     * sets to ten minutes. Here that bound is four seconds, so a relay that
     * lost the abort would still be holding the exchange when this assertion
     * runs, and the record it eventually wrote would say `timed-out`.
     */
    standing = await standUp({
      verifier: SLOW_VERIFIER,
      settings: {
        EGMA_GATEWAY_EXCHANGE_TIMEOUT_MS: "4000",
        EGMA_GATEWAY_FIRST_OUTPUT_TIMEOUT_MS: "4000",
      },
    });

    const giveUp = new AbortController();
    setTimeout(() => giveUp.abort(), BEFORE_HANGING_UP_MS);
    const began = Date.now();

    await expect(
      fetch(`${standing.world.origin}/openai/v1/chat/completions`, {
        method: "POST",
        headers: {
          "egma-inference-key": GATEWAY_SECRET,
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: "a-small-model", messages: [] }),
        signal: giveUp.signal,
      }),
    ).rejects.toThrow();

    const written = await eventually(() =>
      records(standing?.world as NonNullable<typeof standing>["world"]).find(
        (line) => line["statusClass"] === "cancelled",
      ),
    );
    // Settled once authentication finished, and not one bound later.
    expect(Date.now() - began).toBeLessThan(VERIFYING_MS + 1_500);
    expect(written["statusClass"]).toBe("cancelled");
  });

  it("closes the provider's socket at once on a socket route, rather than leaving it", async () => {
    /**
     * The socket transport's own promise, which is weaker than the HTTP one and
     * honestly so: the provider's handshake is the thing being raced, so it may
     * already be in flight. What must not happen is the socket being left open
     * and paid for until the idle bound — two minutes of a provider connection
     * for a simulation that ended.
     */
    standing = await standUp({ verifier: SLOW_VERIFIER });

    const socket = openSocket(standing.world, "/deepgram/v1/listen?model=nova-3-general", {
      headers: { "egma-inference-key": GATEWAY_SECRET },
    });
    const seen = watch(socket);
    setTimeout(() => socket.terminate(), BEFORE_HANGING_UP_MS);
    await expect(seen.opened).rejects.toThrow();

    const written = await eventually(
      () =>
        records(standing?.world as NonNullable<typeof standing>["world"]).find(
          (line) => line["statusClass"] === "cancelled",
        ),
      10_000,
    );
    expect(written["provider"]).toBe("deepgram");
    expect(written["job"]).toBe("stt");

    // Whatever the provider's handshake did, nothing is left holding it: either
    // it was never reached, or it was reached and closed straight away.
    const provider = standing.deepgram.seen.at(-1);
    if (provider !== undefined) {
      await eventually(() => provider.closedWith ?? (provider.socket?.readyState === 3 || undefined));
    }
  });
});
