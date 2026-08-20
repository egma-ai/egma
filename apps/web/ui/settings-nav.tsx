"use client";

import Link from "next/link";
import { useId, useRef, type ReactNode } from "react";

import { projectPath } from "../lib/project-context.ts";
import styles from "./settings-nav.module.css";

/**
 * The navigation every Settings page wears, and the one thing it exists to make
 * unmissable: **which of these settings belong to the project, and which belong
 * to the organization.**
 *
 * The project selector stays on screen throughout Settings, because somebody
 * has to be able to see where they are and to leave. That is also the trap: a
 * flat list under a visible project control reads as settings *of that
 * project*, but organization details, people and API keys are organization
 * settings. An admin who changed one
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
 * throwing somebody out to Agents. The grouped navigation states the scope
 * once, without repeating a callout on every organization page.
 */

export type SettingsSection =
  | "project"
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
  const id = useId();
  const group = (label: string, items: readonly Item[]) => {
    const labelId = `${id}-${items[0]?.id ?? "group"}`;
    return (
      <div className={styles.group} role="group" aria-labelledby={labelId}>
        <p className={styles.groupLabel} id={labelId}>
          {label}
        </p>
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
  };

  return (
    <nav className={styles.nav} aria-label="Settings">
      {group("This project", PROJECT_SETTINGS)}
      {group("Organization", ORGANIZATION_SETTINGS)}
    </nav>
  );
}

/**
 * Switch between peer views inside one Settings page.
 *
 * This is a tab list, not a form choice: changing it changes the visible
 * panel and does not submit a value. Roving focus gives the group one Tab stop,
 * while arrow, Home and End keys follow the tabs pattern.
 */
export function SettingsTabs<Value extends string>({
  id,
  label,
  value,
  options,
  onChange,
}: {
  readonly id: string;
  readonly label: string;
  readonly value: Value;
  readonly options: readonly { readonly value: Value; readonly label: string }[];
  readonly onChange: (value: Value) => void;
}) {
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const move = (to: number) => {
    const option = options[to];
    if (option === undefined) return;
    onChange(option.value);
    tabs.current[to]?.focus();
  };

  return (
    <div className={styles.tabs} role="tablist" aria-label={label}>
      {options.map((option, at) => (
        <button
          key={option.value}
          ref={(held) => {
            tabs.current[at] = held;
          }}
          className={styles.tab}
          id={`${id}-${option.value}-tab`}
          type="button"
          role="tab"
          aria-selected={value === option.value}
          aria-controls={`${id}-${option.value}-panel`}
          tabIndex={value === option.value ? 0 : -1}
          onClick={() => onChange(option.value)}
          onKeyDown={(event) => {
            const last = options.length - 1;
            const next =
              event.key === "ArrowRight" || event.key === "ArrowDown"
                ? (at + 1) % options.length
                : event.key === "ArrowLeft" || event.key === "ArrowUp"
                  ? (at - 1 + options.length) % options.length
                  : event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? last
                      : null;
            if (next === null) return;
            event.preventDefault();
            move(next);
          }}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/**
 * The stable frame every Settings state uses.
 *
 * Settings navigation is local to this area, so it stays beside the page on a
 * wide screen instead of becoming a large card above every form. On a narrow
 * screen the same links wrap into a compact grid without creating a second
 * horizontal scroll area. Loading and failure states use this frame too,
 * which stops the page from moving when its data arrives.
 */
export function SettingsLayout({
  projectId,
  current,
  children,
}: {
  readonly projectId: string;
  readonly current: SettingsSection;
  readonly children: ReactNode;
}) {
  return (
    <div className={styles.layout}>
      <SettingsNav projectId={projectId} current={current} />
      <div className={styles.content}>{children}</div>
    </div>
  );
}
