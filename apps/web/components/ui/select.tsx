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
 */
function Select({ className, ...props }: ComponentProps<"select">) {
  const hint = useFieldHint();

  return (
    <select
      data-slot="select"
      className={cn(
        "w-full min-h-(--control-lg) rounded-input border border-input bg-surface px-3",
        "text-base text-foreground",
        "disabled:cursor-not-allowed disabled:opacity-60",
        className,
      )}
      {...props}
      /* After the spread, so a caller passing nothing cannot erase the hint. */
      aria-describedby={props["aria-describedby"] ?? hint}
    />
  );
}

export { Select };
