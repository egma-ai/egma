import type { ComponentProps } from "react";

import { useFieldHint } from "@/ui/field-hint.ts";
import { cn } from "@/lib/utils";

/**
 * Multiline input with caller-controlled rows and vertical resizing. Use shared
 * text-field focus styling and the enclosing Field hint.
 */
function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  const hint = useFieldHint();

  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "w-full resize-y rounded-input border border-input bg-surface p-3",
        "text-sm text-foreground placeholder:text-faint",
        /* Touch screens keep 16px text: iOS zooms the page into any focused control set smaller. */
        "pointer-coarse:text-base",
        "read-only:bg-surface-soft read-only:text-muted-foreground",
        "disabled:cursor-not-allowed disabled:opacity-60",
        className,
      )}
      {...props}
      /* After the spread, so a caller passing nothing cannot erase the hint. */
      aria-describedby={props["aria-describedby"] ?? hint}
    />
  );
}

export { Textarea };
