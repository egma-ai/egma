"use client";

import type { ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * The parts a persona's side sheet is written from.
 *
 * **They are here rather than in `apps/web/ui/` because they are one screen's
 * arrangement, not a shared behaviour.** The sheet itself, its head, its body,
 * its footer and its motion are ticket 01's `components/ui/sheet.tsx`; what is
 * below is how *a persona* fills one: a labelled group, a read pair, the
 * two-column facts grid, the frozen-version list, and the panel that says what
 * a save will do to the version number.
 *
 * Every measurement is read off page `C-0` of the Paper file
 * (`9UB-0`, `AF0-0`, `B0B-0`, `CDP-0`, `CQ1-0`, `CSF-0`) with
 * `get_computed_styles`, and every value is spent as a theme key rather than
 * as a number: `DESIGN.md` keeps the numbers, this file keeps the shapes.
 *
 * Two board values are deliberately not copied literally, both because
 * `DESIGN.md`'s scale decides and ticket 01 already ruled on them:
 *
 * - The boards write a sheet's small print at **13px**. The type scale starts
 *   at 14px and the 12px micro label belongs to the two sidebar labels alone,
 *   so every 13px on these boards is drawn at `text-sm`.
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
  /** A sentence rather than a word: it takes the whole width of the sheet. */
  readonly wide?: boolean;
};

/**
 * A group of facts, as a definition list.
 *
 * **A definition list because that is what it is**: a screen reader reads each
 * value with the name of the value, which a stack of `<div>`s does not give.
 *
 * Short facts can share a row, and sentence-length facts take the panel width.
 * That is a two-column grid with a `col-span-2` on the wide ones rather than
 * nested rows — nesting rows inside a
 * `<dl>` is not a shape the element allows, and the grid keeps every label on
 * the same baseline down the column.
 */
export function Reads({ reads }: { readonly reads: readonly Read[] }) {
  return (
    <dl className="m-0 grid min-w-0 grid-cols-2 gap-x-4 gap-y-3 max-[30rem]:grid-cols-1">
      {reads.map((read) => (
        <div
          className={cn(
            "flex min-w-0 flex-col gap-1",
            read.wide === true && "col-span-2 max-[30rem]:col-auto",
          )}
          key={read.label}
        >
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
 * The chip beside a persona's name, in the two tones the boards draw.
 *
 * `current` is the wash one — project default, the state a project points at.
 * `quiet` is the neutral one — archived, older version: a fact about this
 * record that is not something anybody chose today.
 *
 * The word is the state and the colour supports it, which is `DESIGN.md`'s
 * rule; neither tone is a verdict colour, because neither of these is a
 * verdict.
 */
export function StateChip({
  tone = "quiet",
  children,
}: {
  readonly tone?: "current" | "quiet";
  readonly children: ReactNode;
}) {
  return (
    <Badge
      shape="count"
      className={cn(
        "px-1.5 text-sm",
        tone === "current"
          ? "bg-surface-active text-foreground"
          : "text-muted-foreground",
      )}
    >
      {children}
    </Badge>
  );
}

/**
 * What a save is about to do to the version number, said before the save.
 *
 * The boards put it at the end of `MODELS`, which is where somebody has just
 * finished changing the two things that mint a version. It is a quiet panel
 * rather than a sentence in the flow because it is about the *whole* group
 * above it and not about the field it follows.
 */
export function NotePanel({ children }: { readonly children: ReactNode }) {
  return (
    <p className="m-0 border border-border bg-surface-soft p-3 text-sm leading-(--line-normal) text-muted-foreground">
      {children}
    </p>
  );
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
            row.current && "bg-surface-active",
            row.reading && "bg-surface-active",
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

/** The line of small print under a sheet's facts: when, and by whom. */
export function SheetTimestamps({ children }: { readonly children: ReactNode }) {
  return <p className="m-0 text-sm text-faint">{children}</p>;
}
