"use client";

import { Progress as ProgressPrimitive } from "radix-ui";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

/**
 * Theme-styled progress with an ink fill, transform-based updates, and linear
 * easing while active. Reduced motion removes movement. This primitive has
 * its own height; RunProgress is a separate composition.
 */
function Progress({
  className,
  value,
  max,
  ...props
}: ComponentProps<typeof ProgressPrimitive.Root>) {
  /*
   * Compute the fill using max as well as value so its visual fraction agrees
   * with the accessible progress value.
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
        /* Use a neutral track and let it clip the moving indicator. */
        "relative h-2 w-full overflow-hidden rounded-chip bg-surface-soft",
        className,
      )}
      max={max}
      value={value}
      {...props}
    >
      {/*
       * Translate a full-width indicator inside the clipping track to represent
       * the completed share without changing its geometry.
       */}
      <ProgressPrimitive.Indicator
        data-slot="progress-indicator"
        className={cn(
          "size-full rounded-chip bg-foreground",
          /*
           * Use a short linear transition while active, then ease into completion.
           * This smooths reported values and does not estimate the rate of work.
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
