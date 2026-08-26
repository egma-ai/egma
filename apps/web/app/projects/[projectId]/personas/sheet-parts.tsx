"use client";

import type { ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { ownerSaid, type Persona } from "../../../../lib/personas.ts";

/**
 * The parts a persona's side sheet and its list are written from.
 *
 * **They are here rather than in `apps/web/ui/` because they are one screen's
 * arrangement, not a shared behaviour.** The sheet itself, its head, its body,
 * its footer and its motion are `components/ui/sheet.tsx`; what is below is how
 * *a persona* fills one: a labelled group, a read pair, the frozen-version
 * list, and the chip that says which kind of persona a row is.
 *
 * Every measurement is read off page `L-0` of the Paper file (boards `RA4-0`
 * through `S6H-0`) with `get_computed_styles`, and every value is spent as a
 * theme key rather than as a number: `DESIGN.md` keeps the numbers, this file
 * keeps the shapes.
 *
 * Two board values are deliberately not copied literally, both because
 * `DESIGN.md`'s scale decides:
 *
 * - The boards write a sheet's small print at **12px and 13px**. The type scale
 *   starts at 14px and the 12px micro label belongs to letter-spaced capitals
 *   alone, so every one of those is drawn at `text-sm` in the faint colour —
 *   which is the same instruction the developer's own note asked for, "reduce
 *   the size and colour of these texts which are of explanatory nature", inside
 *   the scale the product actually has.
 * - The boards pad a sheet by **28px**. That is off `DESIGN.md`'s spacing list,
 *   and `components/ui/sheet.tsx` already rounds it to the 24px step that is on
 *   it. Nothing here re-pads the panel.
 */

/** A labelled group inside a sheet: `WHO THEY ARE`, `MODELS`, `VERSIONS`. */
export function SheetSection({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <section className="flex min-w-0 flex-col gap-3" aria-label={label}>
      {/*
       * 12px letter-spaced capitals, which is the one thing on these boards
       * that is genuinely the micro step rather than the caption step.
       */}
      <h3 className="m-0 text-2xs font-normal tracking-(--tracking-label) text-faint uppercase">
        {label}
      </h3>
      {children}
    </section>
  );
}

/** One fact about a persona, as a read view shows it. */
export type Read = {
  readonly label: string;
  readonly value: ReactNode;
  /** An identifier or a rate, which reads straight in the mono face. */
  readonly mono?: boolean;
};

/**
 * A group of facts, as a definition list — **one item per line**.
 *
 * **A definition list because that is what it is**: a screen reader reads each
 * value with the name of the value, which a stack of `<div>`s does not give.
 *
 * The two-column grid these used to sit in is gone by the developer's own
 * reading of the boards — "can you show each item in one line for MODELS as
 * well". A 440px panel gives a pair of columns about 190px each, which is
 * narrower than half the values in it: a model name, a voice id and a sentence
 * of personality all wrapped, and the eye had to find the second column's
 * baseline again on every row. One lane down the sheet reads as a list, which
 * is what it is.
 */
export function Reads({ reads }: { readonly reads: readonly Read[] }) {
  return (
    <dl className="m-0 flex min-w-0 flex-col gap-3">
      {reads.map((read) => (
        <div className="flex min-w-0 flex-col gap-1" key={read.label}>
          <dt className="m-0 text-sm text-faint">{read.label}</dt>
          <dd
            className={cn(
              "m-0 min-w-0 text-sm text-foreground [overflow-wrap:anywhere]",
              /* A description somebody wrote in paragraphs stays in them. */
              "whitespace-pre-wrap",
              read.mono === true && "font-mono",
            )}
          >
            {read.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * A chip: one hairline and one word.
 *
 * `shape="count"` is the 22px chip this product already draws beside a row of
 * facts, and `bg-transparent` takes the fill off it, because `DESIGN.md` asks
 * a chip for a hairline and a word. Square, like everything else, because the
 * one radius in this product is 0.
 */
export function StateChip({ children }: { readonly children: ReactNode }) {
  return (
    <Badge className="bg-transparent" shape="count" variant="neutral">
      {children}
    </Badge>
  );
}

/**
 * Which kind of persona a row is: `Predefined` or `Custom`.
 *
 * It is a chip rather than plain text by the developer's note on the boards —
 * "can we move the Type in a square chip" — so the Type column reads as a
 * label somebody applied rather than as a second name for the row.
 */
export function PersonaTypeChip({
  owner,
}: {
  readonly owner: Persona["owner"];
}) {
  return <StateChip>{ownerSaid(owner)}</StateChip>;
}

/** One row of the frozen-version list. */
export type VersionRow = {
  readonly id: string;
  readonly version: number;
  readonly written: ReactNode;
  /** The version this persona is on now. */
  readonly current: boolean;
  /** The version this sheet is reading, when it is reading an older one. */
  readonly reading: boolean;
  readonly onRead?: () => void;
};

/**
 * Every version this persona has been, newest first.
 *
 * **It is a section of the sheet rather than a second panel over it.** The
 * history used to be a sheet of its own opened from a page that was already a
 * sheet's worth of reading; the boards fold it in, because "which version is
 * this and what were the others" is one question and not two.
 *
 * A row that can be read is a button rather than a link: reading an older
 * version does not change the address, it changes what this same sheet is
 * showing.
 */
export function Versions({ rows }: { readonly rows: readonly VersionRow[] }) {
  return (
    <ol className="m-0 flex list-none flex-col border border-border p-0">
      {rows.map((row) => (
        <li
          className={cn(
            "flex min-h-9 min-w-0 flex-wrap items-center justify-between gap-x-3",
            "border-border px-3 py-1 not-first:border-t",
            /*
             * The wash stays here, and only here. It is the *current* mark —
             * the state `DESIGN.md` gives the wash — and this list is the one
             * place on the surface that still says "this is the one in force".
             * The open row on the list behind it is grey for the opposite
             * reason: it is a row somebody opened, not a value in force.
             */
            (row.current || row.reading) && "bg-surface-active",
          )}
          key={row.id}
        >
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="font-mono text-sm text-foreground">
              v{row.version}
            </span>
            <span className="text-sm text-muted-foreground">{row.written}</span>
          </span>
          {row.reading ? (
            <span className="text-sm text-faint">Reading</span>
          ) : row.current ? (
            <span className="text-sm text-faint">Current</span>
          ) : row.onRead === undefined ? null : (
            <button
              className={cn(
                "cursor-pointer border-0 bg-transparent p-0 text-sm text-foreground",
                "underline underline-offset-[3px]",
                "transition-colors duration-(--duration-hover) ease-out",
                "pointer-hover:text-primary",
              )}
              onClick={row.onRead}
              type="button"
            >
              Read
            </button>
          )}
        </li>
      ))}
    </ol>
  );
}
