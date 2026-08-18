"use client";

import Link from "next/link";

import styles from "./page-navigation.module.css";

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
 */
export function PageNavigation({
  items,
}: {
  readonly items: PageNavigationItems;
}) {
  return (
    <nav className={styles.navigation} aria-label="Breadcrumb">
      <ol className={styles.list}>
        {items.map((item, index) => (
          <li className={styles.item} key={`${item.href ?? "current"}-${item.label}`}>
            {item.href === undefined ? (
              <span className={styles.current} aria-current="page">
                {item.label}
              </span>
            ) : (
              <Link className={styles.link} href={item.href}>
                {item.label}
              </Link>
            )}
            {index === items.length - 1 ? null : (
              <span className={styles.separator} aria-hidden="true">
                /
              </span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}
