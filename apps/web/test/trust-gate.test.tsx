// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TrustGate } from "../app/trust-gate.tsx";

/**
 * The brand field on the auth pages, under reduced motion.
 *
 * `auth-controls.test.tsx` mocks this component away, which is right for a test
 * about sign-in controls and is also why the defect below survived: nothing
 * mounted the real one.
 *
 * Under reduced motion the canvas loop draws a single frame and stops, which is
 * the whole point of it. Two things afterwards invalidate what is on the canvas,
 * and neither used to repaint it:
 *
 * - **A resize clears the canvas.** Assigning `canvas.width` is defined to reset
 *   the drawing surface, so the field went blank and stayed blank until a
 *   reload.
 * - **A theme change re-reads the ink** and left the old colour standing.
 *
 * Both were invisible in normal motion, where the next animation frame covered
 * them a moment later — so both need a test that pins the reduced-motion path
 * specifically.
 */

/** Every 2D call this component makes, with a count of the frames drawn. */
function fakeContext() {
  return {
    frames: 0,
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 0,
    globalAlpha: 1,
    /* `draw` opens with this, so counting it counts frames. */
    clearRect() {
      this.frames += 1;
    },
    setTransform() {},
    beginPath() {},
    arc() {},
    stroke() {},
    fill() {},
    moveTo() {},
    lineTo() {},
  };
}

type Captured = {
  context: ReturnType<typeof fakeContext>;
  resize: () => void;
  theme: () => void;
};

function mountReducedMotion(): Captured {
  const context = fakeContext();
  const captured: { resize?: () => void; theme?: () => void } = {};

  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    context as unknown as CanvasRenderingContext2D,
  );
  /* A real size, so the component builds a real field of dots. */
  vi.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect").mockReturnValue({
    width: 800,
    height: 400,
    top: 0,
    left: 0,
    right: 800,
    bottom: 400,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });

  vi.stubGlobal(
    "matchMedia",
    /* The preference under test. Everything here hangs off it. */
    () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
  );
  vi.stubGlobal("devicePixelRatio", 1);
  /*
   * Synchronous, so the one frame the component asks for at mount has been
   * drawn by the time `render` returns. Under reduced motion `draw` never asks
   * for another, so this cannot recurse.
   */
  vi.stubGlobal("requestAnimationFrame", (run: (time: number) => void) => {
    run(0);
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", () => undefined);

  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        captured.resize = callback;
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    "MutationObserver",
    class {
      constructor(callback: () => void) {
        captured.theme = callback;
      }
      observe() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    },
  );

  render(<TrustGate />);

  if (captured.resize === undefined || captured.theme === undefined) {
    throw new Error("TrustGate did not observe size or theme");
  }
  return { context, resize: captured.resize, theme: captured.theme };
}

beforeEach(() => {
  vi.stubGlobal("scrollTo", vi.fn());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the trust field under reduced motion", () => {
  it("draws its one frame and then stops", () => {
    const { context } = mountReducedMotion();

    /*
     * More than none, because a reduced-motion field is still a field. The
     * exact count is not asserted: `resize` paints as well as the first frame,
     * and pinning the number would make this a test about call order.
     */
    expect(context.frames).toBeGreaterThan(0);
  });

  /**
   * The regression: `still()` dropped from `resize`.
   *
   * Setting `canvas.width` in `resize` wipes the surface. With no repaint after
   * it, the reduced-motion field is gone until the page is loaded again.
   */
  it("repaints after a resize, because the resize cleared the canvas", () => {
    const { context, resize } = mountReducedMotion();
    const before = context.frames;

    resize();

    expect(context.frames).toBeGreaterThan(before);
  });

  /**
   * The regression: `still()` dropped from the theme observer.
   *
   * The observer re-reads the ink off the element. Without a repaint the new
   * colour is held and never used, so the field stays in the old theme's ink.
   */
  it("repaints after the theme changes, so the new ink is actually used", () => {
    const { context, theme } = mountReducedMotion();
    const before = context.frames;

    theme();

    expect(context.frames).toBeGreaterThan(before);
  });
});
