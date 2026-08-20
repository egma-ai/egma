import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

/**
 * A quiet stand-in for content that has not arrived.
 *
 * `DESIGN.md` asks a loading state to "show progress" with a "fast, quiet
 * indicator", and this is that indicator: a neutral bar that breathes. It
 * claims no shape of its own — the caller gives it the height and the width of
 * whatever is coming — so it never pretends to be a table it has not seen.
 *
 * **Three things about the stock shadcn skeleton are changed, and each one is
 * a rule in `DESIGN.md` rather than a preference.**
 *
 * 1. **The bar reads `--border`, not `--surface-soft`.** shadcn draws it on
 *    `bg-accent`, which this theme maps to `--surface-soft` — 6% Graphite on
 *    paper. The application canvas is 3% Graphite on paper, so a skeleton on
 *    the canvas was three percent of one colour away from the page it was
 *    drawn on: present in the DOM, invisible to a person. `--border` is 18%,
 *    still "a neutral Graphite-and-Paper mix" and still quiet, and it is
 *    legible on the canvas, on Pure Paper and in dark theme alike.
 * 2. **The pulse is timed by the theme.** `animate-pulse` carries Tailwind's
 *    own `2s cubic-bezier(0.4, 0, 0.6, 1)`, and "do not put a colour, a
 *    radius, a size, or a duration in a component" leaves no room for either
 *    number. `--animate-pulse` is redeclared on the element instead, so the
 *    utility still resolves `animation: var(--animate-pulse)` and what it
 *    finds is egma's: `--duration-drawer-in` twice over per half-cycle, and
 *    `--ease-in-out`. A declaration on the element beats the theme's own on
 *    `:root` whatever the source order, so this needs no ordering luck. The
 *    result is a 1.12s breath against shadcn's 2s — quicker, and still slow
 *    enough to read as waiting rather than as alarm.
 * 3. **The radius is named for a component.** `rounded-md` and
 *    `rounded-input` are the same 8px today; only one of them says which of
 *    egma's four radii it means, and only one of them moves if that step ever
 *    does.
 *
 * Reduced motion stops the breath and leaves the bar. That is the whole
 * reduced-motion form and it is enough, because a skeleton is never the only
 * thing on screen: the state above it says what is being waited for in words,
 * exactly as the run state mark's turn is dropped and its word is kept.
 *
 * **`--pulse-delay` is the one knob, and it is a custom property rather than
 * an `animation-delay` utility on purpose.** A row of skeletons reads as one
 * wave when its bars are out of phase, and the obvious way to say that —
 * `[animation-delay:…]` beside `animate-pulse` — is two declarations of the
 * same shorthand family racing on emitted source order: `animation:` resets
 * `animation-delay` to zero, so whichever Tailwind happens to write second
 * decides whether the stagger exists at all. Folding the offset into the
 * shorthand as a variable removes the race. It defaults to `0ms`, so a lone
 * skeleton says nothing about phase.
 */
function Skeleton({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn(
        "rounded-input bg-border",
        "animate-pulse",
        "[--animate-pulse:pulse_calc(var(--duration-drawer-in)*2)_var(--ease-in-out)_var(--pulse-delay,0ms)_infinite]",
        "motion-reduce:animate-none",
        className,
      )}
      {...props}
    />
  );
}

export { Skeleton };
