"use client";

import type { ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { ownerSaid, type Persona } from "../../../../lib/personas.ts";

/**
 * Persona-specific content built from shared sheet primitives and theme
 * values. Use the design system's type and spacing scale.
 */

/** A labelled group, separated from the previous group by a hairline. */
export function SheetSection({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <section
      className="flex min-w-0 flex-col gap-4 border-border not-first:border-t not-first:pt-5"
      aria-label={label}
    >
      <h3 className="m-0 text-sm font-medium text-foreground">
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
 * Use a definition list with one fact per line so long model and voice names
 * remain readable in the narrow sheet.
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
