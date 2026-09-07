"use client";

import { XIcon } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

/**
 * The centered modal layer, drawn the way the confirm boards draw it.
 *
 * 480px wide, 24px of padding, a 20px column gap, the shared orange-brown
 * shadow over a neutral hairline and no corner at all — read off `BEM-0` and
 * `BMT-0` with `get_computed_styles` on 2026-08-23. The header is a title with
 * a close beside it over a hairline; the footer is the answer and the way out,
 * in that order, at the left. The boards put 28px of padding on the panel and
 * this is 24: 28px is off `DESIGN.md`'s 4px spacing list, and the ticket rounds
 * it to the step that is on it.
 *
 * Radix supplies what `DESIGN.md` requires of a dialog and a hand-written one
 * keeps getting wrong: focus is trapped, the page behind it is inert, Escape
 * closes it, and the exact opener is focused again afterwards.
 *
 * The entrance and the exit are not here. They are in `tailwind-theme.css`,
 * keyed on `data-slot` and `data-state`, so the motion is a property of the
 * theme rather than a class list each dialog has to remember — and so the exit
 * is a CSS animation, which is what Radix waits for before unmounting.
 *
 * A destructive dialog still has to name the agent, test, persona, grader, key,
 * invitation, run, or project it is about. No component can do that for it.
 */
function Dialog(props: ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

function DialogTrigger(props: ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

function DialogPortal(props: ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />;
}

function DialogClose(props: ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

function DialogOverlay({
  className,
  ...props
}: ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn("fixed inset-0 z-30 bg-scrim", className)}
      {...props}
    />
  );
}

function DialogContent({
  className,
  children,
  showCloseButton = true,
  showOverlay = true,
  ...props
}: ComponentProps<typeof DialogPrimitive.Content> & {
  readonly showCloseButton?: boolean;
  readonly showOverlay?: boolean;
}) {
  return (
    <DialogPortal>
      {showOverlay ? <DialogOverlay /> : null}
      {/*
       * The panel is centred by `-translate-x-1/2 -translate-y-1/2`, which
       * Tailwind puts on the `translate` property. Keep it there. The theme
       * animates the dialog on `scale`, so position and motion never share a
       * property; centring rewritten as a `transform` would be cancelled by
       * the animation for as long as it runs. `tailwind-theme.css` says the
       * same thing from the other side.
       */}
      <DialogPrimitive.Content
        data-slot="dialog-content"
        className={cn(
          "fixed top-1/2 left-1/2 z-30 -translate-x-1/2 -translate-y-1/2",
          "flex w-[min(var(--dialog-width),calc(100vw-var(--space-8)))] flex-col gap-5",
          "rounded-card border border-border bg-surface p-6 text-foreground shadow-modal",
          className,
        )}
        {...props}
      >
        {children}
        {showCloseButton ? (
          <DialogPrimitive.Close
            data-slot="dialog-close"
            className={cn(
              "absolute top-6 right-6 inline-flex size-8 cursor-pointer items-center justify-center",
              "rounded-button border border-transparent text-muted-foreground",
              /* "Pointer targets are at least 44px on coarse pointers." */
              "pointer-coarse:size-(--tap-target)",
              /*
               * Named, so the focus ring is not among them. See `button.tsx`.
               * Only the two this hover actually changes: the border stays
               * transparent throughout, so naming it would be decoration.
               */
              "transition-[color,background-color] duration-(--duration-hover) ease-out",
              "pointer-hover:bg-surface-soft pointer-hover:text-foreground",
            )}
          >
            <XIcon className="size-4" />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        ) : null}
      </DialogPrimitive.Content>
    </DialogPortal>
  );
}

/**
 * The head of a dialog, and the hairline the boards draw under it.
 *
 * `BK0-0` measures 16px of padding under the title and a 1px `--border` rule
 * across the panel's inner width — the same on `BEM-0`, `BMT-0` and `C8F-0`.
 * Nothing here drew it, and no caller could add it (`ui/dialog.tsx` takes no
 * class for its head), so one screen reached for a `Separator` as the panel's
 * first child instead. It belongs on the head, once.
 *
 * A column rather than the board's row: the close control is placed by
 * `DialogContent`, against the panel, so that a head with two lines in it does
 * not move the ✕ down the corner.
 */
function DialogHeader({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn(
        "flex flex-col gap-2 border-b border-border pb-4",
        className,
      )}
      {...props}
    />
  );
}

function DialogFooter({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-footer"
      /*
       * The answer leads and the way out follows it, both at the left edge —
       * which is what `BEM-0` draws and the reverse of shadcn's default. A
       * destructive footer also carries a third thing at the right end; that
       * is the caller's, and `justify-between` on the caller's own class list
       * is what puts it there.
       */
      className={cn("flex flex-wrap items-center gap-3", className)}
      {...props}
    />
  );
}

/*
 * The lead step, at weight 400.
 *
 * The boards write a dialog's question at 24px in the ordinary weight rather
 * than at 16px in weight 500: the size is the hierarchy, which is what
 * `DESIGN.md` asks for first ("hierarchy comes from size, space, and
 * restrained use of weight 500").
 */
function DialogTitle({
  className,
  ...props
}: ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn("m-0 pr-8 text-lg", className)}
      {...props}
    />
  );
}

function DialogDescription({
  className,
  ...props
}: ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn("m-0 text-sm text-muted-foreground", className)}
      {...props}
    />
  );
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
};
