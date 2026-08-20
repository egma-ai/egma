import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

/**
 * A quiet stand-in for content that has not arrived.
 *
 * `DESIGN.md` asks a loading state to "show progress" with a "fast, quiet
 * indicator", and this is the mark it does that with. It claims no shape of
 * its own — the caller gives it the height and the width of whatever is coming
 * — so it never pretends to be a table it has not seen.
 *
 * **Two things about the stock shadcn skeleton change here, and both are rules
 * in `DESIGN.md` rather than preferences.**
 *
 * 1. **The bar reads `--border`.** shadcn draws it on the quiet accent
 *    surface, which this theme maps to `--surface-soft` — 6% Graphite on
 *    paper. The application canvas is 3% Graphite on paper, so a skeleton on
 *    the canvas was three percent of one colour away from the page it was
 *    drawn on: present in the DOM, invisible to a person. `--border` is 18%,
 *    still "a neutral Graphite-and-Paper mix" and still quiet, and it is
 *    legible on the canvas, on Pure Paper and in dark theme alike.
 * 2. **The radius is named for a component.** shadcn's generic medium step and
 *    `rounded-input` are the same 8px today; only one of them says which of
 *    egma's four radii it means, and only one of them moves if that step ever
 *    does.
 *
 * **The breath is not here.** shadcn hands a skeleton Tailwind's own pulse
 * utility, which arrives welded to a two-second duration and an easing curve
 * of Tailwind's own, and "do not put a colour, a radius, a size, or a duration
 * in a component" leaves no room for either number. `tailwind-theme.css` owns
 * it instead, keyed on this element's `data-slot`, beside the run state mark's
 * turn and under the same rule in `DESIGN.md` — including the phase offset
 * that makes a column of these read as one wave, and the reduced-motion form
 * that stops it.
 *
 * Nothing in this file, prose included, may name a utility it does not use.
 * Tailwind finds class names by reading these files as text, so a class named
 * only to explain it is still a rule minted into the stylesheet.
 */
function Skeleton({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn("rounded-input bg-border", className)}
      {...props}
    />
  );
}

export { Skeleton };
