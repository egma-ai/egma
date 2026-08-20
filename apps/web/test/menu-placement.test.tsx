// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

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
