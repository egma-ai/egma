"use client";

import { Label as LabelPrimitive } from "radix-ui";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

/**
 * Keep control labels visible. Radix preserves click-to-focus while suppressing
 * accidental text selection on repeated label clicks.
 */
function Label({
  className,
  ...props
}: ComponentProps<typeof LabelPrimitive.Root>) {
  return (
    <LabelPrimitive.Root
      data-slot="label"
      className={cn(
        "flex items-center gap-2 text-sm font-medium text-foreground select-none",
        /*
         * A label is not a control, so it cannot be disabled itself. These say
         * what it does when the thing it names is: a wrapped control reports
         * through `group-data-[disabled]`, a sibling one through `peer`. Both
         * land on the same 55% the button uses, so one disabled row fades by
         * one amount.
         */
        "group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-55",
        "peer-disabled:cursor-not-allowed peer-disabled:opacity-55",
        className,
      )}
      {...props}
    />
  );
}

export { Label };
