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
 * **The inner provider is also what stops the delay grouping from working
 * across tooltips.** Radix keeps "one has just been shown, so open the next at
 * once" on the provider, and a provider per tooltip means each one only ever
 * groups with itself: the same trigger re-hovered is instant, its neighbour
 * still waits the full delay. A `TooltipProvider` mounted higher up does not
 * change that, because the nearest provider is the one a tooltip reads and the
 * nearest is always this one. Restoring the shared window means removing this
 * wrapper *and* mounting one provider above the product, which is two files at
 * once and is recorded with the coordinator rather than done here.
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
 * The panel itself.
 *
 * **No motion here.** `tailwind-theme.css` writes it, keyed on `data-slot` and
 * Radix's `data-state`, exactly as it does for the popover, the dropdown menu
 * and the dialog. Two things need that placement rather than a class list: the
 * reduced-motion form has to be a real `@media` block that comes later, where
 * a `motion-reduce:` utility of equal specificity leaves the winner to
 * Tailwind's variant sort order — a reduced-motion failure that fails silently
 * — and the development proof's reduced-motion frame keys off an ancestor,
 * which no class on this element can express.
 *
 * **No portal, and that is the deliberate part.** The registry portals this to
 * `body`, and a panel under `body` is out of reach of every descendant
 * selector in the theme, including the one the proof page's reduced-motion
 * frame is drawn with. Radix positions the panel `position: fixed` either way,
 * so staying in place keeps the collision handling and the escape from
 * ordinary `overflow` scrolling; what it gives up is an ancestor that is
 * itself a containing block for fixed children — a `transform`, `filter` or
 * `contain` — and the hand-written tooltip this replaces was
 * `position: absolute` inside its trigger, so it lost that case too.
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
