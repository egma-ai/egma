import type { ComponentProps } from "react";

import { useFieldHint } from "@/ui/field-hint.ts";
import { cn } from "@/lib/utils";

/**
 * A text field at the 8px input radius.
 *
 * No focus ring of its own: `globals.css` draws the two-pixel Ember indicator
 * on every focusable element from outside every cascade layer, so focus here is
 * the same focus as everywhere else in the product and cannot be turned off by
 * a class.
 *
 * **A field inside a `Field` describes itself with that field's hint.** The id
 * arrives through context rather than through a prop, because a caller wiring
 * `aria-describedby` by hand forgets exactly the fields nobody checks — the
 * page still looks right without it. An `aria-describedby` passed in wins,
 * because a field being refused has something more urgent to say than what to
 * write in it.
 */
function Input({ className, type, ...props }: ComponentProps<"input">) {
  const hint = useFieldHint();

  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "w-full min-h-(--control-lg) rounded-input border border-input bg-surface px-3",
        "text-base text-foreground placeholder:text-faint",
        "read-only:bg-surface-soft read-only:text-muted-foreground",
        "disabled:cursor-not-allowed disabled:opacity-60",
        "file:border-0 file:bg-transparent file:text-sm file:font-medium",
        className,
      )}
      {...props}
      /* After the spread, so a caller passing nothing cannot erase the hint. */
      aria-describedby={props["aria-describedby"] ?? hint}
    />
  );
}

export { Input };
