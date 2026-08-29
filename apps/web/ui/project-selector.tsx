"use client";

import { ChevronDownIcon, ChevronsUpDownIcon } from "lucide-react";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils";

import { type Organization, type Project } from "../lib/me.ts";
import { inProject } from "../lib/project-context.ts";
import { NEW_PROJECT_PATH } from "../lib/settings.ts";
import { useDraftNavigation } from "./draft-navigation.tsx";
import { Menu, MenuDivider, MenuItem, MenuLabel } from "./menu.tsx";

/**
 * The project where you are working.
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
 * Organization identity now has its own control in the shell. It is still
 * passed here because the chooser names the organization whose projects it
 * lists, but it is no longer repeated in this trigger.
 */

/**
 * The trigger: an explicit label over the current project.
 *
 * The word **Project** stays visible even when there is only one. Organization
 * and project are different scopes, so a quiet label is the small amount of
 * copy that prevents the current project's name from being mistaken for an
 * organization. The organization sits in the bar above it.
 *
 * The project name stays neutral while the menu is open. Opening a chooser is
 * not a brand state, and changing its text colour made the current context look
 * like an action. The menu is a direct list: no search field stands between a
 * person and the projects they can choose.
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
  /*
   * **The edge answers the pointer; the fill stays where it is.** This form is
   * drawn on the mobile bar, and that bar is chrome — so the control already
   * rests a step above what it sits on, and the quiet grey it used to hover to
   * is the bar's own value in light theme. A control that sank into its bar
   * the moment somebody pointed at it would be saying the opposite of what a
   * hover means. The hairline going to ink says it in both themes. The drawer
   * button beside it in `shell.tsx` is the same control and made the same move.
   */
  "pointer-hover:border-border-strong",
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

  const current = projects.find((project) => project.id === projectId);
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
    draftNavigation.push(inProject(pathname, project.id), null);
  }

  return (
    <Menu
      label={`Organization ${organizationName}, project ${projectName}. Choose a project`}
      triggerClassName={cn(TRIGGER, compact && TRIGGER_COMPACT)}
      placement={compact ? "below-start" : "right-start"}
      trigger={
        <>
          {/* The mobile row has no room for a second line. */}
          {compact ? null : (
            <span className="block overflow-hidden text-2xs leading-(--line-normal) text-ellipsis whitespace-nowrap text-faint">
              Project
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
          <div className="max-h-60 overflow-y-auto">
            {projects.length === 0 ? (
              <p className="m-0 p-3 text-sm text-muted-foreground">
                No projects available.
              </p>
            ) : (
              projects.map((project) => (
                <MenuItem
                  key={project.id}
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
              <MenuItem href={NEW_PROJECT_PATH} onClick={close}>
                New project
              </MenuItem>
            </>
          ) : null}
        </>
      )}
    </Menu>
  );
}
