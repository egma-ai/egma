"use client";

import type { ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { ownerSaid, type Persona } from "@/lib/personas.ts";

/**
 * Persona page primitives, read off Paper page 12 — "Personas · Complete flow
 * + Dropdowns" (developer decisions, 2026-09-15): three caps groups with a
 * hairline only between groups, plain subsection headers under Settings with
 * no toggle, and label-beside-value rows on the read page.
 */

/** Which page a primitive is drawn on; the read page is quieter than the form. */
export type PersonaPage = "form" | "read";

/** METADATA, WHO THEY ARE or SETTINGS: the 16px caps label that heads a group. */
export function PersonaGroupLabel({
  divider = false,
  page = "form",
  children,
}: {
  /** The hairline between groups; the first group draws none. */
  readonly divider?: boolean;
  readonly page?: PersonaPage;
  readonly children: ReactNode;
}) {
  return (
    <h2
      className={cn(
        "m-0 text-base font-medium tracking-normal text-foreground uppercase",
        /* The room under the hairline: 16px on the form, 20px on the read page. */
        divider && "border-t border-border",
        divider && (page === "form" ? "pt-4" : "pt-5"),
      )}
    >
      {children}
    </h2>
  );
}

/**
 * One subsection under Settings: a plain header over its fields, with no line
 * above it and no toggle. `htmlFor` makes the header the control's own label
 * when the subsection holds one control, as Language does.
 */
export function PersonaSubsection({
  label,
  htmlFor,
  invalidReason,
  page = "form",
  children,
}: {
  readonly label: string;
  readonly htmlFor?: string;
  readonly invalidReason?: string;
  readonly page?: PersonaPage;
  readonly children: ReactNode;
}) {
  const said = (
    <>
      {label}
      {invalidReason === undefined ? null : (
        <span className="font-normal text-failure"> · {invalidReason}</span>
      )}
    </>
  );
  return (
    <section className="flex min-w-0 flex-col gap-3 pt-2" aria-label={label}>
      {page === "form" ? (
        <h3 className="m-0 flex min-h-(--control-lg) items-center text-base font-medium text-foreground">
          {htmlFor === undefined ? <span>{said}</span> : <label htmlFor={htmlFor}>{said}</label>}
        </h3>
      ) : (
        <h3 className="m-0 text-sm font-medium text-foreground">{said}</h3>
      )}
      {children}
    </section>
  );
}

/** A persona field: the label printed as the boards print it, star and all, in one ink. */
export function PersonaField({
  label,
  htmlFor,
  children,
}: {
  readonly label: string;
  readonly htmlFor: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2" data-slot="field">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
    </div>
  );
}

/** One fact on the read page. */
export type PersonaReadRow = {
  readonly label: string;
  readonly value: ReactNode;
};

/**
 * The label in faint ink at the left, the value beside it, rows 12px apart.
 *
 * Under the shell's one layout breakpoint the label lane would leave a phone's
 * value column a few words wide, so there each label stands over its value.
 */
export function PersonaReadRows({ rows }: { readonly rows: readonly PersonaReadRow[] }) {
  return (
    <dl className="m-0 flex min-w-0 flex-col gap-3">
      {rows.map((row) => (
        <div
          className="flex min-w-0 items-start gap-6 max-[900px]:flex-col max-[900px]:gap-1"
          key={row.label}
        >
          <dt className="m-0 w-(--persona-read-label-width) flex-none text-sm text-faint max-[900px]:w-auto">
            {row.label}
          </dt>
          <dd className="m-0 min-w-0 flex-1 text-sm whitespace-pre-wrap text-foreground [overflow-wrap:anywhere]">
            {row.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** The Type value on the read page: one word on a soft plate inside a hairline. */
export function PersonaTypePlate({ owner }: { readonly owner: Persona["owner"] }) {
  return (
    <span className="inline-flex items-center border border-border bg-surface-soft px-2.5 py-0.5 text-sm text-foreground">
      {ownerSaid(owner)}
    </span>
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
