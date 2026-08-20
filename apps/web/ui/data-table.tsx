"use client";

import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

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
 *
 * **What each cell is, is on the cell.** The narrow layout has to reach the
 * primary cell and the action cell from a stylesheet, and the wide layout has
 * to reach real controls inside a row whose primary link has been stretched
 * over it. Those hooks are `data-primary` and `data-action` rather than class
 * names, because a page composing this table can read them, a test can assert
 * them, and neither depends on what the styling is written in.
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
  /** A row control. It stays at the trailing edge in both table layouts. */
  readonly action?: boolean;
  readonly width?: string;
};

export type More = {
  readonly onMore: () => void;
  readonly loading: boolean;
  /** What is already on screen, said plainly beside the control. */
  readonly note?: string;
};

/** One cursor-backed page, with labels supplied by the product surface. */
export type Pagination = {
  readonly page: number;
  readonly canPrevious: boolean;
  readonly canNext: boolean;
  readonly loading: boolean;
  readonly onPrevious: () => void;
  readonly onNext: () => void;
  readonly previousLabel: string;
  readonly pageLabel: (page: number) => string;
  readonly nextLabel: string;
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
  pagination,
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
  readonly pagination?: Pagination;
}) {
  const primary = columns.find((column) => column.primary) ?? columns[0];
  const pageLabel = pagination?.pageLabel(pagination.page);
  function mobileHidden(column: Column<Row>): "true" | undefined {
    return column !== primary && column.hideOnMobile === true ? "true" : undefined;
  }

  return (
    <div className={stackWhenConstrained ? "@container/data-table" : undefined}>
      <div
        className={cn(
          "overflow-x-auto rounded-card border border-border bg-surface",
          /* Stacked rows are not a scrolling region; they are the page. */
          "stacked:overflow-visible",
        )}
      >
        <table
          className="w-full border-collapse stacked:block"
          aria-label={label}
        >
          {/*
           * The headers are read out in both layouts and drawn in one. Stacked
           * rows carry their own label on each cell, so a visible header row
           * would be the same word twice.
           */}
          <thead className="stacked:sr-only">
            <tr>
              {columns.map((column) => (
                <th
                  className={cn(
                    "border-b border-border px-(--row-padding-x) py-2",
                    "text-left text-sm font-normal tracking-normal whitespace-nowrap text-faint",
                    "data-[action=true]:text-right",
                    column.hideOnMobile === true &&
                      column !== primary &&
                      "max-[900px]:hidden",
                  )}
                  data-action={column.action === true ? "true" : undefined}
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
          <tbody className="stacked:block">
            {rows.map((row) => (
              <tr
                className={cn(
                  "[&:first-child>td]:border-t-0",
                  "stacked:flex stacked:flex-col stacked:gap-1",
                  "stacked:border-t stacked:border-border stacked:px-(--row-padding-x) stacked:py-3",
                  "stacked:first:border-t-0",
                )}
                data-slot="data-table-row"
                data-stretch-primary-link={
                  stretchPrimaryLink ? "true" : undefined
                }
                key={keyOf(row)}
              >
                {columns.map((column) => (
                  <td
                    className={cn(
                      "h-(--row-height) border-t border-border align-middle",
                      "px-(--row-padding-x) py-(--row-padding-y) text-sm text-muted-foreground",
                      "data-[action=true]:text-right",
                      "stacked:flex stacked:h-auto stacked:min-h-0 stacked:items-baseline",
                      "stacked:justify-between stacked:gap-3 stacked:border-0 stacked:p-0",
                      column === primary
                        ? "stacked:mb-1"
                        : [
                            /* The header is the label, said again beside the fact. */
                            "stacked:before:flex-none stacked:before:text-xs",
                            "stacked:before:tracking-(--tracking-label) stacked:before:text-faint",
                            "stacked:before:uppercase",
                            "stacked:before:content-[attr(data-label)]",
                          ],
                      "data-[action=true]:stacked:mt-2 data-[action=true]:stacked:items-center",
                      /* A row control that drew nothing leaves no empty line. */
                      "data-[action=true]:max-[900px]:has-[[data-slot=cell]:empty]:hidden",
                      column.header === "" && [
                        "@max-[60rem]/data-table:justify-end",
                        "@max-[60rem]/data-table:has-[[data-slot=cell]:empty]:hidden",
                      ],
                      column.hideOnMobile === true &&
                        column !== primary &&
                        "max-[900px]:hidden",
                    )}
                    data-action={column.action === true ? "true" : undefined}
                    data-label={column.header}
                    data-mobile-hidden={mobileHidden(column)}
                    data-primary={column === primary ? "true" : undefined}
                    key={column.key}
                  >
                    <span
                      className={cn(
                        "block overflow-hidden text-ellipsis whitespace-nowrap",
                        column === primary && "font-medium text-foreground",
                        column.mono === true && "font-mono text-sm",
                        /*
                         * The action cell's own shape, read off the cell it
                         * sits in rather than off a prop this file re-tested.
                         * The class is unconditional and `data-action` decides,
                         * so the attribute is what draws the row's control at
                         * the trailing edge — not a label beside whatever does.
                         */
                        "in-data-[action=true]:flex in-data-[action=true]:items-center",
                        "in-data-[action=true]:justify-end",
                        "in-data-[action=true]:overflow-visible in-data-[action=true]:text-clip",
                        column !== primary &&
                          "stacked:min-w-0 stacked:max-w-[70%] stacked:text-right",
                        "in-data-[action=true]:stacked:max-w-none",
                      )}
                      data-slot="cell"
                    >
                      {column.cell(row)}
                    </span>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {more === undefined ? null : (
        <div className="mt-4 flex items-center justify-between gap-4 text-xs text-muted-foreground">
          <span>{more.note}</span>
          <Button
            type="button"
            variant="secondary"
            disabled={more.loading}
            onClick={more.onMore}
          >
            {more.loading ? "Loading…" : "Show more"}
          </Button>
        </div>
      )}

      {pagination === undefined ? null : (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-4 text-xs text-muted-foreground">
          <span>{pagination.note}</span>
          <div className="flex items-center gap-2" aria-label={pageLabel}>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={!pagination.canPrevious || pagination.loading}
              onClick={pagination.onPrevious}
            >
              {pagination.previousLabel}
            </Button>
            <span className="min-w-16 text-center" aria-live="polite">
              {pageLabel}
            </span>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              busy={pagination.loading}
              disabled={!pagination.canNext}
              onClick={pagination.onNext}
            >
              {pagination.nextLabel}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
