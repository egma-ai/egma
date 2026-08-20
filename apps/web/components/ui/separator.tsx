"use client";

import { Separator as SeparatorPrimitive } from "radix-ui";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

/**
 * The neutral hairline that puts two groups of content apart.
 *
 * `DESIGN.md`: "Most structure comes from contrast and borders." A rule drawn
 * with this rather than with a `border-b` on whichever element happens to be
 * next to it says the line is a thing *between* two groups, so neither group
 * carries the other's boundary.
 *
 * **It defaults to decorative, and that default is the honest one.** A rule is
 * usually drawn because two groups look better apart, not because a reader who
 * cannot see it is missing a fact — and Radix publishes a decorative separator
 * as `role="none"`, so a screen reader is not told about a line that means
 * nothing. A separator that *does* carry meaning says `decorative={false}` and
 * becomes a real `role="separator"`.
 *
 * **Reach for a border instead when the rule changes edge with the viewport.**
 * Orientation here is a DOM attribute, so a rule that is horizontal in a column
 * and vertical once the same two groups sit side by side cannot be one element
 * — it would need a class to beat `data-[orientation=…]` at a width, and that
 * is a specificity race rather than a layout. `settings-nav.tsx` has exactly
 * that rule and keeps it as a border for this reason.
 */
function Separator({
  className,
  orientation = "horizontal",
  decorative = true,
  ...props
}: ComponentProps<typeof SeparatorPrimitive.Root>) {
  return (
    <SeparatorPrimitive.Root
      data-slot="separator"
      decorative={decorative}
      orientation={orientation}
      className={cn(
        "shrink-0 bg-border",
        "data-[orientation=horizontal]:h-px data-[orientation=horizontal]:w-full",
        "data-[orientation=vertical]:h-full data-[orientation=vertical]:w-px",
        className,
      )}
      {...props}
    />
  );
}

export { Separator };
