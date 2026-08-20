"use client";

import Link from "next/link";

import { graderTabsFor, type GraderTab } from "../../../../lib/presentation.ts";

/**
 * One tab, and the current one.
 *
 * The current tab is marked twice: `aria-current="page"` for whoever is not
 * looking at it, and an Ember rule under it for whoever is. `DESIGN.md` keeps
 * colour as supporting information, and the underline is a shape rather than a
 * colour — a tab whose rule is drawn is the current tab in a screenshot with
 * every colour removed.
 *
 * Below 640px the strip stops being a row of words with room between them and
 * becomes two equal halves, because two tabs 24px apart on a phone are two
 * targets somebody has to aim between.
 */
const TAB =
  "inline-flex min-h-(--tap-target) items-center -mb-px px-1 " +
  "border-b-2 border-b-transparent " +
  "text-sm text-muted-foreground no-underline " +
  "max-[640px]:flex-1 max-[640px]:justify-center";

const TAB_CURRENT = "border-b-brand text-foreground";

/**
 * What sits under the strip on both grader screens.
 *
 * It is here rather than on either page because both draw it and the two have
 * to stay the same: a section that started at a different distance from the
 * strip on one screen would read as a different kind of thing.
 *
 * `mt-0!` is the cascade rather than a shortcut: a shared `Section` carries its
 * own top margin for a page's main column, and this column already spaces its
 * children. CSS Modules are unlayered, so an ordinary utility loses to them
 * whatever the class list says — important is what reaches across. It goes when
 * `Section` is migrated and can be told directly.
 */
export const VIEW_CONTENT = "mt-5 flex flex-col gap-5 [&>section]:mt-0!";

/**
 * The strip that moves between the two grader screens of one project.
 *
 * **Two screens, one section, and the strip is what says so.** The shelf of
 * definitions and the copies this project is judging with are the two halves of
 * one idea — a grader is a copy *of* an entry — and the navigation names the
 * section rather than either screen. Splitting them into two navigation items
 * would make them look like two features.
 *
 * **Every address carries the project**, because both screens are about one
 * project: the shelf is read in a project's name, and pressing Use there puts a
 * copy on that project. This is the whole reason the pair moved under
 * `/projects/:projectId/graders`. The organization-wide pair that came in from
 * `main` had no project in the address at all, so the shell fell back to
 * whichever project was first in the viewer's list and Use landed on a project
 * nobody was looking at.
 *
 * Its labels come from the shared presentation file rather than from either
 * screen's copy, because the tab that is not current has to be named by
 * something neither page owns.
 */
export function GraderTabs({
  projectId,
  active,
}: {
  readonly projectId: string;
  readonly active: GraderTab;
}) {
  return (
    <nav
      className="flex items-end gap-6 border-b border-border max-[640px]:gap-0"
      aria-label="Grader views"
    >
      {graderTabsFor(projectId).map((tab) => (
        <Link
          key={tab.id}
          className={`${TAB} ${active === tab.id ? TAB_CURRENT : ""}`}
          href={tab.href}
          aria-current={active === tab.id ? "page" : undefined}
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}
