"use client";

import { Label as LabelPrimitive } from "radix-ui";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

/**
 * The visible name of a control.
 *
 * `DESIGN.md`: "Keep labels visible. Placeholder text is not a label." So this
 * is drawn rather than hidden, at the 14px step and at weight 500 — the weight
 * the type rules reserve for compact labels, and the highest weight this
 * product has.
 *
 * Radix rather than a plain `<label>` for one behaviour a plain one gets
 * wrong: a double click on a label selects the words around it, which is what
 * a person sees when they meant to select the value in the field. Radix
 * suppresses that and leaves the click-to-focus a label is for.
 *
 * No focus ring here. `globals.css` draws the two-pixel Ember indicator on
 * every focusable element from outside every cascade layer, so no component in
 * this directory carries one of its own.
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
