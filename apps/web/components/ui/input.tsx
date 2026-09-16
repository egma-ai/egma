import type { ComponentProps } from "react";

import { useFieldHint } from "@/ui/field-hint.ts";
import { cn } from "@/lib/utils";

/**
 * Use shared text-field focus styling and inherit the enclosing Field hint.
 * An explicit aria-describedby overrides the inherited hint, for example to
 * name a validation error.
 */
function Input({ className, type, ...props }: ComponentProps<"input">) {
  const hint = useFieldHint();

  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "w-full min-h-(--control-lg) rounded-input border border-input bg-surface px-3",
        "text-sm text-foreground placeholder:text-faint",
        /* Touch screens keep 16px text: iOS zooms the page into any focused control set smaller. */
        "pointer-coarse:text-base",
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
