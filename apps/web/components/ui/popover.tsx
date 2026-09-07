"use client";

import { Popover as PopoverPrimitive } from "radix-ui";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

/**
 * A small anchored surface on Pure Paper.
 *
 * It grows from the control that opened it. Radix measures that origin and
 * publishes it as `--radix-popover-content-transform-origin`;
 * `tailwind-theme.css` reads it, so "menus and popovers scale from the trigger
 * origin" is true here without any popover being told about it.
 *
 * **The panel is bounded here rather than by each caller, because Radix
 * publishes the room it has and never uses it.** Radix measures
 * `--radix-popover-content-available-height` on every placement and writes it
 * to the element, and then reads it back nowhere: the string `maxHeight` does
 * not occur in `@radix-ui/react-popper` at all. So a panel is exactly as tall
 * as its content unless somebody says otherwise. `ui/menu.tsx` said so; this
 * file did not, and the agents list found the gap. An agent with enough
 * connections opened a `+N` panel taller than the window, over an
 * `overflow: visible` that gave it no way to scroll, so the rows past the edge
 * could not be reached at all. That is the select picker's fault again, and
 * worse — the picker at least scrolled.
 *
 * So the cap belongs to the primitive. A caller that forgets is the normal
 * case, and forgetting should cost nothing. The value is `ui/menu.tsx`'s own —
 * the room Radix measured, less the theme's smallest step, so the panel keeps
 * a gap off the edge it was pushed against instead of sitting flush on it.
 *
 * `overflow-x` is pinned to `hidden` rather than left alone: a single axis set
 * to `auto` computes the other from `visible` to `auto` as well, which hangs a
 * horizontal scrollbar under a menu that never needed one.
 *
 * **`collisionPadding` is the same gap, on the other axis.** Radix shifts a
 * panel back inside the window when it would overflow, and it shifts it to
 * exactly the edge: the default padding is zero. A 300px panel opened from a
 * column near the right of a 640px screen therefore landed flush, with its last
 * column of text and the underline of its Done touching the window — the same
 * cut-off look the select picker shipped, one axis over. Eight pixels, matching
 * the picker's own margins, so a panel pushed against an edge still reads as a
 * panel.
 */
function Popover(props: ComponentProps<typeof PopoverPrimitive.Root>) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />;
}

function PopoverTrigger(
  props: ComponentProps<typeof PopoverPrimitive.Trigger>,
) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />;
}

function PopoverAnchor(props: ComponentProps<typeof PopoverPrimitive.Anchor>) {
  return <PopoverPrimitive.Anchor data-slot="popover-anchor" {...props} />;
}

function PopoverContent({
  className,
  align = "center",
  sideOffset = 8,
  collisionPadding = 8,
  ...props
}: ComponentProps<typeof PopoverPrimitive.Content>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        data-slot="popover-content"
        align={align}
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        className={cn(
          "z-30 w-72 rounded-card border border-border bg-popover p-4",
          "text-base text-popover-foreground shadow-popover outline-none",
          "max-h-[calc(var(--radix-popover-content-available-height)-var(--space-2))]",
          "overflow-x-hidden overflow-y-auto",
          className,
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
}

export { Popover, PopoverAnchor, PopoverContent, PopoverTrigger };
