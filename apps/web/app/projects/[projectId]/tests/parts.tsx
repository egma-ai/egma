"use client";

import { EllipsisVerticalIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Dialog } from "../../../../ui/dialog.tsx";
import { Refused } from "../../../../ui/form.tsx";
import { Menu, MenuItem } from "../../../../ui/menu.tsx";

/**
 * The controls the Tests screens share: the ⋮ that opens a row's menu, the
 * one a page carries for itself, and the confirmation that names what is about
 * to go.
 *
 * They are here rather than in the shared set because two screens use them and
 * both are this route's. If a third area grows the same pair, this is what
 * moves to `apps/web/ui/`.
 */

/**
 * The ⋮ at the end of a row.
 *
 * It draws no box. The lane it sits in is the table's — a fixed 48px slot on
 * every row, header included — so the menus line up in one column and a row
 * with no menu still holds the lane open. What the boards give this control is
 * the dots and nothing else (`8YA-0`, `A3H-0`).
 */
export function RowMenu({
  label,
  children,
}: {
  readonly label: string;
  readonly children: (close: () => void) => ReactNode;
}) {
  return (
    <Menu
      label={label}
      placement="below-end"
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
 * The ⋮ a page carries for itself, beside its other toolbar controls.
 *
 * This one is a control among controls, so it wears the toolbar's square: 36px
 * inside a hairline, the same height as the buttons it stands next to
 * (`9VT-0`).
 */
export function ToolbarMenu({
  label,
  children,
}: {
  readonly label: string;
  readonly children: (close: () => void) => ReactNode;
}) {
  return (
    <Menu
      label={label}
      placement="below-end"
      triggerClassName={cn(
        "inline-flex size-(--control-md) flex-none items-center justify-center",
        "cursor-pointer rounded-button border border-border bg-surface text-foreground",
        "transition-[color,background-color,border-color] duration-(--duration-hover) ease-out",
        "pointer-coarse:min-h-(--tap-target)",
        "pointer-hover:border-border-strong pointer-hover:bg-surface-soft",
        "motion-reduce:transition-none",
      )}
      openClassName="border-border-strong bg-surface-soft"
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

/**
 * The question asked before something is taken away.
 *
 * **It names the thing and it says what survives.** `DESIGN.md` asks a
 * destructive dialog to name the affected test or suite, and the boards give it
 * two lines: what goes, and what the runs that already happened keep. The
 * filled failure-coloured button is the answer and it leads; "Keep it" is the
 * way out beside it.
 */
export function ConfirmDialog({
  title,
  lines,
  confirmLabel,
  busy,
  refusal,
  onConfirm,
  onClose,
}: {
  readonly title: string;
  readonly lines: readonly string[];
  readonly confirmLabel: string;
  readonly busy: boolean;
  readonly refusal: string | null;
  readonly onConfirm: () => void;
  readonly onClose: () => void;
}) {
  return (
    <Dialog title={title} onClose={onClose}>
      {(dismiss) => (
        <div className="flex flex-col gap-5">
          <div className="flex flex-col gap-2">
            {lines.map((line, index) => (
              <p
                className={cn(
                  "m-0 text-sm",
                  index === 0 ? "text-foreground" : "text-muted-foreground",
                )}
                // The lines are prose written above, in order, and have no id.
                // eslint-disable-next-line react/no-array-index-key
                key={index}
              >
                {line}
              </p>
            ))}
          </div>
          {refusal === null ? null : <Refused message={refusal} />}
          <div className="flex flex-wrap items-center gap-3 pt-1">
            <Button
              type="button"
              variant="destructive"
              size="lg"
              busy={busy}
              onClick={onConfirm}
            >
              {busy ? "Deleting…" : confirmLabel}
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="lg"
              disabled={busy}
              onClick={dismiss}
            >
              Keep it
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
