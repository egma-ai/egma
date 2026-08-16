// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { DataTable, type Column } from "../ui/data-table.tsx";

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
  it("adds one pointer-only row link while keeping the primary link accessible", () => {
    render(
      <DataTable
        label="Agents"
        columns={COLUMNS}
        rows={[ROW]}
        keyOf={(row) => row.id}
        rowHref={(row) => `/agents/${row.id}`}
      />,
    );

    const table = screen.getByRole("table", { name: "Agents" });
    const row = within(table).getAllByRole("row")[1] as HTMLElement;
    const primaryLink = within(row).getByRole("link", { name: "Front desk" });
    const pointerLink = row.querySelector('a[aria-hidden="true"]');

    expect(primaryLink.getAttribute("href")).toBe("/agents/agt_1");
    expect(primaryLink.getAttribute("tabindex")).toBeNull();
    expect(pointerLink?.getAttribute("href")).toBe("/agents/agt_1");
    expect(pointerLink?.getAttribute("tabindex")).toBe("-1");
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
    expect(table.querySelector('a[aria-hidden="true"]')).toBeNull();
  });
});
