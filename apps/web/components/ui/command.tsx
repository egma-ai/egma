"use client";

import { Command as CommandPrimitive } from "cmdk";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

/**
 * A list somebody types to narrow, and the rows it narrows to.
 *
 * **This is the kit's combobox, and what it buys is the keyboard.** The product
 * already had a search-and-tick panel — the tests grid's persona picker — built
 * by hand: a text field, a `.filter()`, and a column of checkboxes. It worked
 * with a mouse and it was a wall to anybody driving with a keyboard, because
 * every row was its own Tab stop and nothing linked the field to the list it
 * was narrowing. `cmdk` owns that relationship: the field keeps focus, the
 * arrow keys walk the filtered rows underneath it, and the active row is
 * published as `aria-activedescendant` so a screen reader is told which row the
 * typing is pointing at.
 *
 * **`role` here is `listbox`, not `menu`.** `ui/menu.tsx` says why in its own
 * words — a panel with something to type in is not a list of commands — and the
 * same rule decides this file. `cmdk` writes the listbox and option roles, and
 * the panel around it is a `dialog`, which is what `PopoverContent` is given.
 *
 * **Filtering stays with the caller.** `shouldFilter` is off, because the one
 * list this draws is narrowed against the server's own page-by-page read and a
 * second, hidden filter inside the widget would disagree with the count the
 * panel prints. The rows handed in are the rows drawn.
 *
 * No `CommandDialog` here. shadcn ships one for a page-wide palette; this
 * product has no such surface, and an export nothing renders is a component
 * that rots.
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
 * One row.
 *
 * The highlight is `data-[selected=true]`, which is `cmdk`'s word for "the row
 * the arrow keys are on" and not for "the row somebody ticked". A multi-select
 * has both states at once, so they are drawn by different things: the pointer
 * and keyboard highlight is this background, and whether a row is chosen is
 * said by `aria-checked`, which `role="option"` supports and which `cmdk` does
 * not touch. Reading the highlight as the answer is the mistake this comment
 * exists to stop, and the reason a caller ticking rows must set `aria-checked`
 * itself: a checkbox drawn inside the row is a picture, and the row is the
 * control a screen reader is on.
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
