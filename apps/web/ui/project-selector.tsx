"use client";

import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { usePathname } from "next/navigation";
import { useState } from "react";

import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

import { projectsMatching, type Organization, type Project } from "../lib/me.ts";
import { inProject } from "../lib/project-context.ts";
import { NEW_PROJECT_PATH } from "../lib/settings.ts";
import { useDraftNavigation } from "./draft-navigation.tsx";
import { Menu, MenuDivider, MenuItem, MenuLabel } from "./menu.tsx";

/**
 * Where you are working: the organization, and the project inside it.
 *
 * **It is on screen even when there is one project.** An earlier rule hid a
 * level with one thing in it as clutter. It is not clutter — it is the answer
 * to *why is this list empty*, and somebody who cannot see which project they
 * are in cannot tell an empty project from a broken page.
 *
 * **Choosing a project changes the address**, and the address is the only place
 * a choice is kept. Nothing is written to storage and nothing is posted to the
 * server, which is exactly what lets two tabs sit on two projects and lets a
 * pasted link open the project it was copied from. Reload, Back and Forward
 * work because they always did — they restore an address, and an address is the
 * whole of the state.
 *
 * The organization is shown and is not a choice: one person belongs to one
 * organization in this version, and offering a menu of one would suggest
 * otherwise.
 */

/**
 * The trigger, which is a card in the sidebar and a compact control on a phone.
 *
 * **The card is what the developer asked for after seeing the bar beside a
 * competitor's.** It carries four things and they answer four questions in one
 * glance: a square mark with the organization's initial (*which* organization,
 * before any word is read), a quiet eyebrow naming what the primary line is,
 * the organization name, and the project under it. The chevron points the way
 * the menu opens.
 *
 * **The Egma mark is deliberately not the avatar.** `DESIGN.md` keeps the full
 * logo out of the signed-in sidebar, and a logo here would say *Egma* to a
 * person asking *which of my organizations am I in*. The initial answers the
 * question that is actually being asked.
 *
 * **This is a restyle of the trigger and nothing else.** Search, the keyboard
 * path, Escape, focus return, the unsaved-work guard and the origin-aware open
 * are the menu's, and none of them is touched below.
 *
 * The compact form is the mobile top bar's, and it stays two lines. A card with
 * a mark and an eyebrow is a block, and the top bar is a 44px row shared with a
 * drawer button and a page title. The width it is held to used to be a rule in
 * the shell's stylesheet reaching in by class name. It is here now, on the one
 * prop that asks for it, because a shared component's own size should not
 * depend on which page happened to put it somewhere.
 */
const TRIGGER = [
  "grid w-full min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3",
  "min-h-[calc(var(--control-lg)+var(--space-5))] p-3",
  "rounded-card border border-border bg-surface text-left",
  "cursor-pointer transition-transform duration-(--duration-press) ease-out",
  "pointer-coarse:min-h-(--tap-target)",
  "pointer-hover:border-border-strong pointer-hover:bg-surface-soft",
  "[&:active:not(:focus-visible)]:scale-97",
  "motion-reduce:transition-none",
  "motion-reduce:[&:active:not(:focus-visible)]:scale-100",
];

const TRIGGER_COMPACT = [
  "grid-cols-[minmax(0,1fr)_auto] gap-2",
  "min-h-(--control-lg) max-w-[220px] rounded-input px-3 py-1",
  "max-[900px]:min-w-0 max-[900px]:max-w-[min(220px,56vw)]",
];

/**
 * The square mark, which carries one letter and never a logo.
 *
 * It is neutral rather than Ember. Ember is this product's signal for focus,
 * for the current row and for a state that wants attention, and an avatar that
 * is always on would spend it on something that is never news. The open trigger
 * still turns, because the menu hands it `border-brand bg-selected`.
 */
const MARK = [
  "grid size-9 flex-none place-items-center",
  "rounded-button border border-border bg-surface-soft",
  "text-base leading-(--line-tight) font-medium text-foreground",
];

export function ProjectSelector({
  organization,
  projects,
  projectId,
  mayCreateProject = false,
  compact = false,
}: {
  readonly organization: Organization | undefined;
  readonly projects: readonly Project[];
  /** The project the address names, or nothing on a page that names none. */
  readonly projectId: string | null;
  /** Whether the signed-in role may add a project to this organization. */
  readonly mayCreateProject?: boolean;
  /** The mobile top bar, where the control shares a row with everything else. */
  readonly compact?: boolean;
}) {
  const draftNavigation = useDraftNavigation();
  const pathname = usePathname();
  const [query, setQuery] = useState("");

  const current = projects.find((project) => project.id === projectId);
  const shown = projectsMatching(projects, query);
  const organizationName = organization?.name ?? "No organization";

  /**
   * What this control says it is showing — and it never says a project the
   * address does not name.
   *
   * Two ways that could go wrong and both are closed. An address naming a
   * project this membership does not hold says **Unknown project**: falling
   * back to the first project's name would tell somebody they are working in
   * Default while the page beside it refuses everything they ask for. And an
   * address naming no project at all says **No project** — it used to say the
   * first project's name, which is the same lie told on the one page that is
   * deliberately outside every project.
   */
  const projectName =
    current?.name ?? (projectId === null ? "No project" : "Unknown project");

  /**
   * The letter in the square, and a dash where there is no name to take one
   * from. A membership with no organization would otherwise wear the N of
   * "No organization" and look like an organization whose name starts with N.
   */
  const initial =
    organization === undefined
      ? "\u2013"
      : organization.name.trim().slice(0, 1).toUpperCase() || "\u2013";

  function choose(project: Project, close: () => void): void {
    if (project.id === projectId) {
      close();
      setQuery("");
      return;
    }
    const active = document.activeElement;
    const selectorTrigger = active instanceof HTMLElement
      ? active
        .closest<HTMLElement>('[data-slot="menu"]')
        ?.querySelector<HTMLButtonElement>("button[aria-haspopup]") ?? null
      : null;
    close();
    setQuery("");
    draftNavigation.push(inProject(pathname, project.id), selectorTrigger);
  }

  return (
    <Menu
      label={`Organization ${organizationName}, project ${projectName}. Choose a project`}
      triggerClassName={cn(TRIGGER, compact && TRIGGER_COMPACT)}
      openClassName="border-brand bg-selected"
      placement={compact ? "below-start" : "right-start"}
      // A panel with a field to type in, so a dialog rather than a menu.
      panelRole="dialog"
      trigger={
        <>
          {compact ? null : (
            <span className={cn(MARK)} aria-hidden="true">
              {initial}
            </span>
          )}
          <span className="min-w-0">
            {/*
             * Every line is one line, whatever the name. The tight line height
             * is the 1.0 step rather than body text's 1.5, because these are
             * labels stacked and not a paragraph.
             */}
            {compact ? null : (
              <span className="mb-1 block overflow-hidden text-sm leading-(--line-tight) text-ellipsis whitespace-nowrap text-faint uppercase tracking-(--tracking-label)">
                Organization
              </span>
            )}
            <span className="block overflow-hidden text-base leading-(--line-tight) font-medium text-ellipsis whitespace-nowrap text-foreground">
              {organizationName}
            </span>
            <span className="mt-1 block overflow-hidden text-sm leading-(--line-tight) font-normal text-ellipsis whitespace-nowrap text-muted-foreground">
              {projectName}
            </span>
          </span>
          {/*
           * The chevron points where the menu goes: right out of the bar on a
           * wide screen, down out of the top bar on a narrow one. Same control,
           * and it never promises a direction the panel does not take.
           */}
          {compact ? (
            <ChevronDownIcon
              className="block size-4 flex-none text-muted-foreground"
              aria-hidden="true"
              strokeWidth={1.75}
            />
          ) : (
            <ChevronRightIcon
              className="block size-4 flex-none text-muted-foreground"
              aria-hidden="true"
              strokeWidth={1.75}
            />
          )}
        </>
      }
    >
      {(close) => (
        <>
          <MenuLabel>{organizationName}</MenuLabel>
          {projects.length > 1 ? (
            <div className="px-1 pt-1 pb-2">
              <Input
                id="project-search"
                aria-label="Search projects"
                placeholder="Search projects"
                value={query}
                autoComplete="off"
                spellCheck={false}
                /* The field an opening menu puts focus in. */
                data-menu-focus-first=""
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  const only = shown[0];
                  if (only !== undefined) choose(only, close);
                }}
              />
            </div>
          ) : null}
          <div className="max-h-60 overflow-y-auto">
            {shown.length === 0 ? (
              <p className="m-0 p-3 text-sm text-muted-foreground">
                No project matches that.
              </p>
            ) : (
              shown.map((project) => (
                <MenuItem
                  key={project.id}
                  role="none"
                  selected={project.id === projectId}
                  onClick={() => choose(project, close)}
                >
                  <span>{project.name}</span>
                  {project.id === projectId ? (
                    <span className="ml-auto text-brand" aria-hidden="true">
                      ✓
                    </span>
                  ) : null}
                </MenuItem>
              ))
            )}
          </div>
          {mayCreateProject ? (
            <>
              <MenuDivider />
              <MenuItem
                href={NEW_PROJECT_PATH}
                role="none"
                onClick={() => {
                  close();
                  setQuery("");
                }}
              >
                New project
              </MenuItem>
            </>
          ) : null}
        </>
      )}
    </Menu>
  );
}
