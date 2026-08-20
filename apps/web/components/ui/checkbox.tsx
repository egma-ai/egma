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
 * **The box is 18px and the target is 44px, and they are deliberately not the
 * same number.** `DESIGN.md` asks for a 44px pointer target on a coarse
 * pointer; it does not ask for a 44px checkbox, and an 18px box is what this
 * control has always drawn. So the label wrapper — which is the target,
 * because a label activates the control it wraps — grows to the tap target on
 * a coarse pointer and stays at the box's size on a fine one. The box is
 * centred in it either way, so a mouse sees no change at all.
 *
 * This was carried over at 18px by the wave that wrote this file and flagged
 * for the developer, who approved the fix. Callers with visible copy still
 * keep that copy visible and point at the control with `htmlFor`, which makes
 * the whole label a target as well.
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
