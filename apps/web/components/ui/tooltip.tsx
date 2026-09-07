"use client";

import { Tooltip as TooltipPrimitive } from "radix-ui";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

/**
 * Configure Radix tooltip timing and accessible descriptions. Disable hoverable
 * content by default because these explanations contain no interactive controls.
 */
function TooltipProvider({
  delayDuration = 500,
  skipDelayDuration = 1_000,
  disableHoverableContent = true,
  ...props
}: ComponentProps<typeof TooltipPrimitive.Provider>) {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delayDuration={delayDuration}
      skipDelayDuration={skipDelayDuration}
      disableHoverableContent={disableHoverableContent}
      {...props}
    />
  );
}

/**
 * Provide defaults for a standalone tooltip. This per-tooltip provider limits
 * the skip-delay window to that trigger; a higher provider cannot share it
 * across neighbors while this wrapper remains.
 */
function Tooltip(props: ComponentProps<typeof TooltipPrimitive.Root>) {
  return (
    <TooltipProvider>
      <TooltipPrimitive.Root data-slot="tooltip" {...props} />
    </TooltipProvider>
  );
}

function TooltipTrigger(props: ComponentProps<typeof TooltipPrimitive.Trigger>) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />;
}

/**
 * Keep content in place so ancestor theme and preview selectors apply.
 * Fixed positioning handles ordinary overflow, but transformed or contained
 * ancestors can still constrain it. The theme owns motion; no arrow is rendered.
 */
function TooltipContent({
  className,
  /* 8px, the second step of the 4px grid, between the trigger and the panel. */
  sideOffset = 8,
  ...props
}: ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Content
      data-slot="tooltip-content"
      sideOffset={sideOffset}
      className={cn(
        /*
         * A tooltip holds no action, so it takes no presses either. Without
         * this it is a panel sitting over the control it explains, and the
         * click meant for that control lands on the explanation.
         */
        "pointer-events-none",
        "z-40 w-max max-w-[min(240px,calc(100vw-var(--space-7)))]",
        "rounded-button border border-foreground bg-foreground px-3 py-2",
        "text-sm text-balance text-surface",
        /* "Popovers use their trigger as `transform-origin`." Radix measures it. */
        "origin-(--radix-tooltip-content-transform-origin)",
        className,
      )}
      {...props}
    />
  );
}

export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger };
