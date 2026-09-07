"use client";

import { CheckIcon, ChevronRightIcon } from "lucide-react";
import { DropdownMenu as DropdownMenuPrimitive } from "radix-ui";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

/**
 * The menu, on Pure Paper with the shared orange-brown shadow.
 *
 * Two things here are `DESIGN.md` rather than shadcn. The highlighted item — the
 * one under the pointer or the arrow keys — uses the quiet neutral mix, because
 * that is a hover and not a selection. A *selected* item, the one that is
 * currently true, uses Ember Wash and a mark beside it, because "the active item
 * uses Ember Wash and a small Ember mark" and because state is never colour
 * alone. shadcn spends one colour on both and would have said "hovered" and
 * "chosen" the same way.
 *
 * Items are 36px, which is what the boards draw (`9AH-0`), and 44px wherever
 * the pointer is coarse — the same trade every dense control in this product
 * makes. The panel holds them on 4px of padding.
 *
 * The transitions name their properties. `transition-colors` would include
 * `outline-color`, and an item reached with the arrow keys would then fade its
 * focus ring in rather than showing it — motion on keyboard navigation, which
 * `DESIGN.md` forbids.
 */
function DropdownMenu(
  props: ComponentProps<typeof DropdownMenuPrimitive.Root>,
) {
  return <DropdownMenuPrimitive.Root data-slot="dropdown-menu" {...props} />;
}

function DropdownMenuTrigger(
  props: ComponentProps<typeof DropdownMenuPrimitive.Trigger>,
) {
  return (
    <DropdownMenuPrimitive.Trigger data-slot="dropdown-menu-trigger" {...props} />
  );
}

function DropdownMenuGroup(
  props: ComponentProps<typeof DropdownMenuPrimitive.Group>,
) {
  return (
    <DropdownMenuPrimitive.Group data-slot="dropdown-menu-group" {...props} />
  );
}

function DropdownMenuContent({
  className,
  sideOffset = 8,
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.Content>) {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        data-slot="dropdown-menu-content"
        sideOffset={sideOffset}
        className={cn(
          "z-30 min-w-56 rounded-card border border-border bg-popover p-1",
          "text-popover-foreground shadow-popover outline-none",
          /* Bounded for the same reason `popover.tsx` is; see the note there. */
          "max-h-[calc(var(--radix-dropdown-menu-content-available-height)-var(--space-2))]",
          "overflow-x-hidden overflow-y-auto",
          className,
        )}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  );
}

/*
 * `inset` indents an item so it lines up with the items that carry a mark.
 * `variant="destructive"` is the failure colour, and the confirmation it needs
 * belongs to whatever the item opens.
 */
function DropdownMenuItem({
  className,
  inset,
  variant = "default",
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.Item> & {
  readonly inset?: boolean;
  readonly variant?: "default" | "destructive";
}) {
  return (
    <DropdownMenuPrimitive.Item
      data-slot="dropdown-menu-item"
      data-inset={inset}
      data-variant={variant}
      className={cn(
        "relative flex min-h-(--control-md) cursor-pointer items-center gap-2 rounded-button px-3",
        "pointer-coarse:min-h-(--tap-target)",
        "text-sm outline-none select-none",
        "transition-[color,background-color] duration-(--duration-hover) ease-out",
        "data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground",
        "data-[disabled]:pointer-events-none data-[disabled]:opacity-55",
        "data-[inset]:pl-8",
        "data-[variant=destructive]:text-failure",
        "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    />
  );
}

/*
 * Selected, not merely highlighted: Ember Wash plus the check. The check is the
 * non-colour half of the state, and it is why this is not a colour swap.
 */
function DropdownMenuCheckboxItem({
  className,
  children,
  checked,
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.CheckboxItem>) {
  return (
    <DropdownMenuPrimitive.CheckboxItem
      data-slot="dropdown-menu-checkbox-item"
      checked={checked}
      className={cn(
        "relative flex min-h-(--control-md) cursor-pointer items-center gap-2 rounded-button py-2 pr-3 pl-8",
        "pointer-coarse:min-h-(--tap-target)",
        "text-sm outline-none select-none",
        "transition-[color,background-color] duration-(--duration-hover) ease-out",
        "data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground",
        "data-[state=checked]:bg-selected data-[state=checked]:text-selected-foreground",
        "data-[disabled]:pointer-events-none data-[disabled]:opacity-55",
        className,
      )}
      {...props}
    >
      <span className="pointer-events-none absolute left-3 flex size-4 items-center justify-center text-brand">
        <DropdownMenuPrimitive.ItemIndicator>
          <CheckIcon className="size-4" />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </DropdownMenuPrimitive.CheckboxItem>
  );
}

function DropdownMenuLabel({
  className,
  inset,
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.Label> & {
  readonly inset?: boolean;
}) {
  return (
    <DropdownMenuPrimitive.Label
      data-slot="dropdown-menu-label"
      data-inset={inset}
      className={cn(
        "px-3 py-2 text-sm tracking-(--tracking-label) text-muted-foreground uppercase",
        "data-[inset]:pl-8",
        className,
      )}
      {...props}
    />
  );
}

function DropdownMenuSeparator({
  className,
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.Separator>) {
  return (
    <DropdownMenuPrimitive.Separator
      data-slot="dropdown-menu-separator"
      className={cn("-mx-1 my-1 h-px bg-border", className)}
      {...props}
    />
  );
}

function DropdownMenuShortcut({ className, ...props }: ComponentProps<"span">) {
  return (
    <span
      data-slot="dropdown-menu-shortcut"
      className={cn("ml-auto font-mono text-sm text-muted-foreground", className)}
      {...props}
    />
  );
}

function DropdownMenuSub(
  props: ComponentProps<typeof DropdownMenuPrimitive.Sub>,
) {
  return <DropdownMenuPrimitive.Sub data-slot="dropdown-menu-sub" {...props} />;
}

function DropdownMenuSubTrigger({
  className,
  inset,
  children,
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.SubTrigger> & {
  readonly inset?: boolean;
}) {
  return (
    <DropdownMenuPrimitive.SubTrigger
      data-slot="dropdown-menu-sub-trigger"
      data-inset={inset}
      className={cn(
        "flex min-h-(--control-md) cursor-pointer items-center gap-2 rounded-button px-3",
        "pointer-coarse:min-h-(--tap-target)",
        "text-sm outline-none select-none",
        "transition-[color,background-color] duration-(--duration-hover) ease-out",
        "data-[highlighted]:bg-accent data-[state=open]:bg-accent",
        "data-[inset]:pl-8",
        className,
      )}
      {...props}
    >
      {children}
      <ChevronRightIcon className="ml-auto size-4" />
    </DropdownMenuPrimitive.SubTrigger>
  );
}

function DropdownMenuSubContent({
  className,
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.SubContent>) {
  return (
    <DropdownMenuPrimitive.SubContent
      data-slot="dropdown-menu-sub-content"
      className={cn(
        "z-30 min-w-40 rounded-card border border-border bg-popover p-1",
        "text-popover-foreground shadow-popover outline-none",
        "max-h-[calc(var(--radix-dropdown-menu-content-available-height)-var(--space-2))]",
        "overflow-x-hidden overflow-y-auto",
        className,
      )}
      {...props}
    />
  );
}

export {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
};
