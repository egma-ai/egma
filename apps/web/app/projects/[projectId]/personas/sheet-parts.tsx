"use client";

import { ChevronRightIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { ownerSaid, type Persona } from "../../../../lib/personas.ts";

/**
 * Persona-specific content built from shared page primitives and theme
 * values. Use the design system's type and spacing scale.
 */

/** A labelled settings group that keeps its fields reachable by keyboard. */
export function PersonaSection({
  label,
  invalidReason,
  open = false,
  children,
}: {
  readonly label: string;
  readonly invalidReason?: string;
  readonly open?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <Collapsible
      defaultOpen={open}
      asChild
    >
      <section aria-label={label}>
        <h3 className="m-0">
          <CollapsibleTrigger
            className="group/collapsible flex min-h-(--control-lg) w-full items-center justify-start gap-2 border-0 bg-transparent p-0 text-left text-base font-medium text-foreground"
            aria-invalid={invalidReason === undefined ? undefined : "true"}
          >
            <ChevronRightIcon
              className="size-4 text-faint transition-transform duration-(--duration-hover) ease-out group-data-[state=open]/collapsible:rotate-90 motion-reduce:transition-none"
              aria-hidden="true"
            />
            <span className="min-w-0 flex-1">
              {label}
              {invalidReason === undefined ? null : (
                <span className="font-normal text-failure"> · {invalidReason}</span>
              )}
            </span>
          </CollapsibleTrigger>
        </h3>
        <CollapsibleContent className="pb-4 pt-3">
          {children}
        </CollapsibleContent>
      </section>
    </Collapsible>
  );
}

/** The divider heading above identity fields or persona settings. */
export function PersonaGroupLabel({ children }: { readonly children: ReactNode }) {
  return (
    <h2 className="m-0 border-t border-border pt-4 text-sm font-medium text-foreground uppercase">
      {children}
    </h2>
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
