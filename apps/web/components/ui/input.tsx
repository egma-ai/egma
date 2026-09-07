import type { ComponentProps } from "react";

import { useFieldHint } from "@/ui/field-hint.ts";
import { cn } from "@/lib/utils";

/**
 * A text field at the 8px input radius.
 *
 * No focus style of its own: `globals.css` decides focus for every control in
 * the product from outside every cascade layer, so no class here can turn it
 * off. **A text field's focus is quiet** — its hairline darkens to ink, in
 * place, and it draws no ring (`DESIGN.md`, developer decision 2026-08-24).
 * The two-pixel Ember indicator is still what every other control wears.
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
