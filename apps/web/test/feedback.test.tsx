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
});

describe("shared feedback", () => {
  /**
   * **Keyboard focus shows it at once, and nothing moves.**
   *
   * Radix says how a tooltip opened, and `instant-open` is the answer for
   * keyboard focus. The component reads that word to decide whether anything
   * animates, so this is the assertion that keeps a Tab step from growing a
   * movement — `DESIGN.md`: "Do not animate actions used many times each day,
   * especially keyboard navigation."
   */
  it("shows a keyboard tooltip at once and closes it at once with Escape", () => {
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
   * **A pointer waits before the first one, then it arrives by moving.**
   *
   * The delay is what stops a tooltip flashing at every control a pointer
   * crosses on its way somewhere else.
   *
   * The exit is a class assertion, for the reason the error test below writes
   * down: jsdom loads no stylesheet, so a real exit cannot run here and the
   * mapping is what is guarded. Both halves matter. `data-input="pointer"` is
   * what scopes the exit animation, and an animation is what Radix waits for
   * before it unmounts — so a keyboard close leaves at once and a pointer
   * close runs to completion, which is what `DESIGN.md` asks of an exit.
   */
  it("delays the first pointer tooltip and gives it an exit to run", () => {
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
    expect(tooltip.className).toContain(
      "data-[state=delayed-open]:animate-[egma-anchored-in_var(--duration-popover-in)_var(--ease-out)]",
    );
    expect(tooltip.className).toContain(
      "data-[input=pointer]:data-[state=closed]:animate-[egma-anchored-out_var(--duration-popover-out)_var(--ease-out)]",
    );
    // The reduced-motion form is not optional, so it is asked for here too.
    expect(tooltip.className).toContain(
      "motion-reduce:data-[state=delayed-open]:animate-[egma-fade-in_var(--duration-hover)_linear]",
    );

    fireEvent.pointerLeave(trigger);
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
