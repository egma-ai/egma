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

afterEach(cleanup);

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
    const activated: {
      readonly id: string;
      readonly opener: HTMLElement | null;
    }[] = [];
    render(
      <DataTable
        label="Graders"
        columns={ACTIVATION_COLUMNS}
        rows={[ROW]}
        keyOf={(row) => row.id}
        onRowActivate={(row, opener) => activated.push({ id: row.id, opener })}
      />,
    );
    const table = screen.getByRole("table", { name: "Graders" });
    const row = within(table).getAllByRole("row")[1] as HTMLElement;

    /* Dead space on the row is the row's. */
    fireEvent.click(within(row).getByRole("cell", { name: "2026-08-15" }));
    expect(activated).toEqual([
      {
        id: "agt_1",
        opener: within(row).getByRole("button", { name: "Front desk" }),
      },
    ]);

    /* The name button and the menu trigger keep their own clicks. */
    fireEvent.click(within(row).getByRole("button", { name: "Front desk" }));
    fireEvent.click(within(row).getByRole("button", { name: "Open menu" }));
    expect(activated).toHaveLength(1);

    /*
     * The open panel is portalled to `body`, so its clicks still bubble the
     * React tree into this row — and must not be the row's.
     */
    fireEvent.click(screen.getByTestId("portal-panel"));
    expect(activated).toHaveLength(1);
  });
});
