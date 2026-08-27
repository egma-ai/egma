import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

/**
 * The table, as the parts the boards draw it from.
 *
 * Read off `6ZM-0`, `71F-0` and `710-0` with `get_computed_styles` on
 * 2026-08-23: a Pure Paper panel inside one neutral hairline with the corners
 * clipped and no corner radius; a 40px header row of quiet 14px labels over a
 * hairline; body rows at least 52px tall with 8px of vertical padding, 16px of
 * side padding and a hairline between them; and a 48px slot at the trailing
 * edge that every row carries whether or not it holds a menu.
 *
 * **`TablePanel` is separate from `Table`, which is where this leaves the
 * registry.** shadcn's `Table` renders its own scrolling wrapper around the
 * `<table>`. This product's table is a *panel* — the border and the surface
 * belong to the frame, not to the element — and the same frame has to carry the
 * container query that makes a narrow table stack. Welding the two together
 * would mean `ui/data-table.tsx` reaching inside a primitive to add a class to
 * a `<div>` it cannot name.
 *
 * Nothing here holds a colour, a size or a radius of its own. The last column's
 * width is `--table-action-width`, declared in `tailwind-theme.css` beside the
 * row heights it lines up with.
 */

/**
 * The edge every column reads from, written once.
 *
 * **A header and the cells under it are one column, so they share one
 * declaration.** Two copies of the same padding are two things that can be
 * changed apart, and a header that drifts off its own figures is the defect
 * this names away. The rule is the wide layout's column alignment: one left
 * edge per lane, header and value on it, in every table.
 *
 * It is exported because one table in the product is not built from these
 * parts — the inline-editing suite grid in `tests/tests-grid.tsx` — and an
 * edge two files declare apart is an edge that drifts. What is still written
 * out by hand is the side padding the two settings tables put back inside
 * their own control cells, where the class list is a caller's rather than
 * this file's, and the stacked row's own copy in `ui/data-table.tsx`, which
 * pads a different layout and cannot drift this one.
 *
 * Two things align some other way, and both are deliberate:
 *
 * - The row's own control lane, centred in a slot of fixed width.
 * - Every non-primary value in the **stacked** layout, which `ui/data-table`
 *   right-aligns against its label. A narrow row is a label-and-value list
 *   rather than a set of columns, so it has no shared edge to keep.
 */
export const LANE_X = "px-(--row-padding-x)";

/** The bordered surface a table is drawn on. */
function TablePanel({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="table-panel"
      className={cn(
        "overflow-x-auto rounded-card border border-border bg-surface",
        className,
      )}
      {...props}
    />
  );
}

function Table({ className, ...props }: ComponentProps<"table">) {
  return (
    <table
      data-slot="table"
      className={cn("w-full border-collapse text-sm", className)}
      {...props}
    />
  );
}

function TableHeader({ className, ...props }: ComponentProps<"thead">) {
  return <thead data-slot="table-header" className={cn(className)} {...props} />;
}

function TableBody({ className, ...props }: ComponentProps<"tbody">) {
  return <tbody data-slot="table-body" className={cn(className)} {...props} />;
}

function TableFooter({ className, ...props }: ComponentProps<"tfoot">) {
  return (
    <tfoot
      data-slot="table-footer"
      className={cn("border-t border-border", className)}
      {...props}
    />
  );
}

function TableRow({ className, ...props }: ComponentProps<"tr">) {
  return <tr data-slot="table-row" className={cn(className)} {...props} />;
}

/**
 * A column's name: quiet, regular weight, and the same 14px the rows are at.
 *
 * `DESIGN.md`: "Headers are quiet, regular-weight labels." The height is fixed
 * rather than a minimum, because a header holds one word and has nothing to
 * grow for.
 */
function TableHead({ className, ...props }: ComponentProps<"th">) {
  return (
    <th
      data-slot="table-head"
      className={cn(
        "h-(--row-height) border-b border-border",
        LANE_X,
        "text-left font-normal whitespace-nowrap text-faint",
        className,
      )}
      {...props}
    />
  );
}

/**
 * One fact in one row.
 *
 * The height is a minimum. A cell holding two connection links and an overflow
 * chip is taller than one holding a date, and a fixed height would either clip
 * it or make every row as tall as the tallest thing any row could hold.
 */
function TableCell({ className, ...props }: ComponentProps<"td">) {
  return (
    <td
      data-slot="table-cell"
      className={cn(
        "border-t border-border align-middle",
        LANE_X,
        "py-(--row-padding-y)",
        className,
      )}
      {...props}
    />
  );
}

function TableCaption({ className, ...props }: ComponentProps<"caption">) {
  return (
    <caption
      data-slot="table-caption"
      className={cn("mt-4 text-sm text-muted-foreground", className)}
      {...props}
    />
  );
}

export {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TablePanel,
  TableRow,
};
