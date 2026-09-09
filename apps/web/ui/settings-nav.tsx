"use client";

import Link from "next/link";
import { useId, type ReactNode } from "react";

import { Separator } from "@/components/ui/separator";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

import { projectPath } from "../lib/project-context.ts";

/**
 * Group project and organization settings explicitly. Organization settings
 * retain project-scoped URLs for shell navigation without changing their scope.
 */

export type SettingsSection =
  | "project"
  | "organization"
  | "people"
  | "keys"
  | "provider-api-keys"
  | "billing";

type Item = {
  readonly id: SettingsSection;
  readonly label: string;
  /** The path under the project's settings. */
  readonly rest: readonly string[];
};

const PROJECT_SETTINGS: readonly Item[] = [
  { id: "project", label: "Project Settings", rest: ["project"] },
];

const ORGANIZATION_SETTINGS: readonly Item[] = [
  { id: "organization", label: "Organization Settings", rest: ["organization"] },
  { id: "billing", label: "Usage and Billing", rest: ["billing"] },
  {
    id: "provider-api-keys",
    label: "Provider API Keys",
    rest: ["provider-api-keys"],
  },
  { id: "people", label: "People", rest: ["people"] },
  { id: "keys", label: "API Keys", rest: ["keys"] },
];

/** Where one Settings page lives, for anything that links to it. */
export function settingsPath(
  projectId: string,
  section: SettingsSection = "organization",
): string {
  const item = [...PROJECT_SETTINGS, ...ORGANIZATION_SETTINGS].find(
    (one) => one.id === section,
  );
  return projectPath(projectId, "settings", ...(item?.rest ?? []));
}

/**
 * Match sidebar navigation sizing and targets. The active edge mark supports
 * the current-page color treatment.
 */
const NAV_ITEM = [
  "relative flex w-full min-h-(--control-md) items-center px-3",
  "rounded-button text-sm whitespace-nowrap text-muted-foreground no-underline",
  /*
   * Use color feedback without spatial press motion for routine navigation.
   * Reduced motion retains that non-spatial feedback.
   */
  "transition-[color,background-color] duration-(--duration-hover) ease-out",
  "pointer-coarse:h-(--tap-target) pointer-coarse:min-h-(--tap-target)",
  /* One row on a wide screen; a cell in a grid once the navigation wraps. */
  "max-[900px]:w-full max-[900px]:whitespace-normal",
];

/**
 * Apply neutral hover styling only to inactive rows so it cannot replace the
 * current row's selected background.
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
         * Label each settings group by scope so organization settings are not mistaken
         * for settings of the selected project.
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
      {group("Organization", ORGANIZATION_SETTINGS)}
      {group("Project", PROJECT_SETTINGS)}
    </nav>
  );
}

/**
 * Use shared tabs for peer settings panels. Callers render their own tabpanel
 * with ID {id}-{value}-panel; explicit trigger IDs and aria-controls preserve
 * that association.
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
  readonly options: readonly {
    readonly value: Value;
    readonly label: string;
  }[];
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
 * Keep settings navigation beside content on wide screens and above it on
 * narrow screens. Share this frame across loaded, loading, and failed states.
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
           * Remove child Section top margins because this container already supplies
           * the gaps between settings groups.
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
