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

  it("keeps the real centered confirmation dialog through a pointer exit", () => {
    render(<DesignSystemProof />);

    fireEvent.click(screen.getAllByRole("button", { name: "Register agent" })[0]!);
    const dialog = screen.getByRole("dialog", { name: "Archive Support agent?" });
    expect(dialog).toBeTruthy();
    expect(
      within(dialog).getByRole("button", { name: "Archive agent" }).className,
    ).toContain("buttonDestructive");

    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }), { detail: 1 });
    expect(screen.getByRole("dialog", { name: "Archive Support agent?" })).toBe(dialog);
    expect(dialog.getAttribute("data-closing")).toBe("true");

    const panel = dialog.firstElementChild as HTMLElement;
    fireEvent.transitionEnd(panel, { propertyName: "opacity" });
    expect(screen.queryByRole("dialog", { name: "Archive Support agent?" })).toBeNull();
  });
});
