"use client";

import { Collapsible as CollapsiblePrimitive } from "radix-ui";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

/**
 * Use Radix for the open state, the trigger's `aria-expanded`, and the panel
 * the trigger names. The section keeps the product's shape: no radius, and a
 * hairline where one is needed, drawn by the caller.
 */
function Collapsible({
  className,
  ...props
}: ComponentProps<typeof CollapsiblePrimitive.Root>) {
  return (
    <CollapsiblePrimitive.Root
      data-slot="collapsible"
      className={cn("min-w-0", className)}
      {...props}
    />
  );
}

/**
 * The row that opens and closes the panel.
 *
 * A chevron inside it turns a quarter when the panel is open. It is one
 * `transform`, on the hover duration, and reduced motion holds it still: the
 * open state is already carried by `aria-expanded` and by the panel itself.
 */
function CollapsibleTrigger({
  className,
  ...props
}: ComponentProps<typeof CollapsiblePrimitive.CollapsibleTrigger>) {
  return (
    <CollapsiblePrimitive.CollapsibleTrigger
      data-slot="collapsible-trigger"
      className={cn(
        "cursor-pointer disabled:cursor-not-allowed",
        "[&_svg]:pointer-events-none [&_svg]:shrink-0",
        "[&_svg:not([class*='size-'])]:size-4",
        "[&_svg]:transition-transform [&_svg]:duration-(--duration-hover)",
        "[&_svg]:ease-out data-[state=open]:[&_svg]:rotate-90",
        "motion-reduce:[&_svg]:transition-none",
        className,
      )}
      {...props}
    />
  );
}

/** The panel one trigger reveals. It is absent from the tree while closed. */
function CollapsibleContent({
  className,
  ...props
}: ComponentProps<typeof CollapsiblePrimitive.CollapsibleContent>) {
  return (
    <CollapsiblePrimitive.CollapsibleContent
      data-slot="collapsible-content"
      className={cn("min-w-0", className)}
      {...props}
    />
  );
}

export { Collapsible, CollapsibleTrigger, CollapsibleContent };
