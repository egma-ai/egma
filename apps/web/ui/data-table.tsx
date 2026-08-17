"use client";

import type { ReactNode } from "react";

import { Button } from "./controls.tsx";
import styles from "./system.module.css";

/**
 * A page of rows, described once and drawn once.
 *
 * **One semantic table produces both layouts.** A wide screen gets a dense
 * table; CSS turns that same tree into a stack of labelled rows on a narrow
 * screen. The column marked `primary` becomes the row's name and the rest
 * become its facts. Drawing a table and a mobile list side by side would put
 * every control and id in the document twice, even though only one copy is
 * visible.
 *
 * **A row is a line of reading, not a card.** The height is a token, cells do
 * not wrap, and the vertical padding is deliberately small: a list of forty
 * agents should be a list of forty agents rather than four screens of scroll.
 *
 * Paging is keyset, so "more" means *carry on from where that page stopped*
 * rather than *skip a number of rows*. The control is here rather than in each
 * page so that every list in the product asks for the next page the same way.
 */

export type Column<Row> = {
  readonly key: string;
  readonly header: string;
  readonly cell: (row: Row) => ReactNode;
  /** The column that names the row. Exactly one, and it leads the small layout. */
  readonly primary?: boolean;
  /** A supporting fact that the narrow layout can omit without hiding the row's name. */
  readonly hideOnMobile?: boolean;
  /** Identifiers, counts and times, which read straight in the mono face. */
  readonly mono?: boolean;
  readonly width?: string;
};

export type More = {
  readonly onMore: () => void;
  readonly loading: boolean;
  /** What is already on screen, said plainly beside the control. */
  readonly note?: string;
};

export function DataTable<Row>({
  label,
  columns,
  rows,
  keyOf,
  stretchPrimaryLink = false,
  stackWhenConstrained = false,
  more,
}: {
  /** What this table is a table of. Read out where there is no visible caption. */
  readonly label: string;
  readonly columns: readonly Column<Row>[];
  readonly rows: readonly Row[];
  readonly keyOf: (row: Row) => string;
  /**
   * Stretches the primary cell's first real link across a natural navigation
   * row. There is still only one link in the accessibility tree.
   */
  readonly stretchPrimaryLink?: boolean;
  /**
   * Switches this same semantic table to labelled rows when its own container,
   * rather than the browser viewport, is too narrow for all of its columns.
   */
  readonly stackWhenConstrained?: boolean;
  readonly more?: More;
}) {
  const primary = columns.find((column) => column.primary) ?? columns[0];
  function mobileHidden(column: Column<Row>): "true" | undefined {
    return column !== primary && column.hideOnMobile === true ? "true" : undefined;
  }

  function cellClass(column: Column<Row>): string {
    return [
      styles.cell,
      column === primary ? styles.cellPrimary : "",
      column.mono === true ? styles.cellMono : "",
    ]
      .filter((one) => one !== "")
      .join(" ");
  }

  return (
    <div className={stackWhenConstrained ? styles.tableConstrained : undefined}>
      <div className={styles.tableWrap}>
        <table className={styles.table} aria-label={label}>
          <thead>
            <tr>
              {columns.map((column) => (
                <th
                  data-mobile-hidden={mobileHidden(column)}
                  key={column.key}
                  scope="col"
                  style={{ width: column.width }}
                >
                  {column.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                className={
                  stretchPrimaryLink ? styles.tableRowInteractive : undefined
                }
                key={keyOf(row)}
              >
                {columns.map((column) => (
                  <td
                    className={column === primary ? styles.tableCellPrimary : undefined}
                    data-label={column.header}
                    data-mobile-hidden={mobileHidden(column)}
                    key={column.key}
                  >
                    <span className={cellClass(column)}>{column.cell(row)}</span>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {more === undefined ? null : (
        <div className={styles.more}>
          <span>{more.note}</span>
          <Button disabled={more.loading} onClick={more.onMore}>
            {more.loading ? "Loading…" : "Show more"}
          </Button>
        </div>
      )}
    </div>
  );
}
