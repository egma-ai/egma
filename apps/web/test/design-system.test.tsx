// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DesignSystemProof } from "../app/design-system/proof.tsx";

vi.mock("next/navigation", () => ({
  usePathname: () => "/projects/prj_proof/design-system",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}));

beforeEach(() => {
  vi.stubGlobal("scrollTo", vi.fn());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the development design proof", () => {
  it("renders the shared product states together", () => {
    render(<DesignSystemProof />);

    expect(screen.getByRole("heading", { name: "Egma product system" })).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Product navigation" })).toBeTruthy();
    expect(screen.getAllByRole("navigation", { name: "Settings" })).toHaveLength(2);
    expect(screen.getByRole("table", { name: "Proof agents" })).toBeTruthy();
    expect(screen.getByText("Agent saved")).toBeTruthy();
    expect(screen.getByText("Loading agents…")).toBeTruthy();
    expect(screen.getByText("No agents yet")).toBeTruthy();
    expect(screen.getByText("human:")).toBeTruthy();
    expect(screen.getByText("agent:")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Narrow 360 pixel component preview" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Reduced motion component preview" })).toBeTruthy();
  });

  it("shows the shared form and feedback edge states", () => {
    render(<DesignSystemProof />);

    const busy = screen.getByRole("button", { name: "Saving agent…" });
    expect((busy as HTMLButtonElement).disabled).toBe(true);
    expect(busy.getAttribute("aria-busy")).toBe("true");

    const numeric = screen.getByRole("spinbutton", { name: "Max concurrency" });
    expect((numeric as HTMLInputElement).value).toBe("2");

    const checkbox = screen.getByRole("checkbox", {
      name: "Include archived tests in this run",
    });
    fireEvent.click(checkbox);
    expect((checkbox as HTMLInputElement).checked).toBe(true);

    const tooltipTrigger = screen.getByRole("button", { name: "Copy identifier" });
    fireEvent.focus(tooltipTrigger);
    expect(screen.getByRole("tooltip").textContent).toContain("project identifier");

    fireEvent.click(screen.getByRole("button", { name: "Dismiss Agent saved" }));
    expect(screen.queryByText("Agent saved")).toBeNull();
  });

  /**
   * The numeric field's three shapes, on the one surface that draws them.
   *
   * The control exists because a bound and a unit belong on the field rather
   * than in a sentence beside it, and the unit-less shape is the one the grader
   * threshold uses — so a proof holding only the percentage would leave the
   * layout that ships unproven. All three are asserted through what a reader is
   * actually given: the described words, and the keypad the field asks for.
   */
  it("proves the numeric field with a unit, with a decimal step, and with neither", () => {
    render(<DesignSystemProof />);

    /** What the field is described by, resolved to the words a reader gets. */
    const describedWords = (field: HTMLElement): string =>
      (field.getAttribute("aria-describedby") ?? "")
        .split(" ")
        .filter((one) => one !== "")
        .map((one) => document.getElementById(one)?.textContent ?? "")
        .join(" ");

    const percent = screen.getByRole("spinbutton", {
      name: "Share of live traffic judged",
    });
    expect((percent as HTMLInputElement).value).toBe("20");
    expect(percent.getAttribute("min")).toBe("0");
    expect(percent.getAttribute("max")).toBe("100");
    expect(percent.getAttribute("inputmode")).toBe("numeric");
    expect(describedWords(percent)).toContain("%");

    const seconds = screen.getByRole("spinbutton", { name: "Answer within" });
    // A step that is not whole needs the separator, so the phone keypad has to
    // be the one that has it.
    expect(seconds.getAttribute("step")).toBe("0.1");
    expect(seconds.getAttribute("inputmode")).toBe("decimal");
    expect(describedWords(seconds)).toContain("seconds");

    const count = screen.getByRole("spinbutton", {
      name: "Turns before the caller gives up",
    });
    expect(count.getAttribute("inputmode")).toBe("numeric");
    expect(describedWords(count)).toContain("a count and nothing else");
    // No unit at all, rather than an empty one: the words a reader is given
    // must not gain a stray separator where a unit would have been.
    expect(describedWords(count)).not.toContain("%");

    fireEvent.change(percent, { target: { value: "35" } });
    expect((percent as HTMLInputElement).value).toBe("35");
  });

  it("draws the shadcn base wearing egma's theme", () => {
    render(<DesignSystemProof />);

    /*
     * These are class assertions rather than colour assertions because jsdom
     * loads no stylesheet. What they guard is the mapping: the primary action
     * asks for the theme's `primary`, and `tailwind-theme.css` is what makes
     * `primary` mean Deep Ember. The colours themselves are proved in a real
     * browser, by reading the computed value back off the element.
     */
    const start = screen.getByRole("button", { name: "Start run" });
    expect(start.getAttribute("data-slot")).toBe("button");
    expect(start.className).toContain("bg-primary");
    expect(start.className).toContain("rounded-button");

    /* The secondary action is the outlined kind, never a filled grey one. */
    const secondary = screen.getByRole("button", { name: "Add grader" });
    expect(secondary.className).toContain("border-border-strong");
    expect(secondary.className).toContain("bg-transparent");

    /*
     * A chip says a verdict in a word and wears the state colour. It must not
     * wear the brand colour: "Brand orange does not mean passed, failed,
     * skipped, or errored."
     */
    const chips = screen
      .getAllByText("Passed")
      .filter((node) => node.getAttribute("data-slot") === "badge");
    /*
     * Two of them and one component: the chip block on the base panel, and the
     * same chip beside a verdict in the project-context panel. That second one
     * was the CSS Modules chip until the mop-up, so every match is read rather
     * than only the first.
     */
    expect(chips).toHaveLength(2);
    for (const chip of chips) {
      expect(chip.className).toContain("border-success-border");
      expect(chip.className).not.toContain("brand");
      expect(chip.className).not.toContain("primary");
    }
  });

  it("opens the base dialog on the slot its motion is keyed to", () => {
    render(<DesignSystemProof />);

    fireEvent.click(screen.getByRole("button", { name: "Delete grader" }));

    const dialog = screen.getByRole("dialog", {
      name: "Delete the Refund policy grader?",
    });
    /*
     * Not decoration. `tailwind-theme.css` keys the dialog's entrance and exit
     * on this attribute, so a rename here would take the motion with it and
     * nothing else would say so.
     */
    expect(dialog.getAttribute("data-slot")).toBe("dialog-content");
    expect(
      within(dialog).getByText(/Runs that already used it keep their verdicts/),
    ).toBeTruthy();

    fireEvent.click(within(dialog).getByRole("button", { name: "Keep it" }));
    expect(
      screen.queryByRole("dialog", {
        name: "Delete the Refund policy grader?",
      }),
    ).toBeNull();
  });

  it("keeps the real centered confirmation dialog through a pointer exit", () => {
    render(<DesignSystemProof />);

    fireEvent.click(screen.getAllByRole("button", { name: "Register agent" })[0]!);
    const dialog = screen.getByRole("dialog", { name: "Archive Support agent?" });
    expect(dialog).toBeTruthy();
    /*
     * The confirmation inside the dialog is the shared button, and it is the
     * destructive one. Two assertions because they guard two different things:
     * `data-slot` says the element is the base component at all, and the class
     * says which variant was asked for. The line these replace named a CSS
     * Modules class, `buttonDestructive`, which did both at once and is gone.
     *
     * The variant is worth naming rather than dropping: `DESIGN.md` says a
     * destructive action uses the failure colour, and that brand orange never
     * means errored. A confirmation that quietly came out Deep Ember would
     * pass a check for "is a button".
     */
    const confirm = within(dialog).getByRole("button", {
      name: "Archive agent",
    });
    expect(confirm.getAttribute("data-slot")).toBe("button");
    expect(confirm.className).toContain("bg-destructive");
    expect(confirm.className).not.toContain("bg-primary");

    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }), { detail: 1 });
    expect(screen.getByRole("dialog", { name: "Archive Support agent?" })).toBe(dialog);
    expect(dialog.getAttribute("data-closing")).toBe("true");

    const panel = dialog.firstElementChild as HTMLElement;
    fireEvent.transitionEnd(panel, { propertyName: "opacity" });
    expect(screen.queryByRole("dialog", { name: "Archive Support agent?" })).toBeNull();
  });
});
