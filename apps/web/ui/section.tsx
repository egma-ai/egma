"use client";

import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * The parts a page is laid out from: a titled block, the strip above a list,
 * a group of controls, and a group of facts.
 *
 * They are here rather than in each route page so that every page in the
 * product puts the same thing in the same place at the same density. A page
 * that needs a fifth control puts it in the toolbar beside the others rather
 * than inventing a second row.
 */

/**
 * A titled block of one page: connections, capabilities, traits, history.
 *
 * A detail page is a stack of these rather than one long form, because the
 * blocks answer different questions and are written at different times — and
 * because a heading is what lets somebody land on the part they came for.
 *
 * **There used to be two of these**, one in the old control set and one in the
 * shell, drawn from the same stylesheet classes and differing only in whether
 * the head was a `<header>` and whether the action was wrapped. Ticket 14 asked
 * whether the product keeps one control vocabulary or two; this is the answer
 * for this component. The `<header>` won, because it is what thirteen of the
 * fourteen callers were already getting and because it is what the element is.
 */
export function Section({
  title,
  lead,
  action,
  children,
}: {
  readonly title: string;
  readonly lead?: ReactNode;
  readonly action?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <section className="mt-8 flex flex-col gap-4" data-slot="section">
      <header className="flex items-start justify-between gap-4">
        <div>
          {/*
           * A heading carries no size of its own in this product: the browser's
           * own heading sizes are not on the accepted scale, so every one of
           * them takes its size from a class.
           */}
          <h2 className="m-0 text-lg font-medium">{title}</h2>
          {lead === undefined ? null : (
            <p className="mt-1 mb-0 max-w-[72ch] text-sm leading-(--line-normal) text-muted-foreground">
              {lead}
            </p>
          )}
        </div>
        {action === undefined ? null : <div>{action}</div>}
      </header>
      {children}
    </section>
  );
}

/**
 * A strip of controls above a list: a search box, the filters, and nothing that
 * belongs in the page header.
 */
export function Toolbar({ children }: { readonly children: ReactNode }) {
  return (
    <div className="mb-4 flex items-center gap-3 max-[900px]:flex-wrap">
      {children}
    </div>
  );
}

/** A group of controls that act on the thing the page is about. */
export function Actions({ children }: { readonly children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-3">{children}</div>;
}

/**
 * A labelled group of facts about one thing — what a detail page is mostly
 * made of. A definition list because that is what it is, so a screen reader
 * reads each fact with the name of the fact.
 */
export function Facts({
  facts,
  layout = "grid",
}: {
  readonly facts: readonly {
    readonly label: string;
    readonly value: ReactNode;
  }[];
  /**
   * Keep the compact grid, or put identity facts in one contained panel.
   *
   * The panel is for the short facts that say *which* thing this is: two of
   * them side by side, then one full-width prose fact under them, which is the
   * shape a name, a number and a description actually have. Its last fact
   * keeps the newlines somebody wrote, because a description written in
   * paragraphs is not the same description run together.
   */
  readonly layout?: "grid" | "panel";
}) {
  const panel = layout === "panel";

  return (
    <dl
      className={cn(
        "m-0 grid",
        panel
          ? "grid-cols-2 gap-6 rounded-card border border-border bg-surface p-6 max-[40rem]:grid-cols-1 max-[40rem]:p-5"
          : "grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-4",
      )}
    >
      {facts.map((fact, index) => (
        <div
          className={cn(
            "min-w-0",
            panel &&
              index === facts.length - 1 &&
              "col-span-full max-[40rem]:col-auto",
          )}
          key={fact.label}
        >
          <dt className="mb-1 text-sm text-muted-foreground">{fact.label}</dt>
          <dd
            className={cn(
              "m-0 min-w-0 text-base leading-(--line-normal) text-foreground [overflow-wrap:anywhere]",
              panel && "whitespace-pre-wrap",
            )}
          >
            {fact.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
