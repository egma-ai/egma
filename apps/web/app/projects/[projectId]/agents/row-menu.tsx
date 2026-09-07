"use client";

import { useId, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/**
 * The ⋮ at the end of a row, and the two or three things it offers.
 *
 * **It lives in the table's own trailing slot**, a fixed 48px lane that every
 * row carries whether or not it has a menu, so the triggers line up in one
 * column down the table (`6ZM-0`). The lane belongs to `ui/data-table.tsx`;
 * what is here is the control that stands in it.
 *
 * **The glyph is drawn rather than borrowed.** The boards draw three filled
 * dots (`71L-0`); every icon in the icon set is line art on a 24 grid, and a
 * ring is not a dot. Three circles is less code than restyling one.
 *
 * **A destructive item a person may not use is disabled and says why, in the
 * menu.** A disabled control takes no focus and answers no hover, so a tooltip
 * on one is a reason only a pointer can reach — and here not even that. The
 * sentence is a line of the panel, and the item names it, which is what makes
 * disabling rather than hiding worth doing.
 */

export function RowMenuGlyph() {
  return (
    <svg
      aria-hidden="true"
      className="size-4"
      fill="currentColor"
      focusable="false"
      viewBox="0 0 14 14"
    >
      <circle cx="7" cy="2.5" r="1.4" />
      <circle cx="7" cy="7" r="1.4" />
      <circle cx="7" cy="11.5" r="1.4" />
    </svg>
  );
}

export function RowMenu({
  label,
  children,
}: {
  /** What this menu is the menu of. Read out where the glyph says nothing. */
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label={label}
          className="text-faint"
          size="icon"
          type="button"
          variant="ghost"
        >
          <RowMenuGlyph />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">{children}</DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Something the row does to itself, drawn as a menu item.
 *
 * `why` is shown rather than hinted, for the reason above the file: a disabled
 * item takes no focus and answers no hover, so a tooltip on one would be a
 * reason nobody can reach.
 */
export function RowMenuItem({
  onSelect,
  why,
  children,
}: {
  readonly onSelect: () => void;
  /** Why this is not available, when it is not. Its presence disables the item. */
  readonly why?: string;
  readonly children: ReactNode;
}) {
  const said = useId();
  const stopped = why !== undefined;

  return (
    <>
      <DropdownMenuItem
        aria-describedby={stopped ? said : undefined}
        disabled={stopped}
        onSelect={onSelect}
      >
        {children}
      </DropdownMenuItem>
      {stopped ? (
        <p className="m-0 px-3 py-1 text-sm leading-(--line-normal) text-faint" id={said}>
          {why}
        </p>
      ) : null}
    </>
  );
}

/**
 * The one destructive thing a row offers, kept under a hairline at the bottom
 * of the panel and never next to the way in.
 *
 * `why` is shown rather than hinted, for the reason above the file.
 */
export function RowMenuDestructive({
  onSelect,
  why,
  children,
}: {
  readonly onSelect: () => void;
  /** Why this is not available, when it is not. Its presence disables the item. */
  readonly why?: string;
  readonly children: ReactNode;
}) {
  const said = useId();
  const stopped = why !== undefined;

  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuItem
        aria-describedby={stopped ? said : undefined}
        disabled={stopped}
        onSelect={onSelect}
        variant="destructive"
      >
        {children}
      </DropdownMenuItem>
      {stopped ? (
        <p className="m-0 px-3 py-1 text-sm leading-(--line-normal) text-faint" id={said}>
          {why}
        </p>
      ) : null}
    </>
  );
}
