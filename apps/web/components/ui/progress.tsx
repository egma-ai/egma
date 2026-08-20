"use client";

import { Progress as ProgressPrimitive } from "radix-ui";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

/**
 * The bar that explains completion.
 *
 * `DESIGN.md` gives this component one line — "Progress: explain completion —
 * transform-based fill, linear while active" — and the registry's version keeps
 * only the first half of it. What arrives from shadcn fills on `transition-all`
 * with the default easing, which is `all` (forbidden outright) decelerating
 * (which lies about the rate of the work). Both are fixed here.
 *
 * **Its look is `RunProgress`'s look, on purpose.** `ui/run-status.tsx` already
 * draws this product's progress bar — a neutral track, an ink fill, the chip
 * radius, 200ms linear, and no movement under reduced motion — so the kit
 * primitive is dressed to match rather than to a second opinion. A later ticket
 * moving `RunProgress` onto this primitive should be deleting code, not
 * redrawing a bar.
 *
 * The fill is `--foreground` rather than the brand orange, which is the choice
 * `RunProgress` already made and worth keeping deliberately: `DESIGN.md` spends
 * Ember on "focus, icons, marks, and narrow active edges" and Deep Ember on
 * "primary filled actions with white text". A bar that is neither reads as ink,
 * and ink is also the highest contrast available in both themes for a shape
 * that carries no text of its own.
 */
function Progress({
  className,
  value,
  max,
  ...props
}: ComponentProps<typeof ProgressPrimitive.Root>) {
  /*
   * `max` honoured, which the registry's version drops.
   *
   * Radix reads `max` — it puts it on `aria-valuemax` and decides `data-state`
   * with it — but the indicator shadcn ships computes `100 - value`, so it only
   * ever agrees with the label when `max` happens to be 100. A caller counting
   * three onboarding stages says `value={1} max={3}`, is announced as "1, out of
   * 3", and is drawn at one percent. The eye and the screen reader must not be
   * given two different answers, so the share is computed the same way Radix
   * computes the one it announces.
   */
  const ceiling = typeof max === "number" && max > 0 ? max : 100;
  const filled =
    typeof value === "number" && value >= 0 && value <= ceiling ? value : null;
  /*
   * An indeterminate bar stays empty rather than being drawn at zero. Radix
   * leaves `aria-valuenow` off and says `data-state="indeterminate"`, so what a
   * screen reader is told is "in progress, amount unknown"; a fill sitting at
   * zero would tell the eye "nothing is done yet", which is a different claim
   * and not one this component is in a position to make.
   */
  const remaining = filled === null ? 100 : 100 - (filled / ceiling) * 100;

  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      className={cn(
        /*
         * "Quiet hover, read-only, progress, and supporting surfaces use a
         * neutral Graphite-and-Paper mix." That mix is `--surface-soft`.
         *
         * The chip radius, because a track is a pill and `DESIGN.md` names the
         * pill for "tag, chip, filter" — the nearest named type, and the rule
         * it is guarding against is one big radius on everything rather than a
         * pill on something pill-shaped.
         */
        "relative h-2 w-full overflow-hidden rounded-chip bg-surface-soft",
        className,
      )}
      max={max}
      value={value}
      {...props}
    >
      {/*
       * Transform-based, and the transform is a `translateX` inside a clipping
       * track rather than the `scaleX` `RunProgress` uses.
       *
       * Both are "transform-based fill". This one is the registry's, so a
       * component pasted from shadcn lands on it unedited, and it is also the
       * better of the two here: `scaleX` on a pill squashes the leading cap
       * horizontally, while a full-width indicator slid left keeps its cap
       * round and lets the track clip the other end.
       */}
      <ProgressPrimitive.Indicator
        data-slot="progress-indicator"
        className={cn(
          "size-full rounded-chip bg-foreground",
          /*
           * "Linear while active."
           *
           * Linear is the whole point: a fill that decelerates says the work is
           * slowing down, and a bar that is still moving has no business
           * claiming that. The easing turns over to `--ease-out` only on
           * `data-state="complete"`, where a value settling into its final
           * place is exactly what an ease-out describes.
           *
           * 200ms is written here rather than read from the theme, and it is
           * the same non-token duration, for the same reason, as the one
           * already written in `ui/run-status.tsx`: the motion tokens name
           * interface motion — a press, a popover, a dialog — and this is a
           * value catching up to a new value, which `DESIGN.md` gives a
           * behaviour for and no token. It is under the 300ms ceiling. Called
           * out in the pull request for the developer to overrule.
           */
          "transition-transform duration-200 ease-linear",
          "data-[state=complete]:ease-out",
          /*
           * The reduced-motion form. Nothing travels; the bar is simply at its
           * new length, and the value beside it is what says it changed.
           */
          "motion-reduce:transition-none",
        )}
        style={{ transform: `translateX(-${String(remaining)}%)` }}
      />
    </ProgressPrimitive.Root>
  );
}

export { Progress };
