"use client";

import type { ReactNode } from "react";

import { Button } from "./controls.tsx";
import styles from "./system.module.css";

/**
 * A page of rows, described once and drawn twice.
 *
 * **One column definition produces both layouts.** A wide screen gets a dense
 * table; a narrow one gets a stack of rows, where the column marked `primary`
 * becomes the row's name and the rest become its facts. The alternative — a
 * table and a hand-written mobile list side by side — is two things to keep in
 * step, and the mobile half is always the one that falls behind.
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
  more,
}: {
  /** What this table is a table of. Read out where there is no visible caption. */
  readonly label: string;
  readonly columns: readonly Column<Row>[];
  readonly rows: readonly Row[];
  readonly keyOf: (row: Row) => string;
  readonly more?: More;
}) {
  const primary = columns.find((column) => column.primary) ?? columns[0];
  const rest = columns.filter((column) => column !== primary);

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
    <div>
      <div className={styles.tableWrap}>
        <table className={styles.table} aria-label={label}>
          <thead>
            <tr>
              {columns.map((column) => (
                <th key={column.key} scope="col" style={{ width: column.width }}>
                  {column.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={keyOf(row)}>
                {columns.map((column) => (
                  <td key={column.key}>
                    <span className={cellClass(column)}>{column.cell(row)}</span>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ul className={styles.list} aria-label={label}>
        {rows.map((row) => (
          <li className={styles.listRow} key={keyOf(row)}>
            <div className={styles.listRowHead}>
              <span className={styles.listRowTitle}>
                {primary === undefined ? null : primary.cell(row)}
              </span>
            </div>
            <dl>
              {rest.map((column) => (
                <div className={styles.listRowFact} key={column.key}>
                  <dt>{column.header}</dt>
                  <dd className={column.mono === true ? styles.cellMono : undefined}>
                    {column.cell(row)}
                  </dd>
                </div>
              ))}
            </dl>
          </li>
        ))}
      </ul>

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
