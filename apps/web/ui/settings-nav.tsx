"use client";

import Link from "next/link";
import { useId, type ReactNode } from "react";

import { Separator } from "@/components/ui/separator";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

import { projectPath } from "../lib/project-context.ts";

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

/**
 * One link in the navigation.
 *
 * The current one is Ember Wash plus a narrow Ember mark down its leading edge,
 * because state is never colour alone — the mark is the half of it somebody
 * reading in greyscale still gets.
 *
 * **It is the sidebar's row, down to the last value** — 36px on a fine pointer
 * and 44px on a coarse one, 12px of side padding, the 14px step, and the 2px
 * mark inset 8px from either end (`72Y-0`, `72Z-0`). Settings navigation is
 * navigation: a rail that drew its rows at a different height beside the bar
 * that drew them at the board's would read as a second product, and a person
 * moving between the two would feel the change without being able to name it.
 */
const NAV_ITEM = [
  "relative flex w-full min-h-(--control-md) items-center px-3",
  "rounded-button text-sm whitespace-nowrap text-muted-foreground no-underline",
  /*
   * **Colour, and nothing that moves.** `DESIGN.md`: "Navigation row — support
   * routine navigation — colour feedback only." These rows used to answer a
   * press with `scale(0.97)`, borrowed from the button, and a button is the one
   * component that rule is written *against*: a person crosses this list many
   * times a day and never once needs it confirmed that a row was pressed —
   * the page changing says that. The transition names its two properties for
   * the reason `button.tsx` gives.
   *
   * **`motion-reduce:transition-none` went with the movement, on purpose.**
   * `DESIGN.md` asks every movement for "a reduced-motion form with useful
   * opacity or colour feedback" — a colour fade *is* that form. Switching it
   * off under reduced motion removes the fallback instead of the motion, and
   * leaves somebody who asked for less movement with less feedback than
   * everybody else. `sidebar.tsx` came to the same form in the closing sweep.
   */
  "transition-[color,background-color] duration-(--duration-hover) ease-out",
  "pointer-coarse:h-(--tap-target) pointer-coarse:min-h-(--tap-target)",
  /* One row on a wide screen; a cell in a grid once the navigation wraps. */
  "max-[900px]:w-full max-[900px]:whitespace-normal",
];

/**
 * The rows somebody might go to.
 *
 * **Hover belongs here rather than on every row, and a browser is what said
 * so.** The neutral hover plate and Ember Wash are both a background, and with
 * the hover written for all four rows it won: pointing at the row you are
 * already on turned its wash grey, which is the "current" half of the state
 * disappearing under the pointer. Naming the two sets apart is the fix that
 * needs no rule to outrank another — a row is either current or it is not, and
 * only one of these two lists ever reaches it.
 */
const NAV_ITEM_QUIET = [
  "pointer-hover:bg-surface-soft pointer-hover:text-foreground",
];

const NAV_ITEM_CURRENT = [
  "bg-selected text-foreground",
  "before:absolute before:inset-y-2 before:left-0 before:w-0.5",
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
          "flex min-w-0 flex-col gap-1",
          /*
           * The second group is separated from the first — by a line above it
           * in a column, and by a line beside it once the two sit side by side.
           */
          "not-first:mt-1 not-first:border-t not-first:border-border not-first:pt-3",
          "max-[900px]:flex-none max-[900px]:not-first:mt-0",
          "max-[900px]:not-first:border-t-0 max-[900px]:not-first:border-l",
          "max-[900px]:not-first:border-border max-[900px]:not-first:pt-0",
          "max-[900px]:not-first:pl-4",
          "max-[640px]:w-full",
          "max-[640px]:not-first:mt-1 max-[640px]:not-first:border-t",
          "max-[640px]:not-first:border-l-0",
          "max-[640px]:not-first:pt-3 max-[640px]:not-first:pl-0",
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
          className={cn(
            "m-0 flex h-5 items-center px-3",
            "text-sm tracking-(--tracking-label) text-faint uppercase",
          )}
          id={labelId}
        >
          {label}
        </p>
        <div
          className={cn(
            "flex flex-col gap-1",
            "max-[900px]:grid max-[900px]:grid-cols-[repeat(auto-fit,minmax(112px,1fr))]",
            "max-[640px]:grid-cols-1",
          )}
        >
          {items.map((item) => (
            <Link
              key={item.id}
              className={cn(
                NAV_ITEM,
                item.id === current ? NAV_ITEM_CURRENT : NAV_ITEM_QUIET,
              )}
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
        /*
         * **A rail, and a rail is a panel.** The scene board draws the settings
         * navigation as a bordered Pure Paper card beside the page (`2AO-0`)
         * rather than as a column hanging off a divider, which is what this
         * was: a hairline on the right and nothing else made the links read as
         * part of the page's own left margin. The card says they are a place
         * you are in. No corner and no shadow — a rail does not float.
         */
        "flex flex-col items-stretch gap-2",
        "rounded-card border border-border bg-surface p-2",
        /*
         * Narrow, the same card stops being a column beside the page and
         * becomes a card above it — two scopes side by side, still labelled,
         * still not a second horizontal scroll area.
         */
        "max-[900px]:grid max-[900px]:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)]",
        "max-[900px]:items-start max-[900px]:gap-4 max-[900px]:p-3",
        "max-[640px]:grid-cols-[minmax(0,1fr)] max-[640px]:gap-2",
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
 * This is a tab list, not a form choice: changing it changes the visible panel
 * and does not submit a value. Roving focus gives the group one Tab stop, while
 * arrow, Home and End keys follow the tabs pattern.
 *
 * **All of that now comes from the kit rather than from a listener here.** The
 * hand-written version read every key itself, wrapped the index by hand, kept
 * an array of refs so it could move focus, and mapped Up and Down onto a
 * horizontal strip — which the tabs pattern does not do, because Up and Down in
 * a horizontal tablist belong to whatever is around it. Radix publishes the
 * roving tab stop once and gets `dir`, looping, and a disabled tab right in
 * one place. Fifty lines of keyboard code left this file and no behaviour a
 * person relies on left with them.
 *
 * **The panel is not ours.** A caller draws its own `role="tabpanel"` and names
 * it `{id}-{value}-panel`, so the trigger's `id` and `aria-controls` are stated
 * here rather than left to Radix's generated pair. Radix writes both before it
 * spreads a caller's props, so saying them is enough to keep the promise every
 * Settings page was already written against.
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
  return (
    <Tabs
      className="w-full items-start gap-0"
      value={value}
      onValueChange={(next) => onChange(next as Value)}
    >
      <TabsList variant="line" aria-label={label}>
        {options.map((option) => (
          <TabsTrigger
            key={option.value}
            id={`${id}-${option.value}-tab`}
            value={option.value}
            aria-controls={`${id}-${option.value}-panel`}
          >
            {option.label}
          </TabsTrigger>
        ))}
      </TabsList>
      {/*
       * The rail the current tab is marked on, as the element it is rather
       * than as a border belonging to the strip above it. The mark is 2px and
       * overhangs by one, so it reads as sitting on this line.
       */}
      <Separator />
    </Tabs>
  );
}

/**
 * The stable frame every Settings state uses.
 *
 * Settings navigation is local to this area, so it stays beside the page on a
 * wide screen instead of running across the top of every form. On a narrow
 * screen the same card moves above the page and its links wrap into a compact
 * grid, without creating a second horizontal scroll area. Loading and failure
 * states use this frame too, which stops the page from moving when its data
 * arrives.
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
        /*
         * 24px between the rail and the page, which is the page's own gutter:
         * the rail is a panel now, and the 40px it used to be was the space a
         * bare column of links needed to stop reading as part of the form.
         */
        "grid h-full min-h-0 items-start gap-6",
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
          /*
           * This container owns the gap between Settings groups, so the
           * `Section`s inside it give up their own top margin. Without it the
           * gap is `Section`'s 32px of margin on top of this container's 32px
           * of gap, and the first group starts 32px below where the navigation
           * does. Measured at `margin-top: 0px` in a browser.
           *
           * **The `!` these carried is gone with the stylesheet it was
           * fighting.** `Section` drew its margin from `system.module.css`,
           * and a CSS Module is unlayered — it beat every Tailwind utility
           * whatever the specificity, because a layer loses to no layer.
           * `Section` is a utility now, so this is an ordinary specificity
           * question and these rules already win it: a class plus a child
           * combinator and an element outranks the plain class the margin
           * comes from.
           */
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
