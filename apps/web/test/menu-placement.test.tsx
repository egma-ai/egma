// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Menu, MenuItem } from "../ui/menu.tsx";
import styles from "../ui/system.module.css";

afterEach(cleanup);

describe("anchored menu placement", () => {
  it.each([
    ["right-start", styles.menuRightStart],
    ["right-end", styles.menuRightEnd],
    ["below-start", styles.menuBelowStart],
    ["below-end", styles.menuBelowEnd],
  ] as const)("anchors %s without covering its trigger column", (placement, className) => {
    render(
      <Menu label={`Open ${placement}`} placement={placement} trigger={<span>Open</span>}>
        {(close) => <MenuItem onClick={close}>One choice</MenuItem>}
      </Menu>,
    );

    fireEvent.click(screen.getByRole("button", { name: `Open ${placement}` }));

    expect(screen.getByRole("menu").classList.contains(className)).toBe(true);
  });
});
