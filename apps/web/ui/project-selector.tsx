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
 * Keep the current project visible even when only one exists. Selection lives
 * in the URL, independently per tab; this control does not store a session-wide
 * choice. The organization has a separate shell control.
 */

/**
 * Label the current project explicitly and keep its text neutral while the
 * menu opens. The compact trigger fits beside mobile navigation and account controls.
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

  const current = projects.find((project) => project.id === projectId);
  const organizationName = organization?.name ?? "No organization";

  /**
   * Show Unknown project for an inaccessible ID and No project when the URL
   * has none. Never substitute the first project's label.
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
