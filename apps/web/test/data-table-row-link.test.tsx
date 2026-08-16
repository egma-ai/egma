// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { DataTable, type Column } from "../ui/data-table.tsx";
import styles from "../ui/system.module.css";

type Row = {
  readonly id: string;
  readonly name: string;
  readonly registered: string;
};

const ROW: Row = {
  id: "agt_1",
  name: "Front desk",
  registered: "2026-08-15",
};

const COLUMNS: readonly Column<Row>[] = [
  {
    key: "name",
    header: "Agent",
    primary: true,
    cell: (row) => <a href={`/agents/${row.id}`}>{row.name}</a>,
  },
  {
    key: "registered",
    header: "Registered",
    hideOnMobile: true,
    cell: (row) => row.registered,
  },
  {
    key: "actions",
    header: "Actions",
    cell: () => <button type="button">Edit agent</button>,
  },
];

afterEach(cleanup);

describe("DataTable row links", () => {
  it("stretches the one accessible primary link across a natural row", () => {
    render(
      <DataTable
        label="Agents"
        columns={COLUMNS}
        rows={[ROW]}
        keyOf={(row) => row.id}
        stretchPrimaryLink
      />,
    );

    const table = screen.getByRole("table", { name: "Agents" });
    const row = within(table).getAllByRole("row")[1] as HTMLElement;
    const primaryLink = within(row).getByRole("link", { name: "Front desk" });

    expect(primaryLink.getAttribute("href")).toBe("/agents/agt_1");
    expect(primaryLink.getAttribute("tabindex")).toBeNull();
    expect(row.classList.contains(styles.tableRowInteractive)).toBe(true);
    expect(within(row).getAllByRole("link")).toHaveLength(1);
    expect(within(row).getByRole("button", { name: "Edit agent" })).toBeTruthy();
  });

  it("marks optional supporting columns for the shared narrow layout", () => {
    render(
      <DataTable
        label="Agents"
        columns={COLUMNS}
        rows={[ROW]}
        keyOf={(row) => row.id}
      />,
    );

    const table = screen.getByRole("table", { name: "Agents" });
    const registeredHeader = within(table).getByRole("columnheader", {
      name: "Registered",
    });
    const registeredCell = within(table).getByRole("cell", {
      name: "2026-08-15",
    });

    expect(registeredHeader.getAttribute("data-mobile-hidden")).toBe("true");
    expect(registeredCell.getAttribute("data-mobile-hidden")).toBe("true");
    expect(
      (within(table).getAllByRole("row")[1] as HTMLElement).classList.contains(
        styles.tableRowInteractive,
      ),
    ).toBe(false);
  });
});
