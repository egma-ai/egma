"use client";

import Link from "next/link";

import { cn } from "@/lib/utils";

type ParentNavigationItem = {
  readonly label: string;
  readonly href: string;
};

type CurrentNavigationItem = {
  readonly label: string;
  readonly href?: never;
};

/** At least one linked parent, followed by the current page. */
export type PageNavigationItems = readonly [
  ParentNavigationItem,
  ...ParentNavigationItem[],
  CurrentNavigationItem,
];

/** One step of a trail, whichever kind it is. */
export type PageNavigationItem = ParentNavigationItem | CurrentNavigationItem;

/** A trail with at least one step left in it. */
export type DrawnTrail = readonly [PageNavigationItem, ...PageNavigationItem[]];

/**
 * The trail a page draws, ending with the page's own name.
 *
 * **The trail and the title are one line.** They used to be two: the trail was
 * cut short of the record and the record stood beside it as a larger heading,
 * so "Tests / Livekit agent suite" read as a small underlined link next to a
 * big title and the slash between them was missing. One line, one type, one
 * link — "Tests" goes back to the list, and the last step is the page
 * (developer decision, 2026-08-26).
 *
 * A page passes its real trail and its title. Where the trail already ends
 * with the title, that step *is* the page and nothing is added. Where a page
 * titles itself something the trail does not say, the title joins the line as
 * its last step, so neither the trail nor the title is lost.
 */
export function trailWithTitle(
  items: PageNavigationItems | undefined,
  title: string,
): DrawnTrail | undefined {
  if (items === undefined) return undefined;
  return items[items.length - 1]?.label === title
    ? items
    : [...items, { label: title }];
}

/**
 * The one navigation model for a page below a product section.
 *
 * The shell says which stable product section somebody is in. This module says
 * where the current record sits inside that section: run, then simulation;
 * agent, then connection; Settings, then one settings page. Pages provide only
 * the ordered labels and parent addresses. List navigation, separators,
 * current-page semantics and narrow-screen wrapping stay here.
 *
 * Operational controls never belong here. Cancel, Retry, Edit, Archive and
 * Save remain page actions because they change the current record rather than
 * move through its hierarchy.
 *
 * **This one is not built on a kit primitive, and that is the finding rather
 * than an omission.** The structure-and-navigation migration rebuilt its two
 * neighbours — a tab strip became the kit's tabs, a hand-drawn rule became the
 * kit's separator — and looked for the same here. There is nothing to move to:
 * the kit holds no breadcrumb, the trail is an ordered list because that is
 * what a trail is, and the separator between two crumbs is a `/` a reader
 * understands and not a rule. The rest of the file was already on the shared
 * vocabulary — semantic tokens, the fine-pointer hover variant, a coarse-
 * pointer target — and carries no motion, which is what `DESIGN.md` asks of a
 * navigation row. Rewriting it would have been churn with a diff attached.
 */
export function PageNavigation({ items }: { readonly items: DrawnTrail }) {
  return (
    <nav
      /*
       * **The room under the trail is for the width where it wraps.** In the
       * 56px bar the trail and the heading are one centred row, and a bottom
       * margin there lifts the trail off the heading's line by half of it —
       * which nobody could see while the trail ended with the page's own name
       * and ran the width of the bar. Under 900px the bar becomes the page's
       * first lines and the trail takes a line of its own, which is where the
       * 12px belongs.
       */
      className="mb-0 min-w-0 max-[900px]:mb-3"
      data-slot="page-navigation"
      aria-label="Breadcrumb"
    >
      <ol className="m-0 flex min-w-0 list-none flex-wrap items-center gap-2 p-0">
        {items.map((item, index) => (
          <li
            className={cn(
              "inline-flex max-w-full min-w-0 items-center gap-2",
              "text-sm leading-(--line-normal) text-faint",
            )}
            key={`${item.href ?? "current"}-${item.label}`}
          >
            {item.href === undefined ? (
              /*
               * The last step is the page, so it is the page's `<h1>`. It
               * carries the line's own type rather than a heading size: the
               * trail is one line of navigation, and a step in a different
               * size would say the two halves are different kinds of thing.
               */
              <h1
                className="m-0 text-sm font-normal text-foreground [overflow-wrap:anywhere]"
                aria-current="page"
              >
                {item.label}
              </h1>
            ) : (
              <Link
                className={cn(
                  "max-w-full min-w-0 text-muted-foreground [overflow-wrap:anywhere]",
                  "decoration-border-strong decoration-1 underline-offset-4",
                  "pointer-hover:text-foreground pointer-hover:decoration-current",
                  /* A real touch target, without changing what a mouse gets. */
                  "pointer-coarse:inline-flex pointer-coarse:min-h-(--tap-target)",
                  "pointer-coarse:items-center",
                )}
                href={item.href}
              >
                {item.label}
              </Link>
            )}
            {index === items.length - 1 ? null : (
              <span className="text-border-strong" aria-hidden="true">
                /
              </span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}
