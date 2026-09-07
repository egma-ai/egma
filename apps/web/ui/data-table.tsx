"use client";

import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TablePanel,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

import { ROW_HOVER } from "./evidence.tsx";

/**
 * Render one semantic table in wide and stacked layouts so controls and IDs
 * are not duplicated. Columns define headers and cells together; primary and
 * action attributes identify their roles for layout and tests.
 * Use the shared trailing action slot and next-page control across lists.
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
  /**
   * Requested column width in automatic table layout. Unspecified columns share
   * remaining space; constrained content can still affect sizing. Action columns
   * use the shared width and minimum-width rules below.
   */
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
  onRowActivate,
  currentKey,
  stackWhenConstrained = false,
  narrowLayout = "stack",
  tableMinWidth,
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
   * Activate the row on pointer clicks outside its child controls. Keep a real
   * button in the primary cell for keyboard access. Use stretchPrimaryLink for
   * rows whose primary action is navigation.
   */
  readonly onRowActivate?: (
    row: Row,
    primaryControl: HTMLElement | null,
  ) => void;
  /**
   * The row whose record is open in the sheet beside the list.
   *
   * `DESIGN.md` gives current rows Ember Wash and a non-colour state mark.
   * The leading Ember edge supplies the visual mark, and `aria-current`
   * supplies the same fact to a reader that cannot see it.
   */
  readonly currentKey?: string;
  /**
   * Switches this same semantic table to labelled rows when its own container,
   * rather than the browser viewport, is too narrow for all of its columns.
   */
  readonly stackWhenConstrained?: boolean;
  /**
   * What the one semantic table does when the viewport is narrow.
   *
   * Most product lists become labelled rows. Evidence tables whose columns
   * must stay aligned may instead keep their table layout and let the panel
   * scroll sideways.
   */
  readonly narrowLayout?: "stack" | "scroll";
  /**
   * The route-owned width below which a scrolling table must not compress.
   * It has no effect on the default stacked layout.
   */
  readonly tableMinWidth?: string;
  readonly more?: More;
  readonly pagination?: Pagination;
}) {
  const stacks = narrowLayout === "stack";
  const primary = columns.find((column) => column.primary) ?? columns[0];
  const pageLabel = pagination?.pageLabel(pagination.page);
  /**
   * The theme owns action-column width; callers may size other columns. Apply
   * width to headers only so it does not constrain body cells in stacked layout.
   */
  function widthOf(column: Column<Row>): string | undefined {
    if (column.action === true) return "var(--table-action-width)";
    return column.width;
  }
  /**
   * Give the action column a min-width as well as width. Automatic table layout
   * can otherwise shrink an empty action column below its intended size.
   */
  function floorOf(column: Column<Row>): string | undefined {
    return column.action === true ? "var(--table-action-width)" : undefined;
  }
  /**
   * Whether the narrow layout leaves this column out.
   *
   * The primary column can never be omitted: it is the row's name, and a
   * stacked row without one is a row nobody can read.
   */
  function hiddenWhenStacked(column: Column<Row>): boolean {
    return column !== primary && column.hideOnMobile === true;
  }
  function mobileHidden(column: Column<Row>): "true" | undefined {
    return stacks && hiddenWhenStacked(column) ? "true" : undefined;
  }

  return (
    <div
      className={cn(
        "min-w-0 max-w-full",
        stacks && stackWhenConstrained && "@container/data-table",
      )}
      data-narrow-layout={narrowLayout}
    >
      <TablePanel
        className={cn(
          /* Stacked rows are not a scrolling region; they are the page. */
          stacks && "stacked:overflow-visible",
        )}
      >
        <Table
          className={cn(stacks && "stacked:block")}
          aria-label={label}
          style={
            !stacks && tableMinWidth !== undefined
              ? { minWidth: tableMinWidth }
              : undefined
          }
        >
          {/*
           * The headers are read out in both layouts and drawn in one. Stacked
           * rows carry their own label on each cell, so a visible header row
           * would be the same word twice.
           */}
          <TableHeader className={cn(stacks && "stacked:sr-only")}>
            <TableRow>
              {columns.map((column) => (
                <TableHead
                  className={cn(
                    /*
                     * The trailing slot is empty in the header and still
                     * present: it is what holds the lane open above the first
                     * ⋮, which is where a person's eye starts down it.
                     */
                    "data-[action=true]:px-0",
                    stacks &&
                      hiddenWhenStacked(column) &&
                      "stacked:hidden",
                  )}
                  data-action={column.action === true ? "true" : undefined}
                  data-mobile-hidden={mobileHidden(column)}
                  key={column.key}
                  scope="col"
                  style={{ width: widthOf(column), minWidth: floorOf(column) }}
                >
                  {column.action === true ? "" : column.header}
                  {column.action === true ? (
                    <span className="sr-only">{column.header}</span>
                  ) : null}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody className={cn(stacks && "stacked:block")}>
            {rows.map((row) => {
              const current =
                currentKey !== undefined && keyOf(row) === currentKey;
              return (
              <TableRow
                aria-current={current ? "true" : undefined}
                className={cn(
                  "[&:first-child>td]:border-t-0",
                  stacks && [
                    "stacked:flex stacked:flex-col stacked:gap-1",
                    "stacked:border-t stacked:border-border stacked:px-(--row-padding-x) stacked:py-3",
                    "stacked:first:border-t-0",
                  ],
                  onRowActivate !== undefined && [
                    "cursor-pointer transition-colors duration-(--duration-hover) ease-out",
                    "motion-reduce:transition-none",
                  ],
                  /*
                   * A current row uses the shared selected wash and the Ember
                   * leading mark, so the state remains visible without colour.
                   * Hover stays off that row because it is already current.
                  */
                  current
                    ? ["bg-selected", stacks && "stacked:relative"]
                    : onRowActivate !== undefined && ROW_HOVER,
                )}
                data-current={current ? "true" : undefined}
                data-slot="data-table-row"
                data-stretch-primary-link={
                  stretchPrimaryLink ? "true" : undefined
                }
                key={keyOf(row)}
                onClick={
                  onRowActivate === undefined
                    ? undefined
                    : (event) => {
                        const pressed = event.target as HTMLElement;
                        /*
                         * A portalled surface — the ⋮ panel lives in `body` —
                         * still bubbles through the React tree to this row, so
                         * containment is checked before anything else: a click
                         * that is not physically inside the row is not the
                         * row's.
                         */
                        if (!event.currentTarget.contains(pressed)) return;
                        /* A control inside the row keeps its own click. */
                        if (
                          pressed.closest(
                            "button, a, input, label, select, textarea",
                          ) !== null
                        ) {
                          return;
                        }
                        onRowActivate(
                          row,
                          event.currentTarget.querySelector<HTMLElement>(
                            '[data-primary="true"] button, [data-primary="true"] a',
                          ),
                        );
                      }
                }
              >
                {columns.map((column, columnIndex) => (
                  <TableCell
                    className={cn(
                      "h-(--row-min-height) text-muted-foreground",
                      current && columnIndex === 0 && [
                        "relative",
                        stacks && "stacked:static",
                      ],
                      "data-[action=true]:px-0 data-[action=true]:text-center",
                      /*
                       * Choose hidden or flex within the same stacked variant. Competing display
                       * rules could make hideOnMobile ineffective; container-based stacking must
                       * hide the same optional columns as a narrow viewport.
                       */
                      stacks && hiddenWhenStacked(column)
                        ? "stacked:hidden"
                        : stacks
                          ? [
                            "stacked:flex stacked:h-auto stacked:min-h-0 stacked:items-baseline",
                            "stacked:justify-between stacked:gap-3 stacked:border-0 stacked:p-0",
                            ]
                          : undefined,
                      stacks && column === primary
                        ? "stacked:mb-1"
                        : stacks && column.action === true
                          ? /*
                             * **The lane carries no label, in either layout.**
                             * The header cell is empty by the boards' own
                             * drawing and the control inside names itself, so
                             * a stacked row that wrote "ACTIONS" above a ⋮
                             * would be saying the same word twice — once in
                             * capitals. What is left is the control alone, at
                             * the trailing edge, which is the lane.
                             */
                            "stacked:justify-end"
                          : stacks
                            ? [
                              /* The header is the label, said again beside the fact. */
                              "stacked:before:flex-none stacked:before:text-xs",
                              "stacked:before:tracking-(--tracking-label) stacked:before:text-faint",
                              "stacked:before:uppercase",
                              "stacked:before:content-[attr(data-label)]",
                              ]
                            : undefined,
                      stacks &&
                        "data-[action=true]:stacked:mt-2 data-[action=true]:stacked:items-center",
                      /* A row control that drew nothing leaves no empty line. */
                      stacks &&
                        "data-[action=true]:max-[900px]:has-[[data-slot=cell]:empty]:hidden",
                      stacks && column.header === "" && [
                        "@max-[60rem]/data-table:justify-end",
                        "@max-[60rem]/data-table:has-[[data-slot=cell]:empty]:hidden",
                      ],
                    )}
                    data-action={column.action === true ? "true" : undefined}
                    data-label={column.header}
                    data-mobile-hidden={mobileHidden(column)}
                    data-primary={column === primary ? "true" : undefined}
                    key={column.key}
                  >
                    {current && columnIndex === 0 ? (
                      <span
                        aria-hidden="true"
                        className="pointer-events-none absolute inset-y-0 left-0 w-(--active-edge-width) bg-brand"
                        data-slot="current-row-mark"
                      />
                    ) : null}
                    <span
                      className={cn(
                        column === primary && onRowActivate !== undefined
                          ? /*
                             * An activatable row's name is a real button, and
                             * the focus indicator draws outside its box; this
                             * cell must not clip it. The button truncates its
                             * own text instead.
                             */
                            "block overflow-visible whitespace-nowrap"
                          : "block overflow-hidden text-ellipsis whitespace-nowrap",
                        /*
                         * The name of the row, at the ordinary weight. The
                         * boards write it in the same 400 as the facts beside
                         * it and let the underline and the column position say
                         * which one names the row.
                         */
                        column === primary && "text-foreground",
                        column.mono === true && "font-mono text-sm",
                        /*
                         * The action cell's own shape, read off the cell it
                         * sits in rather than off a prop this file re-tested.
                         * The class is unconditional and `data-action` decides,
                         * so the attribute is what draws the row's control at
                         * the trailing edge — not a label beside whatever does.
                         */
                        "in-data-[action=true]:flex in-data-[action=true]:items-center",
                        "in-data-[action=true]:justify-center",
                        "in-data-[action=true]:overflow-visible in-data-[action=true]:text-clip",
                        stacks &&
                          column !== primary &&
                          "stacked:min-w-0 stacked:max-w-[70%] stacked:text-right",
                        stacks && "in-data-[action=true]:stacked:max-w-none",
                      )}
                      data-slot="cell"
                    >
                      {column.cell(row)}
                    </span>
                  </TableCell>
                ))}
              </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </TablePanel>

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
