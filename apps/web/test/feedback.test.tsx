// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Button } from "@/components/ui/button";
import { Notice } from "../app/ui.tsx";
import { Toast, Tooltip, type FeedbackInput } from "../ui/feedback.tsx";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/**
 * Supply live computed animation names for tooltip open/closed states.
 * Radix rereads the declaration after state changes, so a snapshot is insufficient.
 * This tests exit presence, not whether the stylesheet defines the animation.
 */
function teachJsdomTheTooltipMotion() {
  const real = window.getComputedStyle.bind(window);

  const animationOf = (element: Element) => {
    if (!(element instanceof HTMLElement)) return "none";
    if (element.dataset.slot !== "tooltip-content") return "none";
    if (element.dataset.state === "delayed-open") return "egma-anchored-in";
    if (element.dataset.state === "closed" && element.dataset.input === "pointer") {
      return "egma-anchored-out";
    }
    return "none";
  };

  vi.spyOn(window, "getComputedStyle").mockImplementation(
    ((element: Element, pseudo?: string | null) =>
      new Proxy(real(element, pseudo ?? undefined), {
        get(target, key) {
          if (key === "animationName") return animationOf(element);
          const held = Reflect.get(target, key, target) as unknown;
          return typeof held === "function" ? held.bind(target) : held;
        },
      })) as typeof window.getComputedStyle,
  );
}

/**
 * The end of one named animation, as a browser reports it.
 *
 * `fireEvent.animationEnd` cannot carry the name: jsdom's `AnimationEvent`
 * drops `animationName` from its init, and Radix checks that name before it
 * accepts the end of an animation as the end of *its* animation. Without it
 * the panel is told a different animation finished and stays where it is.
 */
function endAnimation(element: Element, animationName: string) {
  const ended = new Event("animationend", { bubbles: false });
  Object.defineProperty(ended, "animationName", { value: animationName });
  fireEvent(element, ended);
}

describe("shared feedback", () => {
  /**
   * **Keyboard focus shows it at once, and it leaves at once too.**
   *
   * The motion stub is installed here on purpose. It is the same one that
   * keeps the pointer exit below alive, so this test says the keyboard close
   * is immediate *because there is no exit animation for it* rather than
   * because jsdom happens to run none — `DESIGN.md`: "Do not animate actions
   * used many times each day, especially keyboard navigation."
   */
  it("shows a keyboard tooltip at once and closes it at once with Escape", () => {
    teachJsdomTheTooltipMotion();
    render(
      <Tooltip label="Copy the project identifier">
        <button type="button">Copy identifier</button>
      </Tooltip>,
    );

    const trigger = screen.getByRole("button", { name: "Copy identifier" });
    fireEvent.focus(trigger);

    const tooltip = screen.getByRole("tooltip");
    expect(tooltip.getAttribute("data-input")).toBe("keyboard");
    expect(tooltip.getAttribute("data-state")).toBe("instant-open");
    expect(trigger.getAttribute("aria-describedby")).toBe(tooltip.id);

    fireEvent.keyDown(trigger, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  /**
   * Check the pointer delay and keep the tooltip mounted until the simulated
   * exit event. Computed styles are supplied by the test.
   */
  it("delays the first pointer tooltip and lets its exit finish before it goes", () => {
    teachJsdomTheTooltipMotion();
    vi.useFakeTimers();
    render(
      <Tooltip label="Copy the project identifier">
        <button type="button">Copy identifier</button>
      </Tooltip>,
    );

    const trigger = screen.getByRole("button", { name: "Copy identifier" });
    fireEvent.pointerMove(trigger, { pointerType: "mouse" });
    expect(screen.queryByRole("tooltip")).toBeNull();

    act(() => vi.advanceTimersByTime(500));
    const tooltip = screen.getByRole("tooltip");
    expect(tooltip.getAttribute("data-input")).toBe("pointer");
    expect(tooltip.getAttribute("data-state")).toBe("delayed-open");

    fireEvent.pointerLeave(trigger);

    // Closed, and still on the page: the exit is what it is waiting for.
    expect(screen.getByRole("tooltip")).toBe(tooltip);
    expect(tooltip.getAttribute("data-state")).toBe("closed");

    endAnimation(tooltip, "egma-anchored-out");
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("keeps a pointer toast present until its interruptible exit finishes", () => {
    function Example() {
      const [open, setOpen] = useState(true);
      const [input, setInput] = useState<FeedbackInput>("pointer");
      return (
        <Toast
          open={open}
          input={input}
          title="Agent saved"
          onDismiss={(next) => {
            setInput(next);
            setOpen(false);
          }}
        >
          Support is ready.
        </Toast>
      );
    }

    render(<Example />);
    const toast = screen.getByRole("status");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss Agent saved" }), {
      detail: 1,
    });

    expect(screen.getByRole("status")).toBe(toast);
    expect(toast.getAttribute("data-closing")).toBe("true");
    fireEvent.transitionEnd(toast, { propertyName: "opacity" });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("makes keyboard toast dismissal immediate", () => {
    function Example() {
      const [open, setOpen] = useState(true);
      return (
        <Toast open={open} title="Agent saved" onDismiss={() => setOpen(false)} />
      );
    }

    render(<Example />);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss Agent saved" }));
    expect(screen.queryByRole("status")).toBeNull();
  });

  /**
   * Check that error surfaces request failure styling instead of brand styling.
   * These class assertions do not verify computed colors.
   */
  it("draws an error edge in the failure colour and never in the brand one", () => {
    const { unmount } = render(<Notice tone="error">Egma could not sign you in.</Notice>);
    const notice = screen.getByRole("alert");
    expect(notice.dataset.slot).toBe("notice");
    expect(notice.className).toContain("border-l-failure");
    expect(notice.className).not.toContain("border-l-brand");
    unmount();

    render(
      <Toast open kind="error" title="Could not save" onDismiss={() => undefined}>
        Try again.
      </Toast>,
    );
    const toast = screen.getByRole("alert");
    expect(toast.dataset.slot).toBe("toast");
    expect(toast.className).toContain("data-[kind=error]:border-l-failure");
    expect(toast.className).not.toContain("border-l-brand");

    /*
     * The mark inside it carries the same state, and the same rule — and it
     * carries it as a shape first. A crossed octagon against a ticked circle
     * reads as two different things with no colour at all, which is what
     * "state is not communicated by color alone" asks for.
     */
    const mark = toast.querySelector("[data-slot=toast-mark]");
    expect(mark?.getAttribute("class")).toContain("lucide-octagon-x");
    expect(mark?.getAttribute("class")).toContain("text-failure");
    expect(mark?.getAttribute("class")).not.toContain("text-brand");
  });

  /** The neutral form of the same mark, so the two are told apart by shape. */
  it("marks a status toast with a different shape from an error one", () => {
    render(
      <Toast open title="Agent saved" onDismiss={() => undefined}>
        Support is ready.
      </Toast>,
    );

    const mark = screen.getByRole("status").querySelector("[data-slot=toast-mark]");
    expect(mark?.getAttribute("class")).toContain("lucide-circle-check");
    expect(mark?.getAttribute("class")).not.toContain("text-failure");
  });

  it("names a busy button and makes it inert", () => {
    render(
      <Button type="button" busy>
        Saving agent…
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Saving agent…" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.getAttribute("aria-busy")).toBe("true");
  });
});
