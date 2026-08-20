// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Button } from "@/components/ui/button";
import { Toast, Tooltip, type FeedbackInput } from "../ui/feedback.tsx";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("shared feedback", () => {
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
    expect(trigger.getAttribute("aria-describedby")).toBe(tooltip.id);

    fireEvent.keyDown(trigger, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("delays the first pointer tooltip and keeps it present through its short exit", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-15T12:00:00.000Z"));
    render(
      <Tooltip label="Copy the project identifier">
        <button type="button">Copy identifier</button>
      </Tooltip>,
    );

    const trigger = screen.getByRole("button", { name: "Copy identifier" });
    fireEvent.pointerEnter(trigger);
    expect(screen.queryByRole("tooltip")).toBeNull();

    act(() => vi.advanceTimersByTime(500));
    const tooltip = screen.getByRole("tooltip");
    expect(tooltip.getAttribute("data-input")).toBe("pointer");

    fireEvent.pointerLeave(trigger);
    expect(screen.getByRole("tooltip").getAttribute("data-closing")).toBe("true");
    fireEvent.transitionEnd(tooltip, { propertyName: "opacity" });
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
