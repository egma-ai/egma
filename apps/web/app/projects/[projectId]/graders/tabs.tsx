"use client";

import Link from "next/link";

import { graderTabsFor, type GraderTab } from "../../../../lib/presentation.ts";
import styles from "../../../../ui/settings-nav.module.css";

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
    <nav className={styles.nav} aria-label="Graders">
      <div className={styles.group}>
        <div className={styles.items}>
          {graderTabsFor(projectId).map((tab) => (
            <Link
              key={tab.id}
              className={`${styles.item} ${
                active === tab.id ? styles.itemActive : ""
              }`}
              href={tab.href}
              aria-current={active === tab.id ? "page" : undefined}
            >
              {tab.label}
            </Link>
          ))}
        </div>
      </div>
    </nav>
  );
}
