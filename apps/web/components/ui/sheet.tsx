"use client";

import { XIcon } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import {
  createContext,
  useContext,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";

import { cn } from "@/lib/utils";

/**
 * Modal form sheet anchored to the right with shared dialog behavior and
 * theme-owned motion. Use ui/dialog's nonmodal sheet for adjacent reading views.
 *
 * Portal to the product page's SheetHost inside main, with body as the fallback.
 * This keeps form content within the page landmark while fixed positioning
 * lets the overlay cover the viewport.
 */

/**
 * Where a sheet's panel is put, published by the product page that owns it.
 *
 * It is state rather than a ref because a portal target has to exist *before*
 * the portal renders into it, and a ref does not tell React that it now does.
 * The callback ref below sets state, the host renders a second time, and the
 * value the context carries on that pass is a real element.
 */
const SheetRootContext = createContext<HTMLElement | null>(null);

/**
 * One product page's sheet container, drawn last inside its `<main>`.
 *
 * It draws nothing: no size, no padding, nothing that could take a line of the
 * page's own layout. What it is, is an address.
 */
function SheetHost({ children }: { readonly children: ReactNode }) {
  const [root, setRoot] = useState<HTMLElement | null>(null);

  return (
    <SheetRootContext.Provider value={root}>
      {children}
      <div data-slot="sheet-root" ref={setRoot} />
    </SheetRootContext.Provider>
  );
}

function Sheet(props: ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="sheet" {...props} />;
}

function SheetTrigger(props: ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="sheet-trigger" {...props} />;
}

function SheetClose(props: ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="sheet-close" {...props} />;
}

/**
 * Use the nearest page sheet host, falling back to Radix's body portal when
 * none exists. An explicit caller container takes precedence.
 */
function SheetPortal(props: ComponentProps<typeof DialogPrimitive.Portal>) {
  const root = useContext(SheetRootContext);

  return (
    <DialogPrimitive.Portal
      data-slot="sheet-portal"
      container={root ?? undefined}
      {...props}
    />
  );
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
  size = "default",
  ...props
}: ComponentProps<typeof DialogPrimitive.Content> & {
  /**
   * How much room the panel needs. `default` is the boards' 440px form panel;
   * `wide` is the 640px reading panel, for a surface whose content is evidence
   * rather than fields. Both widths are theme values.
   */
  readonly size?: "default" | "wide";
}) {
  return (
    <SheetPortal>
      <SheetOverlay />
      <DialogPrimitive.Content
        data-slot="sheet-content"
        data-size={size}
        className={cn(
          "fixed inset-y-0 right-0 z-30 flex w-[min(var(--sheet-width),100vw)] flex-col gap-5",
          size === "wide" && "w-[min(var(--sheet-width-wide),100vw)]",
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
 * Place title and close control in one header row so padding changes keep
 * them aligned. Preserve the close control's full tap target.
 */
function SheetHeader({
  className,
  children,
  actions,
  closeLabel = "Close",
  showCloseButton = true,
  ...props
}: ComponentProps<"div"> & {
  /**
   * The panel's own controls, drawn on the title's line beside the close.
   *
   * A sheet that manages a record carries a ⋮ for it, and the boards draw that
   * ⋮ in the head next to the ✕ rather than under the name. Passed here instead
   * of as a child because the children are the title column: anything put there
   * lands on a line of its own below the name, which is what it looked like.
   */
  readonly actions?: ReactNode;
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
      {actions === undefined && !showCloseButton ? null : (
        <div className="-mt-1 -mr-1 flex flex-none items-center gap-1">
          {actions}
          {showCloseButton ? (
            <SheetClose
              className={cn(
                "inline-flex size-(--control-lg) flex-none cursor-pointer",
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
      )}
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
 * Keep submit and cancel together, with destructive actions separated at
 * the opposite edge. Destructive confirmation is handled by the caller.
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
  SheetHost,
  SheetOverlay,
  SheetPortal,
  SheetTitle,
  SheetTrigger,
};
