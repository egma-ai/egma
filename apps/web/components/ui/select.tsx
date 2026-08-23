import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";

import { useFieldHint } from "@/ui/field-hint.ts";
import { cn } from "@/lib/utils";

/**
 * A choice among things egma already knows about — a voice provider, a
 * replacement persona, which measure a grader holds to a bound.
 *
 * **It is the browser's own select, and that is a decision rather than a
 * shortcut.** shadcn's registry select is built on Radix: a button that opens a
 * listbox drawn in a portal. It looks the same in every browser, and what it
 * costs is everything the native control already does for free — the platform
 * picker on a phone, the wheel on iOS, type-ahead, the operating system's own
 * assistive behaviour, and a `<select>` element that a form, a test and a
 * person driving with a keyboard all recognise. This product's selects have
 * always been native, every one of them is inside a form somebody has to be
 * able to fill in on a phone, and `DESIGN.md` asks for one semantic tree rather
 * than for a particular listbox. So the registry's *shape* is kept — one file
 * under `components/ui`, `data-slot`, `cn` over the caller's classes, every
 * value a theme key — and its Radix dependency is not.
 *
 * The chevron is the browser's. `globals.css` restyles the open picker itself
 * where a browser supports `appearance: base-select`, which is where that
 * belongs: one rule for every select in the product rather than a drawn arrow
 * on each one.
 *
 * The options always come from the server. A hand-written copy of a list the
 * server owns is a list that is wrong the day the server grows an entry, and
 * silently: the form would keep offering yesterday's choices and refusing
 * today's.
 *
 * **The three sizes are `Button`'s, and `default` is not the default here.** A
 * select is mostly a form field, so `lg` (44px, the form control) is what a
 * caller gets for saying nothing and every form is unchanged. But a select is
 * also a filter above a list and a control inside a row, and those are 36px —
 * so the height became a prop instead of something each caller wrote for
 * itself. The roster row had a 44px select standing a head above the two 36px
 * buttons beside it, which made every row of that table 60px tall.
 *
 * Two other screens keep a class list of their own for their toolbar filters,
 * and that one stays: it is shared with `Input`, and a text input cannot take
 * a `size` prop — `size` is already a native attribute there.
 *
 * The coarse-pointer minimum is not traded away for the smaller steps:
 * `pointer-coarse` puts the 44px target straight back, which is the trade
 * `Button` and the sidebar row already make — and which the copied class lists
 * were not making at all.
 */
const selectVariants = cva(
  [
    "w-full rounded-input border border-input bg-surface px-3",
    "text-base text-foreground",
    "disabled:cursor-not-allowed disabled:opacity-60",
    /* "Pointer targets are at least 44px on coarse pointers." */
    "pointer-coarse:min-h-(--tap-target)",
  ],
  {
    variants: {
      size: {
        /* Denser still, for a control inside a row rather than above a list. */
        sm: "min-h-(--control-sm)",
        /* 36px: the toolbar control, and the one a table row holds. */
        default: "min-h-(--control-md)",
        /* 44px: the form control, which is what a field or a sheet holds. */
        lg: "min-h-(--control-lg)",
      },
    },
    defaultVariants: { size: "lg" },
  },
);

function Select({
  className,
  size,
  ...props
}: Omit<ComponentProps<"select">, "size"> &
  VariantProps<typeof selectVariants>) {
  const hint = useFieldHint();

  return (
    <select
      data-slot="select"
      className={cn(selectVariants({ size }), className)}
      {...props}
      /* After the spread, so a caller passing nothing cannot erase the hint. */
      aria-describedby={props["aria-describedby"] ?? hint}
    />
  );
}

export { Select, selectVariants };
