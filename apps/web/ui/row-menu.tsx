"use client";

import { EllipsisVerticalIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";
import { Menu, MenuItem } from "./menu.tsx";

/**
 * The ⋮ at the end of a row, and the things it offers.
 *
 * **It lives in the table's own trailing slot** — a fixed
 * `--table-action-width` lane that every row carries whether or not it has a
 * menu — so the triggers line up in one column down the table and a row with no
 * menu still holds the lane open (`6ZM-0`, `8YA-0`, `A3H-0`). The lane belongs
 * to `ui/data-table.tsx`; what is here is the control that stands in it.
 *
 * **It is shared rather than a route's, and the move is the one this pair asked
 * for.** These lived in `app/projects/[projectId]/tests/parts.tsx` while the
 * Tests screens were the only two drawing them, with a note saying they move
 * here as soon as a third area grows the same pair. Runs and Running graders
 * are the third and fourth: both had their acts drawn as buttons inside the
 * cell, which bent the lane out of line — 0px on Runs, where a finished run
 * offers nothing, and 156px on Running graders, where two buttons pushed it
 * open. (2026-08-23.)
 *
 * **The control draws no box.** What the boards give it is the dots and
 * nothing else; the hover fill is the only thing that answers a pointer.
 */
export function RowMenu({
  label,
  onTrigger,
  children,
}: {
  /** What this menu is the menu of. Read out where the glyph says nothing. */
  readonly label: string;
  /** The ⋮ itself, for a row whose item opens something focus must come back from. */
  readonly onTrigger?: (button: HTMLButtonElement | null) => void;
  readonly children: (close: () => void) => ReactNode;
}) {
  return (
    <Menu
      label={label}
      placement="below-end"
      {...(onTrigger === undefined ? {} : { onTrigger })}
      triggerClassName={cn(
        "inline-flex size-(--control-md) items-center justify-center",
        "cursor-pointer rounded-button border border-transparent bg-transparent text-faint",
        "transition-[color,background-color] duration-(--duration-hover) ease-out",
        "pointer-coarse:size-(--tap-target)",
        "pointer-hover:bg-surface-soft pointer-hover:text-foreground",
        "motion-reduce:transition-none",
      )}
      openClassName="bg-surface-soft text-foreground"
      trigger={
        <EllipsisVerticalIcon className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
      }
    >
      {children}
    </Menu>
  );
}

/**
 * The one item in a menu that takes something away.
 *
 * It is the failure colour and it is last, under a divider. The press does not
 * delete anything: it opens the confirmation that names what would go.
 */
export function DestructiveItem({
  disabled,
  onClick,
  children,
}: {
  readonly disabled?: boolean;
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <MenuItem disabled={disabled} onClick={onClick}>
      <span className="text-failure">{children}</span>
    </MenuItem>
  );
}

/**
 * Why a menu offers nothing this person may press.
 *
 * A disabled item cannot take focus, so a `title` on it is a reason only a
 * pointer reaches. The sentence is drawn in the panel instead, where a keyboard
 * lands on it and a screen reader reads it with the items above.
 */
export function MenuReason({ children }: { readonly children: ReactNode }) {
  return (
    <p className="m-0 max-w-[36ch] px-3 py-2 text-sm text-muted-foreground">
      {children}
    </p>
  );
}
