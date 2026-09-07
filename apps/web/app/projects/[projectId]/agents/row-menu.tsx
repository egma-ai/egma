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
 * Use the table's trailing action slot so row menus align. Render unavailable
 * actions disabled and associate them with an explanation inside the menu.
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
