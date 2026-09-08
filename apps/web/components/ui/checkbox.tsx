import type { ComponentProps } from "react";

import { useFieldHint } from "@/ui/field-hint.ts";
import { cn } from "@/lib/utils";

/**
 * Use a native checkbox for checked state, form behavior, and platform
 * interaction. The wrapper supplies the coarse-pointer target while keeping
 * the visible box compact; callers still associate visible labels.
 */
function Checkbox({ className, ...props }: ComponentProps<"input">) {
  const hint = useFieldHint();

  return (
    <label
      className={cn(
        "inline-grid size-[18px] cursor-pointer place-items-center",
        "pointer-coarse:size-(--tap-target)",
        "has-[:disabled]:cursor-not-allowed",
      )}
    >
      <input
        type="checkbox"
        data-slot="checkbox"
        className={cn(
          /*
           * 18px is the box's own size and it is off `DESIGN.md`'s 4px spacing
           * list. It is carried over rather than chosen — the stylesheet this
           * replaces said `width: 18px` — so it is written as a measurement
           * instead of `size-4.5`, which would read as a scale step that does
           * not exist.
           */
          "size-[18px] shrink-0 cursor-pointer rounded-button accent-foreground",
          "disabled:cursor-not-allowed disabled:opacity-55",
          className,
        )}
        {...props}
        /* After the spread, so a caller passing nothing cannot erase the hint. */
        aria-describedby={props["aria-describedby"] ?? hint}
      />
    </label>
  );
}

export { Checkbox };
