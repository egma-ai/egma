// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu.tsx";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../components/ui/popover.tsx";
import { Menu, MenuItem } from "../ui/menu.tsx";

afterEach(cleanup);

/**
 * Where the panel went, read off the panel rather than off the prop.
 *
 * `data-side` and `data-align` are what Radix writes after it has placed the
 * panel, so they are the position and not a copy of the request. A placement
 * that stopped reaching the positioner would come back as the default side
 * here, which is the failure the earlier form of this test could not see.
 */
describe("anchored menu placement", () => {
  it.each([
    ["right-start", "right", "start"],
    ["right-end", "right", "end"],
    ["below-start", "bottom", "start"],
    ["below-end", "bottom", "end"],
    ["above-start", "top", "start"],
    ["above-end", "top", "end"],
  ] as const)(
    "anchors %s without covering its trigger column",
    (placement, side, align) => {
      render(
        <Menu label={`Open ${placement}`} placement={placement} trigger={<span>Open</span>}>
          {(close) => <MenuItem onClick={close}>One choice</MenuItem>}
        </Menu>,
      );

      fireEvent.click(screen.getByRole("button", { name: `Open ${placement}` }));

      const panel = screen.getByRole("menu");
      expect(panel.dataset.side).toBe(side);
      expect(panel.dataset.align).toBe(align);
    },
  );

  /**
   * The panel wears the slot the theme's origin-aware motion is keyed on, so
   * it grows from the trigger and its exit finishes before it is removed.
   */
  it("is the kit's anchored surface, which is what carries the motion", () => {
    render(
      <Menu label="Open menu" trigger={<span>Open</span>}>
        {(close) => <MenuItem onClick={close}>One choice</MenuItem>}
      </Menu>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));

    const panel = screen.getByRole("menu");
    expect(panel.dataset.slot).toBe("popover-content");
    expect(panel.dataset.state).toBe("open");
  });
});

/**
 * Check that each anchored panel uses Radix's available-height value and
 * scrolling styles. Radix supplies the measurement; the component must apply
 * the limit. jsdom cannot verify viewport fit.
 */
describe("anchored panels are bounded by the primitive", () => {
  const CAP = "-available-height)-var(--space-2))]";

  it("bounds and scrolls a popover, so a long list cannot outgrow the window", () => {
    render(
      <Popover>
        <PopoverTrigger>Open</PopoverTrigger>
        <PopoverContent aria-label="Connections">
          <a href="/one">One connection</a>
        </PopoverContent>
      </Popover>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open" }));

    const panel = screen.getByLabelText("Connections");
    expect(panel.className).toContain(
      `max-h-[calc(var(--radix-popover-content${CAP}`,
    );
    expect(panel.className).toContain("overflow-y-auto");
  });

  /**
   * The menu clipped rather than scrolled: `overflow-hidden` hid the rows past
   * the panel's edge and offered no way to reach them. `overflow-x-hidden` is
   * deliberate and is not that — a single axis left at `visible` beside an
   * `auto` one computes to `auto` too, and hangs a scrollbar under the menu.
   */
  it("bounds and scrolls a dropdown menu instead of clipping it", () => {
    render(
      <DropdownMenu>
        <DropdownMenuTrigger>Actions</DropdownMenuTrigger>
        <DropdownMenuContent aria-label="Row actions">
          <DropdownMenuItem>One action</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );

    /* Radix opens this one on `pointerdown`, not on the click after it. */
    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Actions" }),
      { button: 0, ctrlKey: false },
    );

    const panel = screen.getByLabelText("Row actions");
    expect(panel.className).toContain(
      `max-h-[calc(var(--radix-dropdown-menu-content${CAP}`,
    );
    expect(panel.className).toContain("overflow-y-auto");
    expect(panel.className).not.toContain("overflow-hidden");
  });
});
