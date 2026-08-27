// @vitest-environment jsdom
import { useState } from "react";
import { createPortal } from "react-dom";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
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
    expect(row.dataset.stretchPrimaryLink).toBe("true");
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
      (within(table).getAllByRole("row")[1] as HTMLElement).dataset
        .stretchPrimaryLink,
    ).toBeUndefined();
  });
});

/**
 * One left edge per column, header and values on it.
 *
 * The rule is written once in `components/ui/table.tsx` and every table in the
 * product inherits it, so this asserts the token rather than a pixel: a header
 * and the cells under it name the same padding, and the only cell that aligns
 * its content any other way is the row's own control lane.
 *
 * The lane's own `px-0` is written unconditionally and applied by the
 * `data-action` attribute, so the attribute is what this asserts. Reading the
 * class back would pass on every cell in the table and prove nothing.
 */
describe("DataTable column alignment", () => {
  const LANE = "px-(--row-padding-x)";

  it("puts every header and its cells on one edge", () => {
    render(
      <DataTable
        label="Agents"
        columns={[...COLUMNS.slice(0, 2), { ...COLUMNS[2]!, action: true }]}
        rows={[ROW]}
        keyOf={(row) => row.id}
      />,
    );
    const table = screen.getByRole("table", { name: "Agents" });
    const headers = within(table).getAllByRole("columnheader");
    const cells = within(table).getAllByRole("cell");

    /* The facts: header and value read from the same declared edge, and
     * neither is marked as the lane that leaves it. */
    for (const element of [...headers.slice(0, 2), ...cells.slice(0, 2)]) {
      expect(element.className, element.textContent ?? "").toContain(LANE);
      expect(element.dataset.action, element.textContent ?? "").toBeUndefined();
    }

    /* The control lane, marked in the header as well as in the row: the mark
     * is what takes the side padding off both. */
    expect(headers[2]!.dataset.action).toBe("true");
    expect(cells[2]!.dataset.action).toBe("true");
  });
});

/** A row control whose open panel lives in `body`, the way the ⋮ menu does. */
function PortalMenu() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open menu
      </button>
      {open
        ? createPortal(
            <div data-testid="portal-panel">Panel padding</div>,
            document.body,
          )
        : null}
    </>
  );
}

const ACTIVATION_COLUMNS: readonly Column<Row>[] = [
  {
    key: "name",
    header: "Grader",
    primary: true,
    cell: (row) => <button type="button">{row.name}</button>,
  },
  {
    key: "registered",
    header: "Registered",
    cell: (row) => row.registered,
  },
  {
    key: "actions",
    header: "Actions",
    action: true,
    cell: () => <PortalMenu />,
  },
];

describe("DataTable row activation", () => {
  it("activates from the row surface and leaves control clicks alone", () => {
    const activated: string[] = [];
    render(
      <DataTable
        label="Graders"
        columns={ACTIVATION_COLUMNS}
        rows={[ROW]}
        keyOf={(row) => row.id}
        onRowActivate={(row) => activated.push(row.id)}
      />,
    );
    const table = screen.getByRole("table", { name: "Graders" });
    const row = within(table).getAllByRole("row")[1] as HTMLElement;

    /* Dead space on the row is the row's. */
    fireEvent.click(within(row).getByRole("cell", { name: "2026-08-15" }));
    expect(activated).toEqual(["agt_1"]);

    /* The name button and the menu trigger keep their own clicks. */
    fireEvent.click(within(row).getByRole("button", { name: "Front desk" }));
    fireEvent.click(within(row).getByRole("button", { name: "Open menu" }));
    expect(activated).toEqual(["agt_1"]);

    /*
     * The open panel is portalled to `body`, so its clicks still bubble the
     * React tree into this row — and must not be the row's.
     */
    fireEvent.click(screen.getByTestId("portal-panel"));
    expect(activated).toEqual(["agt_1"]);
  });

  it("keeps rows inert when no activation is asked for", () => {
    render(
      <DataTable
        label="Graders"
        columns={ACTIVATION_COLUMNS}
        rows={[ROW]}
        keyOf={(row) => row.id}
      />,
    );
    const table = screen.getByRole("table", { name: "Graders" });
    const row = within(table).getAllByRole("row")[1] as HTMLElement;
    expect(row.className).not.toContain("cursor-pointer");
  });
});
