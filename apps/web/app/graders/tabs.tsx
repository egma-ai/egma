"use client";

import Link from "next/link";

import { GRADER_TABS, type GraderTab } from "../../lib/presentation.ts";
import { styles } from "../ui.tsx";

/**
 * The strip that moves between the two grader screens.
 *
 * **Two screens, one section, and the strip is what says so.** The shelf of
 * definitions and the copies a project is judging with are the two halves of
 * one idea — a grader is a copy *of* an entry — and the main navigation names
 * the section rather than either screen. Splitting them into two sidebar
 * entries would make them look like two features.
 *
 * Its labels come from the shared navigation file rather than from either
 * screen's copy, because the tab that is not current has to be named by
 * something neither page owns.
 */
export function GraderTabs({ active }: { readonly active: GraderTab }) {
  return (
    <nav className={styles.tabStrip} aria-label="Graders">
      {GRADER_TABS.map((tab) => (
        <Link
          key={tab.id}
          href={tab.href}
          className={active === tab.id ? styles.tabActive : undefined}
          aria-current={active === tab.id ? "page" : undefined}
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}
