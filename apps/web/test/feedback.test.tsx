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
 * The one fact jsdom is missing, supplied so the exit can be driven.
 *
 * Radix keeps a closing panel mounted only while an exit animation is running,
 * and it decides that by reading `animation-name` off the element. jsdom loads
 * no stylesheet, so it answers "none" for everything and every exit is
 * instant — which would make an exit test pass no matter what the theme said.
 *
 * So this teaches `getComputedStyle` the two rules `tailwind-theme.css`
 * actually declares for `[data-slot="tooltip-content"]`, and nothing else. A
 * theme that stopped declaring them would not be caught here; what is caught
 * is the component half — that the panel carries the `data-state` and
 * `data-input` those rules are keyed on, and that Radix is left to wait for
 * the animation rather than being torn down under it.
 *
 * It is a live view rather than a snapshot because Radix reads the same
 * declaration object again later, after `data-state` has changed.
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
   * **A pointer waits before the first one, and its exit runs to completion.**
   *
   * The delay is what stops a tooltip flashing at every control a pointer
   * crosses on its way somewhere else.
   *
   * The exit is driven rather than described. `DESIGN.md`: "An exit runs to
   * completion and is never cut off. A surface that is closed finishes leaving
   * before it is removed." So the pointer leaves, the panel is still there,
   * and only the end of the animation removes it. Asserting the class that
   * asks for the animation would pass on a misspelled keyframe and on a panel
   * Radix tore down underneath it.
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
   * The one rule these two surfaces broke, held where it can fail.
   *
   * `DESIGN.md`: "Brand orange does not mean passed, failed, skipped, or
   * errored." Both of these once drew their error edge in Ember, and the edge
   * is the only thing separating either from its neutral form at a glance — so
   * it said "look here" where it had to say "this went wrong".
   *
   * These are class assertions rather than colour assertions because jsdom
   * loads no stylesheet, which is the reason `design-system.test.tsx` gives for
   * the same shape. What they guard is the mapping: the edge asks for the
   * theme's `failure`, and `tailwind-theme.css` is what makes `failure` mean
   * the failure colour. Asserting the absence of `brand` is the half that
   * matters most — a later wave flipping it back fails here rather than only
   * looking wrong in a screenshot nobody retakes.
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
