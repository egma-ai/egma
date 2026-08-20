import type { ComponentProps } from "react";

import { useFieldHint } from "@/ui/field-hint.ts";
import { cn } from "@/lib/utils";

/**
 * One binary choice: whether a grader can fail a run, whether a list includes
 * what has been archived.
 *
 * **It is the browser's own checkbox**, for the reasons written on `select.tsx`
 * and one more of its own: the registry's Radix checkbox is a `<button>` with
 * `role="checkbox"`, so it carries no `checked` property, submits nothing with
 * a native form, and is not the element a person's assistive technology has
 * been taught. `accent-color` is what dresses it, which keeps the platform's
 * own indeterminate and focus behaviour and costs nothing.
 *
 * The label wrapper is carried over from the stylesheet this replaces, at the
 * same 18px. **It is under half the 44px `DESIGN.md` asks for on a coarse
 * pointer**, and it is left at 18px here because this change is a restyle and
 * that would be a change to the product — it is flagged in the pull request
 * instead. Callers with visible copy keep that copy visible and point at the
 * control with `htmlFor`, which makes the whole label a target as well and is
 * how every caller in the product reaches it today.
 */
function Checkbox({ className, ...props }: ComponentProps<"input">) {
  const hint = useFieldHint();

  return (
    <label className="inline-grid size-[18px] cursor-pointer place-items-center has-[:disabled]:cursor-not-allowed">
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
