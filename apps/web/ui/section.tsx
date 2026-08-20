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
 * A strip of controls above a list: the filters, and the one action the list
 * itself offers.
 *
 * **One shape on every list page, because the developer read five of them side
 * by side and none of them agreed.** Filters go left, in the order a person
 * narrows by; the action goes hard right. The Agents page used to do the
 * opposite — an oversized-looking button leading the row and a search box
 * running the whole remaining width behind it — and that single row is what
 * made the product look like a side project beside a competitor's dashboard.
 *
 * The action is a slot rather than the last child, so a page cannot put it
 * anywhere else by accident. It is `flex-none`: an action is the width of its
 * own label, and the filters take what is left.
 */
export function Toolbar({
  children,
  action,
}: {
  readonly children: ReactNode;
  /** The one thing this list offers, drawn at the right end of the strip. */
  readonly action?: ReactNode;
}) {
  return (
    <div className="mb-4 flex items-center justify-between gap-3 max-[900px]:flex-wrap">
      <div className="flex min-w-0 flex-wrap items-center gap-3">{children}</div>
      {action === undefined ? null : (
        <div className="flex flex-none flex-wrap items-center justify-end gap-3">
          {action}
        </div>
      )}
    </div>
  );
}

/**
 * How wide a control in a toolbar is allowed to be.
 *
 * **Declared once here rather than page by page**, which is the whole point:
 * five pages each choosing a width is what a person sees as five different
 * products. A search box was `width: 100%` of whatever was left, so on a wide
 * screen it ran to 1500px for a field holding a name; a filter that names one
 * column never needs more room than its longest option.
 *
 * `min-w-*` keeps both usable at the wrap point, where the strip becomes two
 * rows and each control is on its own line.
 *
 * **`flex-1` on the search is load-bearing, and a screenshot is what found
 * it.** The shared `Input` is `width: 100%`, which in a wrapping flex row means
 * 100% *of the row* — so the search box claimed the whole line and pushed the
 * agent filter beside it onto a second one. `flex-1` sets `flex-basis: 0%`,
 * which wins the main axis back from `width`: the box grows into whatever the
 * filters leave and stops at its maximum.
 */
export const TOOLBAR_SEARCH = "min-w-[180px] w-full max-w-[380px] flex-1";

/** A filter that chooses one value, held narrower than the search beside it. */
export const TOOLBAR_FILTER = "w-auto max-w-[240px] min-w-[160px]";

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
