"use client";

import { EllipsisVerticalIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";
import { Menu, MenuItem } from "./menu.tsx";

/**
 * Shared row actions placed in the data table's trailing slot. Keep the
 * trigger compact and let the table own column alignment.
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
