"use client";

import { XIcon } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import type { ComponentProps, ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * The panel that comes in from the right to create, read or edit one thing.
 *
 * **This is the surface the boards choose over a page.** `77F-0` opens a
 * connection in it, `7E0-0` creates an agent in it, and the personas and tests
 * boards do the same with their own records — so a person stays on the list
 * they were reading while they work on one row of it. `DESIGN.md` records that
 * choice for agents, connections, personas and tests.
 *
 * Read off `7CD-0` with `get_computed_styles` on 2026-08-23: anchored to the
 * right edge, 440px wide, full height, Pure Paper behind a neutral hairline on
 * its left edge, the shared orange-brown shadow, a 20px column gap, and no
 * corner. The boards put 28px of padding on it; that is off `DESIGN.md`'s 4px
 * spacing list, so this is the 24px step that is on it — the same rounding the
 * confirm dialog makes.
 *
 * **It is the same Radix dialog the centred one is, and that is the point.**
 * Focus is trapped, the page behind is inert, Escape closes it and the exact
 * control that opened it is focused again afterwards. A hand-rolled drawer
 * loses every one of those quietly. What differs from `dialog.tsx` is where the
 * panel sits and how it arrives, and nothing else.
 *
 * **The motion is not here.** `tailwind-theme.css` keys the entrance, the exit
 * and the reduced-motion form of both on `data-slot` and Radix's `data-state`,
 * exactly as it does for the dialog, the popover and the drawer. The sheet
 * travels from its own edge on the drawer's tokens — 280ms in, 220ms out —
 * because that is the movement `DESIGN.md` gives an edge-attached surface, and
 * under reduced motion it stays put and fades.
 *
 * **`ui/dialog.tsx` also has a `sheet` kind, and the two are not the same
 * thing.** That one is a wide reading surface that deliberately leaves the page
 * behind it usable — the transcript beside its grader results. This one is a
 * modal form. Both are kept, and a caller choosing between them is choosing
 * whether the page behind stays reachable.
 */

function Sheet(props: ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="sheet" {...props} />;
}

function SheetTrigger(props: ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="sheet-trigger" {...props} />;
}

function SheetClose(props: ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="sheet-close" {...props} />;
}

function SheetPortal(props: ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="sheet-portal" {...props} />;
}

function SheetOverlay({
  className,
  ...props
}: ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="sheet-overlay"
      className={cn("fixed inset-0 z-30 bg-scrim", className)}
      {...props}
    />
  );
}

/**
 * The panel.
 *
 * `inset-y-0 right-0` puts it against the edge with no centring shift to be
 * cancelled, so the entrance can be written on `translate` alone. The width is
 * capped at the viewport so a 390px phone gets the whole screen rather than a
 * panel with 50px of scrim beside it.
 */
function SheetContent({
  className,
  children,
  ...props
}: ComponentProps<typeof DialogPrimitive.Content>) {
  return (
    <SheetPortal>
      <SheetOverlay />
      <DialogPrimitive.Content
        data-slot="sheet-content"
        className={cn(
          "fixed inset-y-0 right-0 z-30 flex w-[min(440px,100vw)] flex-col gap-5",
          "border-l border-border bg-surface p-6 text-foreground shadow-modal",
          "outline-none",
          className,
        )}
        {...props}
      >
        {children}
      </DialogPrimitive.Content>
    </SheetPortal>
  );
}

/**
 * The title, and the way out beside it.
 *
 * The close is drawn here rather than positioned over the panel's corner,
 * because that is what the board draws — one row, the title at the left and the
 * ✕ at the right, over the hairline that separates the head from the fields. An
 * absolutely placed close would have to be told the panel's padding, and would
 * be wrong the day the padding moves.
 *
 * It is a 44px target on every pointer. A close is the control somebody reaches
 * for when they have decided they are finished, and it is the one control in
 * the panel that has nothing beside it to catch a near miss.
 */
function SheetHeader({
  className,
  children,
  closeLabel = "Close",
  showCloseButton = true,
  ...props
}: ComponentProps<"div"> & {
  readonly closeLabel?: string;
  readonly showCloseButton?: boolean;
}) {
  return (
    <div
      data-slot="sheet-header"
      className={cn(
        "flex flex-none items-start justify-between gap-3",
        "border-b border-border pb-4",
        className,
      )}
      {...props}
    >
      <div className="flex min-w-0 flex-col gap-1">{children}</div>
      {showCloseButton ? (
        <SheetClose
          className={cn(
            "-mt-1 -mr-1 inline-flex size-(--control-lg) flex-none cursor-pointer",
            "items-center justify-center rounded-button border border-transparent",
            "text-muted-foreground",
            /* Named, so the focus ring is not among them. See `button.tsx`. */
            "transition-[color,background-color] duration-(--duration-hover) ease-out",
            "pointer-hover:bg-surface-soft pointer-hover:text-foreground",
          )}
        >
          <XIcon className="size-4" />
          <span className="sr-only">{closeLabel}</span>
        </SheetClose>
      ) : null}
    </div>
  );
}

/**
 * The lead step at weight 400, which is the size the boards write a sheet's
 * subject at. See `dialog.tsx` for why the size carries the hierarchy here
 * rather than the weight.
 */
function SheetTitle({
  className,
  ...props
}: ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="sheet-title"
      className={cn("m-0 min-w-0 text-lg [overflow-wrap:anywhere]", className)}
      {...props}
    />
  );
}

function SheetDescription({
  className,
  ...props
}: ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="sheet-description"
      className={cn("m-0 text-sm text-muted-foreground", className)}
      {...props}
    />
  );
}

/**
 * The fields.
 *
 * It is the part that scrolls, and it has to be: a sheet is a fixed-height
 * column and the footer below it is the answer. Without `min-h-0` a flex child
 * refuses to shrink below its content, and what would leave the screen is the
 * submit button.
 */
function SheetBody({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="sheet-body"
      className={cn(
        "flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto",
        className,
      )}
      {...props}
    />
  );
}

/**
 * The bottom of the sheet: what this panel is for, the way out of it, and —
 * at the far end — the one destructive thing it offers.
 *
 * The split is the board's (`7DA-0`): submit and cancel together at the left,
 * Delete alone at the right in the failure colour. Putting the destructive
 * action at the other end of the row is what stops it being pressed by
 * somebody aiming for Cancel, and `DESIGN.md` asks for it to be kept apart from
 * the normal save. It is a text action rather than a filled one, because the
 * confirmation it opens is where the filled destructive button lives.
 */
function SheetFooter({
  className,
  children,
  destructive,
  ...props
}: ComponentProps<"div"> & { readonly destructive?: ReactNode }) {
  return (
    <div
      data-slot="sheet-footer"
      className={cn(
        "mt-auto flex flex-none flex-wrap items-center justify-between gap-3",
        className,
      )}
      {...props}
    >
      <div className="flex flex-wrap items-center gap-3">{children}</div>
      {destructive === undefined ? null : (
        <div className="flex items-center">{destructive}</div>
      )}
    </div>
  );
}

export {
  Sheet,
  SheetBody,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetOverlay,
  SheetPortal,
  SheetTitle,
  SheetTrigger,
};
