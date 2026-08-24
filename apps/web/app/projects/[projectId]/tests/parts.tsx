"use client";

import { EllipsisVerticalIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Dialog } from "../../../../ui/dialog.tsx";
import { Refused } from "../../../../ui/form.tsx";
import { Menu } from "../../../../ui/menu.tsx";

/**
 * The controls the Tests screens share: the ⋮ a page carries for itself, and
 * the confirmation that names what is about to go.
 *
 * They are here rather than in the shared set because two screens use them and
 * both are this route's — the promise this file made was that the pair moves to
 * `apps/web/ui/` as soon as a third area grows it. Runs and Running graders did,
 * so the row's own ⋮ and the two panel parts that go with it left on
 * 2026-08-23 and are now `ui/row-menu.tsx`. What is left is the toolbar's ⋮,
 * which no other area draws, and the confirmation these three screens share.
 */

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
