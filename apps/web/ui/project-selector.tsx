"use client";

import { ChevronDownIcon, ChevronsUpDownIcon } from "lucide-react";
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
 * The trigger: two lines, no card, and no mark.
 *
 * **The card went when the wordmark arrived.** It used to carry a square with
 * the organization's initial, a quiet "ORGANIZATION" eyebrow, the organization
 * name and the project under it — four things, because the top of the bar had
 * to answer *which Egma is this* on its own. It does not any more: the
 * wordmark bar above says the product, so this block says the two things left,
 * and the boards draw them as plain type on the sidebar's own surface
 * (`734-0`).
 *
 * The **organization is the eyebrow** now and the **project is the primary
 * line** — the developer's ruling of 2026-08-23, and the right way round: the
 * project is what a person changes and the organization is the one thing they
 * cannot. 12px for the eyebrow and 14px for the name, both read off the board.
 *
 * **This is a restyle of the trigger and nothing else.** Search, the keyboard
 * path, Escape, focus return, the unsaved-work guard and the origin-aware open
 * are the menu's, and none of them is touched below. Its accessible name still
 * names both, so nothing that reaches this control by name has moved.
 *
 * The compact form is the mobile top bar's, where the control shares a 56px row
 * with a drawer button and the account, so it stays held to a width of its own.
 */
const TRIGGER = [
  "flex w-full min-w-0 flex-col items-stretch gap-1.5",
  "border-0 bg-transparent p-0 text-left",
  "cursor-pointer transition-transform duration-(--duration-press) ease-out",
  "[&:active:not(:focus-visible)]:scale-97",
  "motion-reduce:transition-none",
  "motion-reduce:[&:active:not(:focus-visible)]:scale-100",
];

const TRIGGER_COMPACT = [
  "flex-row items-center gap-2",
  "min-h-(--control-lg) max-w-[220px] rounded-input px-3 py-1",
  "border border-border bg-surface",
  "pointer-hover:border-border-strong pointer-hover:bg-surface-soft",
  "max-[900px]:min-w-0 max-[900px]:max-w-[min(220px,56vw)]",
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

  function choose(project: Project, close: () => void): void {
    if (project.id === projectId) {
      close();
      setQuery("");
      return;
    }
    /*
     * No element to carry here: the panel is portaled out of the trigger's
     * tree, so there is nothing to walk up to. What keeps focus right is
     * `close()` focusing the trigger synchronously, then the dialog's own
     * `returnFocusTo ?? opener` fallback — `null` rides through the guarded
     * navigation untouched.
     */
    close();
    setQuery("");
    draftNavigation.push(inProject(pathname, project.id), null);
  }

  return (
    <Menu
      label={`Organization ${organizationName}, project ${projectName}. Choose a project`}
      triggerClassName={cn(TRIGGER, compact && TRIGGER_COMPACT)}
      openClassName="[&_[data-slot=project-name]]:text-brand"
      placement={compact ? "below-start" : "right-start"}
      // A panel with a field to type in, so a dialog rather than a menu.
      panelRole="dialog"
      trigger={
        <>
          {/*
           * The organization, quiet and above. It is not a choice — one person
           * belongs to one organization in this version — so it is a label
           * rather than something with a control on it.
           */}
          {compact ? null : (
            <span className="block overflow-hidden text-2xs leading-(--line-normal) text-ellipsis whitespace-nowrap text-faint">
              {organizationName}
            </span>
          )}
          <span className="flex min-w-0 items-center justify-between gap-2">
            <span
              className="block overflow-hidden text-sm text-ellipsis whitespace-nowrap text-foreground"
              data-slot="project-name"
            >
              {projectName}
            </span>
            {/*
             * The chevron says the line under it can be changed. Down out of
             * the top bar on a phone, where the panel drops; the two-way arrow
             * in the docked bar, which is what the board draws and what a
             * switcher wears everywhere else.
             */}
            {compact ? (
              <ChevronDownIcon
                className="block size-3 flex-none text-faint"
                aria-hidden="true"
                strokeWidth={1.75}
              />
            ) : (
              <ChevronsUpDownIcon
                className="block size-3 flex-none text-faint"
                aria-hidden="true"
                strokeWidth={1.75}
              />
            )}
          </span>
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
