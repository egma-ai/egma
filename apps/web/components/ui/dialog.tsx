"use client";

import { XIcon } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

/**
 * The centered modal layer.
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
  ...props
}: ComponentProps<typeof DialogPrimitive.Content> & {
  readonly showCloseButton?: boolean;
}) {
  return (
    <DialogPortal>
      <DialogOverlay />
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
          "flex w-[min(420px,calc(100vw-40px))] flex-col gap-5",
          "rounded-card border border-border bg-surface p-5 text-foreground shadow-modal",
          className,
        )}
        {...props}
      >
        {children}
        {showCloseButton ? (
          <DialogPrimitive.Close
            data-slot="dialog-close"
            className={cn(
              "absolute top-4 right-4 inline-flex size-8 cursor-pointer items-center justify-center",
              "rounded-button border border-transparent text-muted-foreground",
              "transition-colors duration-(--duration-hover) ease-out",
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

function DialogHeader({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex flex-col gap-2", className)}
      {...props}
    />
  );
}

function DialogFooter({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn("flex flex-wrap justify-end gap-3", className)}
      {...props}
    />
  );
}

/* Weight 500, which `DESIGN.md` reserves for titles that need the hierarchy. */
function DialogTitle({
  className,
  ...props
}: ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn("m-0 pr-8 text-base font-medium", className)}
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
