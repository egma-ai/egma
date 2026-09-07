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

/**
 * At least one linked parent, followed by the current page.
 *
 * **Exactly one step has no address, and it is the last one.** That step is
 * the page: this file draws it as the page's `<h1>` and the one
 * `aria-current="page"`, so a trail carrying two of them would be a page with
 * two names. The type is what stops that, at every call site.
 */
export type PageNavigationItems = readonly [
  ParentNavigationItem,
  ...ParentNavigationItem[],
  CurrentNavigationItem,
];

/**
 * Render ordered parent links and the current page heading with shared
 * separators and responsive wrapping. Keep operational actions outside the trail.
 */
export function PageNavigation({ items }: { readonly items: PageNavigationItems }) {
  return (
    <nav
      /*
       * **The room under the trail is for the width where it wraps.** In the
       * 56px bar the trail is the whole line and needs no room under it. Under
       * 900px the bar becomes the page's first lines and the trail takes a
       * line of its own, which is where the 12px belongs.
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
               * Use the final segment as h1. Truncate in the fixed-height wide header and
               * allow wrapping when the narrow header grows with its content.
               */
              <h1
                className={cn(
                  "m-0 min-w-0 max-w-full text-sm font-normal text-foreground",
                  "[overflow-wrap:anywhere] min-[901px]:truncate",
                )}
                aria-current="page"
              >
                {item.label}
              </h1>
            ) : (
              <Link
                className={cn(
                  "max-w-full min-w-0 text-muted-foreground no-underline [overflow-wrap:anywhere]",
                  "decoration-border-strong decoration-1 underline-offset-4",
                  "pointer-hover:text-foreground pointer-hover:underline",
                  "pointer-hover:decoration-current",
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
              <span className="text-faint" aria-hidden="true">
                /
              </span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}
