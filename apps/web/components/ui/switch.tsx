"use client";

import { Switch as SwitchPrimitive } from "radix-ui";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

/**
 * One thing, on or off, taking effect as it is pressed.
 *
 * **Not a checkbox.** A checkbox is an answer inside a form that a Save button
 * commits; a switch is the state itself. Radix supplies the contract that says
 * so — `role="switch"` with `aria-checked`, Space and Enter, and the disabled
 * semantics — none of which shows in a screenshot, so none of it fails visibly
 * when a `<button>` is hand-rolled in its place.
 *
 * The shape is egma's: no radius anywhere, a hairline track that takes the
 * selected wash when it is on, and a thumb that travels. `DESIGN.md` keeps one
 * round shape in the system and it belongs to the radio, so this track and this
 * thumb are square like everything else. Colour is never the only signal — the
 * thumb's position says the state too.
 *
 * No focus ring here: `globals.css` draws the two-pixel Ember indicator on
 * every focusable element from outside every cascade layer.
 */
function Switch({
  className,
  ...props
}: ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 items-center border border-input bg-surface p-px",
        "cursor-pointer disabled:cursor-not-allowed disabled:opacity-55",
        "data-[state=checked]:border-brand data-[state=checked]:bg-selected",
        "pointer-hover:border-border-strong",
        /* Colour answers at once; only the thumb travels. Never `all`. */
        "transition-colors duration-(--duration-hover) ease-out",
        "motion-reduce:transition-none",
        /* A real target on a coarse pointer, without growing what a mouse gets. */
        "pointer-coarse:before:absolute pointer-coarse:before:top-1/2",
        "pointer-coarse:before:left-1/2 pointer-coarse:before:size-(--tap-target)",
        "pointer-coarse:before:-translate-x-1/2 pointer-coarse:before:-translate-y-1/2",
        "pointer-coarse:before:content-['']",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          "pointer-events-none block size-4 bg-border-strong",
          "transition-transform duration-(--duration-hover) ease-out",
          "data-[state=checked]:translate-x-4 data-[state=checked]:bg-brand",
          "motion-reduce:transition-none",
        )}
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
