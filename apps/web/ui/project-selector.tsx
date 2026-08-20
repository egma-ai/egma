"use client";

import { usePathname } from "next/navigation";
import { useState } from "react";

import { cn } from "@/lib/utils";

import { projectsMatching, type Organization, type Project } from "../lib/me.ts";
import { inProject } from "../lib/project-context.ts";
import { NEW_PROJECT_PATH } from "../lib/settings.ts";
import { TextInput } from "./controls.tsx";
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
 * The trigger, which is a two-line control rather than a row in a list.
 *
 * The compact form is the mobile top bar's, and the width it is held to used to
 * be a rule in the shell's stylesheet reaching in by class name. It is here
 * now, on the one prop that asks for it, because a shared component's own size
 * should not depend on which page happened to put it somewhere.
 */
const TRIGGER = [
  "grid w-full min-w-0 grid-cols-[minmax(0,1fr)_12px] items-center gap-2",
  "min-h-[calc(var(--control-lg)+var(--space-5))] p-3",
  "rounded-input border border-border bg-surface text-left",
  "cursor-pointer transition-transform duration-(--duration-press) ease-out",
  "pointer-coarse:min-h-(--tap-target)",
  "pointer-hover:border-border-strong pointer-hover:bg-surface-soft",
  "[&:active:not(:focus-visible)]:scale-97",
  "motion-reduce:transition-none",
  "motion-reduce:[&:active:not(:focus-visible)]:scale-100",
];

const TRIGGER_COMPACT = [
  "min-h-(--control-lg) max-w-[220px] py-1",
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
          <span className="min-w-0">
            {/*
             * Both lines are one line each, whatever the name. The tight line
             * height is the 1.0 step rather than body text's 1.5, because these
             * are two labels stacked and not a paragraph.
             */}
            <span className="block overflow-hidden text-base leading-(--line-tight) font-medium text-ellipsis whitespace-nowrap text-foreground">
              {organizationName}
            </span>
            <span className="mt-1 block overflow-hidden text-sm leading-(--line-tight) font-normal text-ellipsis whitespace-nowrap text-muted-foreground">
              {projectName}
            </span>
          </span>
          <svg
            className="block size-3.5 text-muted-foreground"
            aria-hidden="true"
            viewBox="0 0 12 12"
            fill="none"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.4}
          >
            <path d="M3.25 4.75 6 7.5l2.75-2.75" />
          </svg>
        </>
      }
    >
      {(close) => (
        <>
          <MenuLabel>{organizationName}</MenuLabel>
          {projects.length > 1 ? (
            <div className="px-1 pt-1 pb-2">
              <TextInput
                id="project-search"
                label="Search projects"
                placeholder="Search projects"
                value={query}
                autoFocusFirst
                onChange={setQuery}
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
