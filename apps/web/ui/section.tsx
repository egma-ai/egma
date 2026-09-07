"use client";

import { SearchIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";

import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
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

/** Shared titled section with optional actions for related page content. */
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
 * Place list filters on the left and the action in a separate right-hand slot.
 * Keep the action at its content width while filters use remaining space.
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
    /*
     * 52px: a 36px control with the boards' 16px under it (`71N-0`). The gap
     * is 20px because that is the gap the board leaves between the filters and
     * the action, and the whole strip is held to the page's content maximum so
     * the action lands over the last column of the table below it.
     */
    <div
      data-slot="toolbar"
      className={cn(
        "flex w-full max-w-(--page-content-max) items-center justify-between gap-5 pb-4",
        "max-[900px]:flex-wrap",
      )}
    >
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
 * Shared compact toolbar search. Give the input an accessible label and keep
 * the magnifier decorative.
 */
export function SearchField({
  className,
  ...props
}: ComponentProps<typeof Input>) {
  return (
    <div className={cn("relative flex-none", className)} data-slot="search-field">
      <SearchIcon
        className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-faint"
        aria-hidden="true"
        strokeWidth={1.75}
      />
      <Input type="search" className={cn(TOOLBAR_SEARCH, "pl-9")} {...props} />
    </div>
  );
}

/**
 * Bound toolbar controls while allowing wrapping. flex-1 gives search a zero
 * basis so Input's full width does not push adjacent filters to another row.
 */
export const TOOLBAR_SEARCH = [
  "w-(--search-width) max-w-full min-h-(--control-md) text-sm",
  /* One column on a phone, where 300px is most of the screen. */
  "max-[900px]:w-full",
].join(" ");

/** A filter that chooses one value, held narrower than the search beside it. */
export const TOOLBAR_FILTER =
  "w-auto max-w-[240px] min-w-[160px] min-h-(--control-md) text-sm";

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

  const list = (
    <dl
      className={cn(
        "m-0 grid",
        panel
          ? "grid-cols-2 gap-6 max-[40rem]:grid-cols-1"
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

  if (!panel) return list;

  /*
   * Compose a definition list inside the shared Card instead of copying its
   * surface styles onto a separate element.
   */
  return <Card className="max-[40rem]:p-5">{list}</Card>;
}
