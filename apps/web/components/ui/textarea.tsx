import type { ComponentProps } from "react";

import { useFieldHint } from "@/ui/field-hint.ts";
import { cn } from "@/lib/utils";

/**
 * Somewhere to write more than a line, at the 8px input radius.
 *
 * A persona's personality can be several sentences, and a single-line field
 * for that text scrolls sideways while somebody is still deciding what to say.
 * It grows with a `rows` count rather than auto-sizing, so the page's layout is
 * decided by the page — and a caller that wants it to follow its content says
 * so with a class, which is how the Tests area's one-line behaviour rows ask
 * for it.
 *
 * `resize-y` is deliberate: sideways resizing pulls a field out of the column
 * it was laid out in, and every form in this product is a column.
 *
 * No focus ring of its own, for the reason `input.tsx` gives, and it describes
 * itself with the enclosing `Field`'s hint for the reason written there too.
 */
function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  const hint = useFieldHint();

  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "w-full resize-y rounded-input border border-input bg-surface p-3",
        "text-base text-foreground placeholder:text-faint",
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
