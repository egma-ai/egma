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
 * **The frame is the kit's `Table`, and the numbers are the boards'.** A Pure
 * Paper panel inside one hairline with no corner; a 40px header of quiet
 * labels; rows at least 52px with a hairline between them and none after the
 * last; and a fixed 48px slot at the trailing edge that every row carries, so
 * the ⋮ menus line up in one lane down the table whether or not a given row
 * has one. Read off `6ZM-0`, `71F-0` and `710-0` on 2026-08-23. The lane is a
 * floor as well as a width — see `floorOf`, which is what stopped a crowded
 * table squeezing it.
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
  /**
   * Numbers read from their right edge, so a column of them may say so. The
   * header moves with its values: a label left on the other edge of the lane
   * floats away from the figures it names.
   */
  readonly align?: "end";
  /** A row control. It stays at the trailing edge in both table layouts. */
  readonly action?: boolean;
  /**
   * How wide this column is, when the boards say.
   *
   * **It is a real width, not a hint, and that was worth measuring.** The table
   * lays out `auto`, where a declared width is only a preference — but every
   * cell's content is clipped to one line, so a column's own minimum is its
   * padding and nothing pushes back. A browser then gives the widths that were
   * asked for and hands the slack to the columns that asked for none.
   *
   * Measured at 1440 on 2026-08-23, against `6ZM-0` and `8XV-0`: the agents
   * list lands 260 / 160 / 360 with Created taking the 338 left over, and
   * personas lands 260 / 140 / 110 / 90 / 130 with Description taking the
   * slack. Both are the boards, to the pixel. So `table-fixed` is not needed,
   * and a list that wants the boards' proportions only has to say them.
   *
   * A row control's slot is not a caller's to set: see `widthOf`.
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
   * Makes the whole row a pointer target for one action that opens in place —
   * a sheet, not a URL. `stretchPrimaryLink` is for rows whose name is a real
   * link; this is for rows whose name is a real button. The row answers the
   * pointer and lights up under it with the evidence surface's own hover mix;
   * the keyboard path stays the primary cell's button, so the accessibility
   * tree still holds exactly one control for the one action. A click that
   * lands on a control inside the row — the ⋮ menu, the name button itself —
   * is that control's, not the row's.
   */
  readonly onRowActivate?: (row: Row) => void;
  /**
   * The row whose record is open in the sheet beside the list.
   *
   * **It is the light grey soft surface, not Ember Wash.** `DESIGN.md` gives
   * an open row the wash, and the developer replaced it for this state on
   * 2026-08-25 on the Paper canvas — "remove orange hover, I would prefer a
   * light grey" — because the wash is the primary action's own fill and a row
   * wearing it reads as something to press rather than something already open.
   * The design source of truth records the change after the founders' sync;
   * until then this comment is where it is written down.
   *
   * The colour is not the whole of the state: the row also carries
   * `aria-current`, so a reader who cannot see the grey is still told which
   * row the open sheet belongs to.
   */
  readonly currentKey?: string;
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
  /**
   * How wide a column is, and the one width this component decides for itself.
   *
   * A row control's slot is the theme's, not the caller's: it is what makes
   * the trailing lane straight, and a page choosing its own would bend it. A
   * caller may still say `width` on any other column.
   *
   * It is written on the header cell alone. A column width set there governs
   * the whole column, and a width on the body cells as well would survive into
   * the stacked layout — where the cells are no longer a table and a 48px
   * "column" is a 48px box with a menu falling out of it.
   */
  function widthOf(column: Column<Row>): string | undefined {
    if (column.action === true) return "var(--table-action-width)";
    return column.width;
  }
  /**
   * The one width that is a floor rather than a preference.
   *
   * **A declared width on a table is a request, and an over-constrained table
   * refuses it.** The layout is `auto`, so when the columns' own minimums add
   * up to more than the table has — which every list with a long name in it
   * reaches — a browser takes the shortfall out of the columns that can give
   * it, and the trailing lane gives most: its content is one 36px glyph, or on
   * a row with no control, nothing at all. That is how the same 48px
   * declaration measured 48 on Agents, 40 on Personas and 0 on Runs.
   *
   * `min-width` is what the lane cannot be argued out of. It is written beside
   * the width, on the header cell alone and for the same reason.
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
    return hiddenWhenStacked(column) ? "true" : undefined;
  }

  return (
    <div className={stackWhenConstrained ? "@container/data-table" : undefined}>
      <TablePanel
        className={cn(
          /* Stacked rows are not a scrolling region; they are the page. */
          "stacked:overflow-visible",
        )}
      >
        <Table className="stacked:block" aria-label={label}>
          {/*
           * The headers are read out in both layouts and drawn in one. Stacked
           * rows carry their own label on each cell, so a visible header row
           * would be the same word twice.
           */}
          <TableHeader className="stacked:sr-only">
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
                    hiddenWhenStacked(column) && "stacked:hidden",
                    column.align === "end" && "text-right",
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
          <TableBody className="stacked:block">
            {rows.map((row) => {
              const current =
                currentKey !== undefined && keyOf(row) === currentKey;
              return (
              <TableRow
                aria-current={current ? "true" : undefined}
                className={cn(
                  "[&:first-child>td]:border-t-0",
                  "stacked:flex stacked:flex-col stacked:gap-1",
                  "stacked:border-t stacked:border-border stacked:px-(--row-padding-x) stacked:py-3",
                  "stacked:first:border-t-0",
                  onRowActivate !== undefined && [
                    "cursor-pointer transition-colors duration-(--duration-hover) ease-out",
                    "motion-reduce:transition-none",
                  ],
                  /*
                   * The open row keeps its grey under the pointer. The hover
                   * mix is a lighter wash of the same colour, so letting it
                   * apply here would make the one row somebody is pointing at
                   * *and* has open the palest row in the table.
                   */
                  current
                    ? "bg-surface-soft"
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
                        onRowActivate(row);
                      }
                }
              >
                {columns.map((column) => (
                  <TableCell
                    className={cn(
                      "h-(--row-min-height) text-muted-foreground",
                      "data-[action=true]:px-0 data-[action=true]:text-center",
                      /*
                       * **A column the narrow layout omits takes the stacked
                       * layout's `display` and nothing else.** Writing the two
                       * as separate rules — `stacked:flex` for every cell and
                       * `max-[900px]:hidden` for this one — put two `display`
                       * declarations of equal weight under one query, and the
                       * one Tailwind happened to emit last won. It was `flex`,
                       * so `hideOnMobile` hid nothing on a phone: the personas
                       * list still drew Description and Version, and the
                       * agents list still drew Created.
                       *
                       * There is no rule to outrank now, and the second half
                       * is the same fix: the omission follows `stacked`, so a
                       * table that stacks because its own container is narrow
                       * omits the same columns a phone does. `hideOnMobile`
                       * has always meant "the narrow layout may leave this
                       * out", and `stacked` is what "narrow layout" means.
                       */
                      hiddenWhenStacked(column)
                        ? "stacked:hidden"
                        : [
                            "stacked:flex stacked:h-auto stacked:min-h-0 stacked:items-baseline",
                            "stacked:justify-between stacked:gap-3 stacked:border-0 stacked:p-0",
                          ],
                      column === primary
                        ? "stacked:mb-1"
                        : column.action === true
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
                    )}
                    data-action={column.action === true ? "true" : undefined}
                    data-label={column.header}
                    data-mobile-hidden={mobileHidden(column)}
                    data-primary={column === primary ? "true" : undefined}
                    key={column.key}
                  >
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
                        /* The values' edge, which the header cell above shares. */
                        column.align === "end" && "text-right",
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
                        column !== primary &&
                          "stacked:min-w-0 stacked:max-w-[70%] stacked:text-right",
                        "in-data-[action=true]:stacked:max-w-none",
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
