"use client";

import Link from "next/link";
import type { ReactNode } from "react";

import { projectPath } from "../lib/project-context.ts";
import styles from "./settings-nav.module.css";

/**
 * The navigation every Settings page wears, and the one thing it exists to make
 * unmissable: **which of these settings belong to the project, and which belong
 * to the organization.**
 *
 * The project selector stays on screen throughout Settings, because somebody
 * has to be able to see where they are and to leave. That is also the trap: a
 * flat list of five links under a visible project control reads as five
 * settings *of that project*, and four of them are not. Members, invitations,
 * retention and API keys are the organization's, and an admin who changed one
 * believing it applied to Outbound only would be wrong in a way no page told
 * them about.
 *
 * So the two scopes are two labelled groups. It is the smallest arrangement
 * that states the fact rather than leaving it to be inferred.
 *
 * **Every address carries the project**, including the organization-wide ones.
 * They are not project settings, and they still have to be reachable without
 * leaving the product shell — the selector needs a project to show, and
 * switching project from Settings has to land back in Settings rather than
 * throwing somebody out to Agents. `ScopeNote` is how an organization-wide page
 * says in words what its address cannot.
 */

export type SettingsSection =
  | "project"
  | "judge"
  | "organization"
  | "people"
  | "keys";

type Item = {
  readonly id: SettingsSection;
  readonly label: string;
  /** The path under the project's settings, or nothing for the root. */
  readonly rest: readonly string[];
};

const PROJECT_SETTINGS: readonly Item[] = [
  { id: "project", label: "Project", rest: [] },
  { id: "judge", label: "Judge", rest: ["judge"] },
];

const ORGANIZATION_SETTINGS: readonly Item[] = [
  { id: "organization", label: "Organization", rest: ["organization"] },
  { id: "people", label: "People", rest: ["people"] },
  { id: "keys", label: "API keys", rest: ["keys"] },
];

/** Where one Settings page lives, for anything that links to it. */
export function settingsPath(
  projectId: string,
  section: SettingsSection = "project",
): string {
  const item = [...PROJECT_SETTINGS, ...ORGANIZATION_SETTINGS].find(
    (one) => one.id === section,
  );
  return projectPath(projectId, "settings", ...(item?.rest ?? []));
}

export function SettingsNav({
  projectId,
  current,
}: {
  readonly projectId: string;
  readonly current: SettingsSection;
}) {
  const group = (label: string, items: readonly Item[]) => (
    <div className={styles.group}>
      <p className={styles.groupLabel}>{label}</p>
      <div className={styles.items}>
        {items.map((item) => (
          <Link
            key={item.id}
            className={`${styles.item} ${
              item.id === current ? styles.itemActive : ""
            }`}
            href={settingsPath(projectId, item.id)}
            aria-current={item.id === current ? "page" : undefined}
          >
            {item.label}
          </Link>
        ))}
      </div>
    </div>
  );

  return (
    <nav className={styles.nav} aria-label="Settings">
      {group("This project", PROJECT_SETTINGS)}
      {group("Organization", ORGANIZATION_SETTINGS)}
    </nav>
  );
}

/**
 * What an organization-wide Settings page says under its heading.
 *
 * The selector is still on screen and still naming a project, because leaving
 * Settings has to be possible from every page in it. This is the sentence that
 * stops that being read as a claim: what is on this page applies to everybody
 * in the organization, in every project, whichever one the selector says.
 */
export function ScopeNote({ children }: { readonly children: ReactNode }) {
  return <p className={styles.scopeNote}>{children}</p>;
}
