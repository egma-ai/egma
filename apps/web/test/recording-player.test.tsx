// @vitest-environment jsdom
import { cleanup, render, waitFor } from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RecordingPlayer } from "../app/recording-player.tsx";

/**
 * Putting the listener back where they were, when a link is replaced.
 *
 * **The one behaviour here that is pure event ordering**, and the only seam it
 * had was a sixty-five-test browser lane — which is where it went red, once, on
 * a machine slightly faster than the one it was written on.
 *
 * A media element replays its whole loading sequence every time it is given a
 * source, and this component gives it one twice on purpose: React writes the
 * new `src`, and then an effect says `load()` out loud because a link asked for
 * again inside the same second comes back byte for byte identical and a `src`
 * that did not change loads nothing. **Both of those can produce their own
 * `loadedmetadata`**, and whether they do is a question about how fast the
 * store answered — which is to say, a question with no fixed answer.
 *
 * So what is driven here is the sequence itself, deterministically: the error,
 * the replacement, and then metadata arriving twice. The position has to
 * survive all of it. jsdom implements none of a media element's behaviour,
 * which is exactly what makes it the right place to ask — nothing here is
 * waiting on a real decoder, and every event lands where this test puts it.
 */

const A_LINK = "https://store.example/one.wav?signature=first";
const A_SECOND_LINK = "https://store.example/one.wav?signature=second";
const A_THIRD_LINK = "https://store.example/one.wav?signature=third";

const WORDS = {
  label: "Recording",
  caption: "Both channels of the conversation.",
  fallback: "Your browser cannot play this.",
  unplayable: "This recording stopped working.",
  unreachable: "Egma could not be asked for this recording.",
  refused: (status: number) => `Egma refused this recording (${status}).`,
};

/** What the page asks Egma for, answered without a network. */
function answering(...links: readonly string[]): ReturnType<typeof vi.fn> {
  let asked = 0;
  return vi.fn(async () => {
    const url = links[Math.min(asked, links.length - 1)] as string;
    asked += 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({ url }),
    } as unknown as Response;
  });
}

/**
 * The element, with the two members jsdom leaves out.
 *
 * `currentTime` is a real, settable number here rather than the always-zero
 * jsdom offers, and `load()` does what a media element's `load()` does to the
 * thing this test is about: it sends the position back to the beginning. Both
 * are the platform's behaviour, written down, because the bug lives in the
 * order they happen in and not in either of them.
 */
function playableElement(audio: HTMLAudioElement): { loads: () => number } {
  let position = 0;
  let loads = 0;
  Object.defineProperty(audio, "currentTime", {
    configurable: true,
    get: () => position,
    set: (to: number) => {
      position = to;
    },
  });
  Object.defineProperty(audio, "load", {
    configurable: true,
    value: () => {
      loads += 1;
      position = 0;
    },
  });
  return { loads: () => loads };
}

/**
 * React's own flag for "events dispatched here are being driven deliberately".
 *
 * Set because this file drives media events by hand, which is the whole point
 * of it — the neighbouring component tests let Testing Library's own `render`
 * do their acting and never need it.
 */
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const theElement = (): HTMLAudioElement => {
  const audio = document.querySelector("audio[data-recording]");
  if (audio === null) throw new Error("no player is on screen");
  return audio as HTMLAudioElement;
};

beforeEach(() => {
  vi.stubGlobal("fetch", answering(A_LINK, A_SECOND_LINK));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("a recording whose link stopped working part-way through", () => {
  it("puts the listener back where they were, however many times metadata arrives", async () => {
    render(
      <RecordingPlayer
        simulationId="sim_1"
        words={WORDS}
        knownToExist
        project="prj_1"
      />,
    );

    await waitFor(() => expect(theElement().getAttribute("src")).toBe(A_LINK));
    const audio = theElement();
    const element = playableElement(audio);

    // The first link works, and the listener gets three quarters of a second in.
    act(() => {
      audio.dispatchEvent(new Event("loadedmetadata"));
    });
    audio.currentTime = 0.75;

    // And then the store refuses, which is what an expired link looks like to
    // this element: an `error`, with nothing on it saying why.
    act(() => {
      audio.dispatchEvent(new Event("error"));
    });

    // A second link is asked for and takes its place.
    await waitFor(() =>
      expect(theElement().getAttribute("src")).toBe(A_SECOND_LINK),
    );
    await waitFor(() => expect(element.loads()).toBeGreaterThan(0));

    /**
     * **Metadata twice, which is the whole of this test.**
     *
     * The new `src` starts one load and the effect's `load()` starts another.
     * On a slow store only the second finishes; on a fast one both do, and the
     * position has to survive that — a restore consumed by the first arrival
     * and then wiped by the second `load()` leaves a listener at zero with a
     * player that looks perfectly healthy, which is precisely the failure a
     * timing-dependent lane reports as a flake.
     */
    act(() => {
      theElement().dispatchEvent(new Event("loadedmetadata"));
    });
    act(() => {
      (theElement() as HTMLAudioElement).load();
      theElement().dispatchEvent(new Event("loadedmetadata"));
    });

    expect(theElement().getAttribute("src")).toBe(A_SECOND_LINK);
    expect((theElement() as HTMLAudioElement).currentTime).toBeCloseTo(0.75, 5);
  });

  it("puts them back when metadata arrives only once, which is the ordinary case", async () => {
    render(
      <RecordingPlayer
        simulationId="sim_1"
        words={WORDS}
        knownToExist
        project="prj_1"
      />,
    );

    await waitFor(() => expect(theElement().getAttribute("src")).toBe(A_LINK));
    const audio = theElement();
    playableElement(audio);

    act(() => {
      audio.dispatchEvent(new Event("loadedmetadata"));
    });
    audio.currentTime = 0.75;
    act(() => {
      audio.dispatchEvent(new Event("error"));
    });

    await waitFor(() =>
      expect(theElement().getAttribute("src")).toBe(A_SECOND_LINK),
    );
    act(() => {
      theElement().dispatchEvent(new Event("loadedmetadata"));
    });

    expect((theElement() as HTMLAudioElement).currentTime).toBeCloseTo(0.75, 5);
  });

  it("resumes a second expiry from where the listener is then, not from where they were", async () => {
    /**
     * The other half of the rule, and why the remembered place is not simply
     * kept forever as a constant.
     *
     * A link that loads is a link that works, so an expiry hours later is its
     * own retry rather than the second failure of a problem long since over —
     * and it resumes from wherever the listener has got to by then. What
     * replaces the remembered place is the next expiry, and nothing else needs
     * to forget it: dragging the scrubber is a seek, and a seek loads no
     * metadata, so a listener cannot be dragged forward by their own scrubbing.
     */
    vi.stubGlobal("fetch", answering(A_LINK, A_SECOND_LINK, A_THIRD_LINK));
    render(
      <RecordingPlayer
        simulationId="sim_1"
        words={WORDS}
        knownToExist
        project="prj_1"
      />,
    );

    await waitFor(() => expect(theElement().getAttribute("src")).toBe(A_LINK));
    const audio = theElement();
    playableElement(audio);

    act(() => {
      audio.dispatchEvent(new Event("loadedmetadata"));
    });
    audio.currentTime = 0.75;
    act(() => {
      audio.dispatchEvent(new Event("error"));
    });
    await waitFor(() =>
      expect(theElement().getAttribute("src")).toBe(A_SECOND_LINK),
    );
    act(() => {
      theElement().dispatchEvent(new Event("loadedmetadata"));
    });
    expect((theElement() as HTMLAudioElement).currentTime).toBeCloseTo(0.75, 5);

    // They listen on, and much later the second link expires too.
    (theElement() as HTMLAudioElement).currentTime = 4.5;
    act(() => {
      theElement().dispatchEvent(new Event("error"));
    });
    await waitFor(() =>
      expect(theElement().getAttribute("src")).toBe(A_THIRD_LINK),
    );
    act(() => {
      theElement().dispatchEvent(new Event("loadedmetadata"));
    });

    expect((theElement() as HTMLAudioElement).currentTime).toBeCloseTo(4.5, 5);
  });
});
