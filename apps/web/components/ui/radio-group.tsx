"use client";

import { cva, type VariantProps } from "class-variance-authority";
import { RadioGroup as RadioGroupPrimitive } from "radix-ui";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

/**
 * Exactly one of a small closed set.
 *
 * Radix supplies the whole radio-group contract, which is the part a
 * hand-written group loses quietly: the group is one Tab stop, the arrow keys
 * move inside it and come back round, Home and End reach the ends, selection
 * follows focus, and every option reports `role="radio"` with `aria-checked`.
 * None of that shows in a screenshot, so none of it fails visibly when it is
 * dropped in a refactor.
 *
 * Radix moves focus in a task after the key, rather than during it, so React
 * has committed the new selection before anything is focused. A caller sees
 * `onChange` and then the focus move, in that order.
 *
 * No focus ring here: `globals.css` draws the two-pixel Ember indicator on
 * every focusable element from outside every cascade layer.
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
 * The two shapes one option is drawn in.
 *
 * The names are egma's, and they follow `button.tsx`: one primitive, more than
 * one thing it may look like, chosen by a named prop rather than by a class
 * list each caller reassembles. `dot` is the registry's radio — a small round
 * box beside its own label. `segment` is the joined strip a filter is drawn
 * as, where the option carries its own words.
 *
 * **`segment` is not a tab and not a toggle group.** Both would draw this, and
 * both would say something else about it: tabs name panels a page switches
 * between, and this switches which rows a table is asked for. What the radio
 * group says is what a person's assistive technology is told.
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
         * **The one place a circle survived the 0px ruling, with the avatar.**
         * A radio button is round the way an avatar is round: the shape is
         * what tells it apart from a checkbox, in every operating system a
         * person has ever used. So it says `rounded-full`, which is Tailwind's
         * own and not one of egma's four component radii. Called out in the
         * pull request for the developer to overrule.
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
          /*
           * The chosen option carries an Ember underline as well as the wash,
           * because state is never colour alone.
           */
          "data-[state=checked]:bg-selected data-[state=checked]:text-foreground",
          "data-[state=checked]:shadow-[inset_0_-2px_0_var(--accent)]",
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
      {shape === "segment" ? (
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

export { RadioGroup, RadioGroupItem, radioItemVariants };
