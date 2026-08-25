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
  /*
   * Radix measures a tooltip's arrow with `ResizeObserver`, which jsdom does
   * not implement, and it does the measuring only once the tooltip is open —
   * so this is needed by the one test that opens one rather than by the render.
   *
   * A stub rather than a polyfill: nothing here asserts a measurement, and a
   * real implementation would only add a way for these tests to depend on
   * layout jsdom does not compute.
   */
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
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
      name: "Share of production traces graded",
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
     * asks for the theme's `primary-wash` fill and `primary` ink, and
     * `tailwind-theme.css` is what makes those mean Ember Wash and Deep Ember.
     * The colours themselves are proved in a real browser, by reading the
     * computed value back off the element.
     *
     * **The primary is the wash button as of 2026-08-23.** It used to be a
     * Deep Ember block with white text; the developer retired that looking at
     * the Paper boards, so a filled fill here would be the old rule coming
     * back rather than a passing test.
     */
    const start = screen.getByRole("button", { name: "Start run" });
    expect(start.getAttribute("data-slot")).toBe("button");
    expect(start.className).toContain("bg-primary-wash");
    expect(start.className).toContain("text-primary");
    expect(start.className).not.toContain("text-primary-foreground");
    expect(start.className).toContain("rounded-button");

    /* The secondary action is the outlined kind, never a filled grey one. */
    const secondary = screen.getByRole("button", { name: "Add grader" });
    expect(secondary.className).toContain("border-border-strong");
    expect(secondary.className).toContain("bg-transparent");

    /*
     * A chip says a result in a word and wears the state colour. It must not
     * wear the brand colour: "Brand orange does not mean passed, failed,
     * skipped, or errored."
     */
    const chips = screen
      .getAllByText("Passed")
      .filter((node) => node.getAttribute("data-slot") === "badge");
    /*
     * Three of them and one component: the chip block on the base panel, the
     * same chip beside a result in the project-context panel, and the same
     * chip again inside the dark-theme frame. The second was the CSS Modules
     * chip until the mop-up and the third is what proves the component carries
     * both themes, so every match is read rather than only the first.
     */
    expect(chips).toHaveLength(3);
    for (const chip of chips) {
      expect(chip.className).toContain("border-success-border");
      expect(chip.className).not.toContain("brand");
      expect(chip.className).not.toContain("primary");
    }
  });

  /**
   * The side sheet: the surface the boards create, read and edit one record in.
   *
   * It is asserted on the slot its motion is keyed to, exactly as the dialog
   * below is, and on the three things a form panel has to have — a title, a
   * body to fill in, and a footer with the answer and the way out.
   */
  it("opens the side sheet on the slot its motion is keyed to", () => {
    render(<DesignSystemProof />);

    fireEvent.click(screen.getByRole("button", { name: "Open connection" }));

    const sheet = screen.getByRole("dialog", { name: "phone" });
    expect(sheet.getAttribute("data-slot")).toBe("sheet-content");
    expect(within(sheet).getByLabelText("Phone number")).toBeTruthy();
    expect(within(sheet).getByRole("button", { name: "Save connection" })).toBeTruthy();
    expect(within(sheet).getByRole("button", { name: "Delete" })).toBeTruthy();

    fireEvent.click(within(sheet).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog", { name: "phone" })).toBeNull();
  });

  /**
   * Both themes, on one page, at the same time.
   *
   * `DESIGN.md`: "Every shared component must support light and dark themes."
   * The frame carries `data-theme="dark"`, which is the attribute the theme
   * binds its dark values to, so what is inside it is drawn on the dark tokens
   * while the page around it stays light.
   */
  it("draws the shared components on the dark tokens beside the light ones", () => {
    render(<DesignSystemProof />);

    const dark = screen.getByRole("region", {
      name: "Dark theme component preview",
    });
    expect(dark.getAttribute("data-theme")).toBe("dark");
    expect(
      within(dark).getByRole("button", { name: "Connect an agent" }).className,
    ).toContain("bg-primary-wash");
    expect(
      within(dark).getByRole("table", { name: "Proof agents in dark theme" }),
    ).toBeTruthy();
  });

  it("opens the base dialog on the slot its motion is keyed to", () => {
    render(<DesignSystemProof />);

    fireEvent.click(screen.getByRole("button", { name: "Delete test suite" }));

    const dialog = screen.getByRole("dialog", {
      name: "Delete the Refund checks test suite?",
    });
    /*
     * Not decoration. `tailwind-theme.css` keys the dialog's entrance and exit
     * on this attribute, so a rename here would take the motion with it and
     * nothing else would say so.
     */
    expect(dialog.getAttribute("data-slot")).toBe("dialog-content");
    expect(
      within(dialog).getByText(/Existing runs keep their frozen test versions/),
    ).toBeTruthy();

    fireEvent.click(within(dialog).getByRole("button", { name: "Keep suite" }));
    expect(
      screen.queryByRole("dialog", {
        name: "Delete the Refund checks test suite?",
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

    /*
     * The exit itself is proven where the dialog lives, in
     * `components.test.tsx`: the panel is marked closed, stays on screen for
     * its animation, and is removed when the animation ends. Here the point is
     * only that the proof page's Cancel is wired to the same way out.
     */
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }), { detail: 1 });
    expect(screen.queryByRole("dialog", { name: "Archive Support agent?" })).toBeNull();
  });

  /**
   * The primitives the kit gained, on the one surface that draws them.
   *
   * They are asserted through what a reader is actually given — the selected
   * tab and the panel it names, the chosen option, the value a progress bar
   * announces — rather than through class names. jsdom loads no stylesheet, so
   * a class assertion here would prove the string and not the behaviour, and
   * the behaviour is the half these six were added for.
   */
  it("proves the tab set, the single choice, and the skeleton the kit gained", () => {
    render(<DesignSystemProof />);

    /*
     * One set, one panel. Three tab sets are drawn, so all three panels are
     * counted: a `getByRole` that happened to find one would pass just as well
     * if another had quietly stopped rendering.
     */
    expect(screen.getAllByRole("tabpanel")).toHaveLength(3);
    const simulations = screen.getByRole("tab", { name: "Simulations" });
    expect(simulations.getAttribute("aria-selected")).toBe("true");
    expect(
      screen.getByText(/Ten simulations ran/u),
    ).toBeTruthy();

    /*
     * Radix switches a tab on `mousedown` rather than on `click`, which is the
     * detail a test written against the wrong event passes without ever
     * changing a panel.
     */
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Graders" }), {
      button: 0,
    });
    expect(simulations.getAttribute("aria-selected")).toBe("false");
    expect(screen.getByText(/Both were frozen when it started/u)).toBeTruthy();
    expect(screen.queryByText(/Ten simulations ran/u)).toBeNull();

    /* The other set is the `line` variant, and it is a separate set. */
    expect(screen.getByRole("tab", { name: "Transcript" }).getAttribute("aria-selected")).toBe("true");

    /*
     * The third set is the vertical rail, which nothing in the product uses
     * yet — so this surface is the only place its shape is held to anything.
     * Its disabled tab is asserted beside it because "disable rather than hide"
     * is a product decision: the choice stays readable and named, and stays out
     * of reach. A set drawn without one would prove the easy half only.
     */
    expect(screen.getByRole("tab", { name: "Turns" }).getAttribute("aria-selected")).toBe("true");
    const recording = screen.getByRole("tab", { name: "Recording" });
    expect((recording as HTMLButtonElement).disabled).toBe(true);
    expect(recording.getAttribute("aria-selected")).toBe("false");

    /*
     * The group's question is on the page, not only in an `aria-label`.
     * `DESIGN.md` keeps labels visible, so the element a reader can see is the
     * same one that names the group — asserted as one fact rather than two, so
     * the wiring cannot drift away from the words.
     */
    const group = screen.getByRole("radiogroup", {
      name: "What a repeated run reuses",
    });
    expect(group.getAttribute("aria-labelledby")).toBe(
      screen.getByText("What a repeated run reuses").id,
    );

    /* One answer out of the set, and the page says which one it heard. */
    const fresh = screen.getByRole("radio", {
      name: "A new persona for each simulation",
    });
    expect(fresh.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(fresh);
    expect(fresh.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText("Chosen: a new persona")).toBeTruthy();

    /*
     * A skeleton is a shape and nothing else, so the word has to be beside it.
     * `DESIGN.md` asks a loading state to say what is happening, and the shapes
     * themselves are hidden from assistive technology precisely because they
     * say nothing.
     */
    const loading = screen.getByText("Loading graders…");
    expect(loading.parentElement?.getAttribute("aria-busy")).toBe("true");
  });

  /**
   * The progress bar's three states, and the one it is easiest to get wrong.
   *
   * A value on its way up, a value that has arrived, and no value at all. The
   * last is the state a happy example always skips: an indeterminate bar must
   * not report a number, because "amount unknown" and "nothing done yet" are
   * different claims and only one of them is true.
   */
  it("proves the progress bar counting, complete, and indeterminate", () => {
    render(<DesignSystemProof />);

    const running = screen.getByRole("progressbar", {
      name: "Simulations graded",
    });
    expect(running.getAttribute("aria-valuenow")).toBe("7");
    expect(running.getAttribute("aria-valuemax")).toBe("10");
    expect(running.getAttribute("aria-valuetext")).toBe(
      "7 of 10 simulations graded",
    );
    expect(running.getAttribute("data-state")).toBe("loading");

    fireEvent.click(
      screen.getByRole("button", { name: "Grade one more simulation" }),
    );
    expect(running.getAttribute("aria-valuenow")).toBe("8");
    expect(screen.getByText("8 of 10 simulations graded")).toBeTruthy();

    const complete = screen.getByRole("progressbar", { name: "Transcripts collected" });
    expect(complete.getAttribute("data-state")).toBe("complete");

    const unknown = screen.getByRole("progressbar", {
      name: "Recording being prepared",
    });
    expect(unknown.getAttribute("data-state")).toBe("indeterminate");
    /* No number claimed, and no fill drawn either. */
    expect(unknown.getAttribute("aria-valuenow")).toBeNull();
    expect(
      unknown
        .querySelector("[data-slot='progress-indicator']")
        ?.getAttribute("style"),
    ).toContain("translateX(-100%)");
  });

  /**
   * The two arrivals: a tooltip attached to one control, and a notification.
   *
   * Both are proved on the kit primitives rather than on the shared components
   * above them, because the shared ones are already covered by the feedback
   * tests and these two have no other caller yet.
   */
  it("opens the base tooltip and the base toast", async () => {
    render(<DesignSystemProof />);

    const trigger = screen.getByRole("button", {
      name: "What a frozen grader means",
    });
    fireEvent.focus(trigger);
    expect(
      (await screen.findByText(/editing the grader never changes a grade/u)),
    ).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: "Show a saved notification" }),
    );
    expect(await screen.findByText("Grader saved")).toBeTruthy();
  });
});
