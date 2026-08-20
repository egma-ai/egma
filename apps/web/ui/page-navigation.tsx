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
export function PageNavigation({
  items,
}: {
  readonly items: PageNavigationItems;
}) {
  return (
    <nav
      className="mb-3 min-w-0"
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
              <span
                className="text-foreground [overflow-wrap:anywhere]"
                aria-current="page"
              >
                {item.label}
              </span>
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
