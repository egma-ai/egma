"use client";

import Link from "next/link";
import { useId, useRef, type ReactNode } from "react";

import { cn } from "@/lib/utils";

import { projectPath } from "../lib/project-context.ts";

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
 * throwing somebody out to Agents. The grouped navigation states the scope
 * once, without repeating a callout on every organization page.
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

/**
 * One link in the navigation.
 *
 * The current one is Ember Wash plus a narrow Ember mark down its leading edge,
 * because state is never colour alone — the mark is the half of it somebody
 * reading in greyscale still gets.
 */
const NAV_ITEM = [
  "relative flex w-full min-h-(--control-lg) items-center px-3",
  "rounded-button text-base whitespace-nowrap text-muted-foreground no-underline",
  "transition-transform duration-(--duration-press) ease-out",
  "pointer-coarse:h-(--tap-target) pointer-coarse:min-h-(--tap-target)",
  "pointer-hover:bg-surface-soft pointer-hover:text-foreground",
  "[&:active:not(:focus-visible)]:scale-97",
  "motion-reduce:transition-none",
  "motion-reduce:[&:active:not(:focus-visible)]:scale-100",
  /* One row on a wide screen; a cell in a grid once the navigation wraps. */
  "max-[900px]:w-full max-[900px]:whitespace-normal",
];

const NAV_ITEM_CURRENT = [
  "bg-selected text-foreground",
  "before:absolute before:top-3 before:bottom-3 before:left-0 before:w-0.5",
  "before:rounded-chip before:bg-brand before:content-['']",
];

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
      <div
        className={cn(
          "flex min-w-0 flex-col gap-2",
          /*
           * The second group is separated from the first — by a line above it
           * in a column, and by a line beside it once the two sit side by side.
           */
          "not-first:border-t not-first:border-border not-first:pt-5",
          "max-[900px]:flex-none",
          "max-[900px]:not-first:border-t-0 max-[900px]:not-first:border-l",
          "max-[900px]:not-first:border-border max-[900px]:not-first:pt-0",
          "max-[900px]:not-first:pl-6",
          "max-[640px]:w-full",
          "max-[640px]:not-first:border-t max-[640px]:not-first:border-l-0",
          "max-[640px]:not-first:pt-4 max-[640px]:not-first:pl-0",
        )}
        role="group"
        aria-labelledby={labelId}
      >
        {/*
         * Which scope a run of items belongs to, said out loud above them.
         *
         * **This label is the whole reason the navigation is grouped rather
         * than one flat row.** Members, invitations, retention and API keys
         * belong to the organization; a page that listed them beside the
         * project's own settings, with the project selector on screen, would be
         * quietly saying they belong to whichever project is selected — and
         * somebody would eventually believe it.
         */}
        <p
          className="m-0 px-2 text-xs tracking-(--tracking-label) text-faint uppercase"
          id={labelId}
        >
          {label}
        </p>
        <div
          className={cn(
            "flex flex-col gap-1",
            "max-[900px]:grid max-[900px]:grid-cols-[repeat(auto-fit,minmax(112px,1fr))]",
            "max-[640px]:grid-cols-2",
          )}
        >
          {items.map((item) => (
            <Link
              key={item.id}
              className={cn(NAV_ITEM, item.id === current && NAV_ITEM_CURRENT)}
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
    <nav
      className={cn(
        "flex flex-col items-stretch gap-5 border-r border-border pr-5",
        /*
         * Narrow, the navigation stops being a column beside the page and
         * becomes a card above it — two scopes side by side, still labelled,
         * still not a second horizontal scroll area.
         */
        "max-[900px]:static max-[900px]:grid max-[900px]:overflow-visible",
        "max-[900px]:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)] max-[900px]:items-start",
        "max-[900px]:gap-5 max-[900px]:rounded-card max-[900px]:border",
        "max-[900px]:border-border max-[900px]:bg-surface max-[900px]:p-3",
        "max-[640px]:grid-cols-[minmax(0,1fr)] max-[640px]:gap-4",
        "max-[640px]:overflow-x-visible",
      )}
      aria-label="Settings"
    >
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
    <div
      className="flex w-full items-end gap-5 border-b border-border"
      role="tablist"
      aria-label={label}
    >
      {options.map((option, at) => (
        <button
          key={option.value}
          ref={(held) => {
            tabs.current[at] = held;
          }}
          className={cn(
            "relative inline-flex min-h-(--control-lg) items-center px-0 pb-2",
            "cursor-pointer border-0 bg-transparent text-sm text-muted-foreground",
            "pointer-hover:text-foreground",
            "aria-selected:font-medium aria-selected:text-foreground",
            /* The chosen tab sits on the group's own line, not above it. */
            "aria-selected:after:absolute aria-selected:after:-bottom-px",
            "aria-selected:after:right-0 aria-selected:after:left-0",
            "aria-selected:after:h-0.5 aria-selected:after:rounded-chip",
            "aria-selected:after:bg-brand aria-selected:after:content-['']",
          )}
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
 *
 * The rules for `section`, `region` and `tabpanel` reach into whatever the page
 * puts here, because the page supplies its own states and this frame is what
 * spaces them. They are child selectors for that reason and not by preference.
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
    <div
      className={cn(
        "grid h-full min-h-0 items-start gap-10",
        "grid-cols-[minmax(176px,220px)_minmax(0,1fr)]",
        "max-[900px]:grid-cols-[minmax(0,1fr)]",
        "max-[900px]:grid-rows-[auto_minmax(0,1fr)] max-[900px]:gap-5",
      )}
    >
      <SettingsNav projectId={projectId} current={current} />
      <div
        className={cn(
          "flex h-full min-w-0 min-h-0 flex-col gap-8 overflow-y-auto",
          "overscroll-contain pr-2 pb-10 [scrollbar-gutter:stable]",
          "[&>section]:mt-0",
          "[&>[role=region]]:flex [&>[role=region]]:flex-col [&>[role=region]]:gap-8",
          "[&>[role=region]>section]:mt-0",
          "[&>[role=tabpanel]]:flex [&>[role=tabpanel]]:flex-col",
          "[&>[role=tabpanel]]:gap-8",
          "[&>[role=tabpanel]>section]:mt-0",
        )}
      >
        {children}
      </div>
    </div>
  );
}
