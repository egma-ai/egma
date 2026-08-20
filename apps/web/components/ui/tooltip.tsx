"use client";

import { Tooltip as TooltipPrimitive } from "radix-ui";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

/**
 * A short explanation attached to one control.
 *
 * Radix supplies what a hand-written tooltip keeps getting wrong: the delay
 * before the first one, the grouping that opens the next one at once, Escape,
 * dismissal when a press lands elsewhere, the `aria-describedby` wiring, and a
 * position that answers the edge of the window instead of running off it.
 *
 * `disableHoverableContent` is on by default because of a rule rather than a
 * preference: `DESIGN.md` says a tooltip never holds an action, so there is
 * nothing in one to move a pointer into, and the grace area that protects that
 * journey only makes the tooltip outstay its welcome.
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
 * One tooltip, which carries its own provider so a lone one works.
 *
 * A provider higher up still decides for every tooltip under it that does not
 * override it: `delayDuration` passed here lands on the root, and Radix reads
 * the root's before the provider's.
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
 * The panel itself, and the one state that must not move.
 *
 * Radix says how the tooltip was opened, and the two answers want different
 * things. `delayed-open` is a pointer that waited, so it arrives on opacity
 * and `scale`, about the trigger it belongs to. `instant-open` is either
 * keyboard focus or a pointer inside the grouping window, and both of those
 * appear at once and without movement — "do not animate actions used many
 * times each day, especially keyboard navigation", and a delay repeated across
 * a row of controls is the tooltip behaviour everybody complains about.
 *
 * The exit is scoped by the `data-input` its caller sets, because Radix says
 * "closed" the same way whichever opened it. An animation is what Radix waits
 * for before it unmounts, so a pointer exit runs to completion and a keyboard
 * one is not made to wait for anything. A caller that sets no `data-input`
 * gets the arrival and an exit that is simply immediate.
 *
 * **No arrow.** This product's tooltip has never drawn one, and Radix measures
 * an arrow with a `ResizeObserver`, which the component tests have no
 * implementation of. Adding one is a change to two things, not one.
 */
function TooltipContent({
  className,
  /* 8px, the second step of the 4px grid, between the trigger and the panel. */
  sideOffset = 8,
  ...props
}: ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
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
          "data-[state=delayed-open]:animate-[egma-anchored-in_var(--duration-popover-in)_var(--ease-out)]",
          "data-[input=pointer]:data-[state=closed]:animate-[egma-anchored-out_var(--duration-popover-out)_var(--ease-out)]",
          /*
           * The reduced-motion form keeps the arrival and the departure and
           * drops the movement, so the panel still says it came and went.
           */
          "motion-reduce:data-[state=delayed-open]:animate-[egma-fade-in_var(--duration-hover)_linear]",
          "motion-reduce:data-[input=pointer]:data-[state=closed]:animate-[egma-fade-out_var(--duration-hover)_linear]",
          className,
        )}
        {...props}
      />
    </TooltipPrimitive.Portal>
  );
}

export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger };
