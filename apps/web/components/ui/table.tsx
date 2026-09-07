import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

/**
 * Separate TablePanel from Table so the frame owns surface, scrolling, and
 * container queries. Shared tokens define row sizing, padding, and action width.
 */

/**
 * Share the header/body column edge with the test grid. Action columns and
 * stacked label/value rows use their own alignment rules.
 */
export const LANE_X = "px-(--row-padding-x)";

/** The bordered surface a table is drawn on. */
function TablePanel({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="table-panel"
      className={cn(
        "relative w-full min-w-0 max-w-full overflow-x-auto rounded-card border border-border bg-surface",
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
