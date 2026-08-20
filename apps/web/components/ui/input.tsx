import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

/**
 * A text field at the 8px input radius.
 *
 * No focus ring of its own: `globals.css` draws the two-pixel Ember indicator
 * on every focusable element from outside every cascade layer, so focus here is
 * the same focus as everywhere else in the product and cannot be turned off by
 * a class.
 */
function Input({ className, type, ...props }: ComponentProps<"input">) {
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
    />
  );
}

export { Input };
