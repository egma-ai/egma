// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Menu, MenuItem } from "../ui/menu.tsx";

afterEach(cleanup);

describe("anchored menu placement", () => {
  it.each([
    "right-start",
    "right-end",
    "below-start",
    "below-end",
  ] as const)("anchors %s without covering its trigger column", (placement) => {
    render(
      <Menu label={`Open ${placement}`} placement={placement} trigger={<span>Open</span>}>
        {(close) => <MenuItem onClick={close}>One choice</MenuItem>}
      </Menu>,
    );

    fireEvent.click(screen.getByRole("button", { name: `Open ${placement}` }));

    expect(screen.getByRole("menu").dataset.placement).toBe(placement);
  });
});
