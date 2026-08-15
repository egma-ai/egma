"use client";

import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";

import { projectsMatching, type Organization, type Project } from "../lib/me.ts";
import { inProject } from "../lib/project-context.ts";
import { TextInput } from "./controls.tsx";
import { Menu, MenuDivider, MenuItem, MenuLabel } from "./menu.tsx";
import styles from "./system.module.css";

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

export function ProjectSelector({
  organization,
  projects,
  projectId,
  compact = false,
}: {
  readonly organization: Organization | undefined;
  readonly projects: readonly Project[];
  /** The project the address names, or nothing on a page that names none. */
  readonly projectId: string | null;
  /** The mobile top bar, where the control shares a row with everything else. */
  readonly compact?: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [query, setQuery] = useState("");

  const current = projects.find((project) => project.id === projectId);
  const shown = projectsMatching(projects, query);
  const organizationName = organization?.name ?? "No organization";
  const projectName = current?.name ?? projects[0]?.name ?? "No project";

  function choose(project: Project, close: () => void): void {
    close();
    setQuery("");
    if (project.id === projectId) return;
    router.push(inProject(pathname, project.id));
  }

  return (
    <Menu
      label={`Organization ${organizationName}, project ${projectName}. Choose a project`}
      triggerClassName={`${styles.selector} ${compact ? styles.selectorCompact : ""}`}
      openClassName={styles.selectorOpen}
      trigger={
        <>
          <span className={styles.selectorText}>
            <span className={styles.selectorOrganization}>{organizationName}</span>
            <span className={styles.selectorProject}>{projectName}</span>
          </span>
          <svg className={styles.selectorChevron} aria-hidden="true" viewBox="0 0 12 12">
            <path d="M3.25 4.75 6 7.5l2.75-2.75" />
          </svg>
        </>
      }
    >
      {(close) => (
        <>
          <MenuLabel>{organizationName}</MenuLabel>
          {projects.length > 1 ? (
            <div className={styles.menuSearch}>
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
          <div className={styles.menuList}>
            {shown.length === 0 ? (
              <p className={styles.menuEmpty}>No project matches that.</p>
            ) : (
              shown.map((project) => (
                <MenuItem
                  key={project.id}
                  selected={project.id === projectId}
                  onClick={() => choose(project, close)}
                >
                  <span>{project.name}</span>
                  {project.id === projectId ? (
                    <span className={styles.menuCheck} aria-hidden="true">
                      ✓
                    </span>
                  ) : null}
                </MenuItem>
              ))
            )}
          </div>
          <MenuDivider />
          <MenuLabel>
            {projects.length === 1
              ? "One project in this organization"
              : `${projects.length} projects in this organization`}
          </MenuLabel>
        </>
      )}
    </Menu>
  );
}
