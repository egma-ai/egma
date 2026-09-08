"use client";

import { cva, type VariantProps } from "class-variance-authority";
import { RadioGroup as RadioGroupPrimitive } from "radix-ui";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

/**
 * Use Radix for single-choice state, roving focus, and keyboard handling.
 * Focus appearance comes from the shared stylesheet.
 */
function RadioGroup({
  className,
  ...props
}: ComponentProps<typeof RadioGroupPrimitive.Root>) {
  return (
    <RadioGroupPrimitive.Root
      data-slot="radio-group"
      className={cn("grid gap-3", className)}
      {...props}
    />
  );
}

/**
 * Named visual variants retain radio semantics: dot for labeled options,
 * segment for compact filters, and card for larger choices.
 */
const radioItemVariants = cva(
  [
    "shrink-0 cursor-pointer disabled:cursor-not-allowed disabled:opacity-55",
    /*
     * Pointer press feedback only, and `transform` is the only property that
     * moves — never `all`, and never a colour, which changes at once here as
     * it always has. Keyboard activation is immediate, which is what the
     * `:focus-visible` exclusion says.
     */
    "transition-transform duration-(--duration-press) ease-out",
    "[&:active:not(:focus-visible):not(:disabled)]:scale-97",
    "motion-reduce:transition-none",
    "motion-reduce:[&:active:not(:focus-visible):not(:disabled)]:scale-100",
  ],
  {
    variants: {
      shape: {
        /*
         * 18px is the box, and it is deliberately not the 44px target: the
         * same split `checkbox.tsx` makes, and for the same reason. `DESIGN.md`
         * asks for a 44px pointer target on a coarse pointer, not a 44px
         * radio. The target grows on a pseudo-element so nothing moves around
         * it, and a mouse sees no change at all.
         */
        /*
         * **The one place a circle survives the 0px ruling.** A radio button's
         * shape tells it apart from a checkbox in every operating system a
         * person has used. So it says `rounded-full`, which is Tailwind's own
         * and not one of egma's four component radii. Account avatars are
         * square; this functional control remains the only exception.
         */
        dot: [
          "relative grid size-[18px] place-items-center",
          "rounded-full border border-input bg-surface",
          "pointer-coarse:before:absolute pointer-coarse:before:top-1/2 pointer-coarse:before:left-1/2",
          "pointer-coarse:before:size-(--tap-target) pointer-coarse:before:-translate-x-1/2",
          "pointer-coarse:before:-translate-y-1/2 pointer-coarse:before:content-['']",
          "pointer-hover:border-border-strong",
        ],
        segment: [
          /*
           * One pixel inside the strip's own border, so the chosen segment
           * sits on the strip rather than over its edge.
           */
          "inline-flex h-[calc(var(--control-md)-6px)] items-center px-4",
          "border-0 bg-transparent",
          "text-sm whitespace-nowrap text-muted-foreground",
          /* A real target on a coarse pointer, without growing what a mouse gets. */
          "pointer-coarse:min-h-(--tap-target)",
          "pointer-hover:text-foreground",
          /* The chosen option carries the approved Ember line on its top edge. */
          "data-[state=checked]:bg-surface data-[state=checked]:font-medium data-[state=checked]:text-foreground",
          "data-[state=checked]:shadow-[inset_0_2px_0_var(--accent)]",
        ],
        /*
         * Draw the selected edge as an inset shadow so selection does not change
         * card dimensions. Keep the radio indicator as an additional state cue.
         */
        card: [
          "relative flex min-h-(--tap-target) w-full items-start gap-3 p-4 text-left",
          "border border-border bg-surface text-foreground",
          "transition-colors duration-(--duration-hover) ease-out",
          "motion-reduce:transition-none",
          "pointer-hover:border-border-strong pointer-hover:bg-surface-soft",
          "data-[state=checked]:border-brand data-[state=checked]:bg-selected",
          "data-[state=checked]:shadow-[inset_var(--active-edge-width)_0_0_var(--accent)]",
          "data-[state=checked]:pointer-hover:bg-selected",
        ],
      },
    },
    defaultVariants: { shape: "dot" },
  },
);

function RadioGroupItem({
  className,
  shape = "dot",
  children,
  ...props
}: ComponentProps<typeof RadioGroupPrimitive.Item> &
  VariantProps<typeof radioItemVariants>) {
  return (
    <RadioGroupPrimitive.Item
      data-slot="radio-group-item"
      className={cn(radioItemVariants({ shape }), className)}
      {...props}
    >
      {shape === "segment" || shape === "card" ? (
        children
      ) : (
        <RadioGroupPrimitive.Indicator
          data-slot="radio-group-indicator"
          /* Ember, which `DESIGN.md` names for focus, icons, marks and edges. */
          className="size-2 rounded-full bg-brand"
        />
      )}
    </RadioGroupPrimitive.Item>
  );
}

/** The visible dot inside a card-shaped radio option. */
function RadioCardIndicator({
  className,
  ...props
}: ComponentProps<"span">) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "size-4 flex-none rounded-full border border-border-strong bg-surface",
        /*
         * The one round shape `DESIGN.md` keeps, and the third way this option
         * says it is chosen: a filled Ember ring rather than a colour swap.
         * Only `border-color` and `border-width` move, both composited-cheap
         * and both instant enough not to delay the press.
         */
        "transition-[border-color,border-width] duration-(--duration-hover) ease-out",
        "motion-reduce:transition-none",
        "group-pointer-hover:border-foreground",
        "group-data-[state=checked]:border-4 group-data-[state=checked]:border-brand",
        "group-data-[state=checked]:group-pointer-hover:border-brand",
        className,
      )}
      {...props}
    />
  );
}

export {
  RadioCardIndicator,
  RadioGroup,
  RadioGroupItem,
  radioItemVariants,
};
