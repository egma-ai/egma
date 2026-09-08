"use client";

import { Command as CommandPrimitive } from "cmdk";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

/**
 * Use cmdk for combobox/listbox relationships and keyboard selection. Disable
 * its internal filter because callers supply server-filtered rows; filtering
 * again could hide results without changing the displayed count.
 */
function Command({
  className,
  ...props
}: ComponentProps<typeof CommandPrimitive>) {
  return (
    <CommandPrimitive
      data-slot="command"
      shouldFilter={false}
      className={cn("flex w-full flex-col overflow-hidden", className)}
      {...props}
    />
  );
}

/**
 * The field the list narrows to.
 *
 * It wears the quiet dress the grid's own cells wear rather than `Input`'s
 * bordered box: this sits on the panel's own hairline, and a second border
 * inside it reads as a field within a field. Focus is still `globals.css`'s,
 * which no class here can turn off.
 */
function CommandInput({
  className,
  ...props
}: ComponentProps<typeof CommandPrimitive.Input>) {
  return (
    <div className="border-b border-border px-2.5" data-slot="command-input-row">
      <CommandPrimitive.Input
        data-slot="command-input"
        className={cn(
          "h-9 w-full border-0 bg-transparent p-0 text-sm text-foreground",
          "leading-(--line-caption) outline-none placeholder:text-faint",
          className,
        )}
        {...props}
      />
    </div>
  );
}

/** The rows, bounded and scrolling, because a project's people are not a few. */
function CommandList({
  className,
  ...props
}: ComponentProps<typeof CommandPrimitive.List>) {
  return (
    <CommandPrimitive.List
      data-slot="command-list"
      className={cn("max-h-60 overflow-x-hidden overflow-y-auto", className)}
      {...props}
    />
  );
}

function CommandGroup({
  className,
  ...props
}: ComponentProps<typeof CommandPrimitive.Group>) {
  return (
    <CommandPrimitive.Group
      data-slot="command-group"
      className={cn("p-0", className)}
      {...props}
    />
  );
}

/**
 * cmdk selected state is the active keyboard/pointer row, not multi-selection.
 * Callers must set aria-checked for chosen options independently of the highlight.
 */
function CommandItem({
  className,
  ...props
}: ComponentProps<typeof CommandPrimitive.Item>) {
  return (
    <CommandPrimitive.Item
      data-slot="command-item"
      className={cn(
        "flex min-h-9 cursor-pointer items-center gap-2.5 px-2.5",
        "text-sm text-foreground outline-none",
        "pointer-coarse:min-h-(--tap-target)",
        "data-[selected=true]:bg-surface-soft",
        "data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-60",
        className,
      )}
      {...props}
    />
  );
}

export { Command, CommandGroup, CommandInput, CommandItem, CommandList };
