/**
 * Project pages carry the stable project ID in the URL and API requests.
 * This lets separate tabs use separate projects and keeps links valid after
 * a rename. Account routes need no project; API sessions also have an initial
 * project fallback for requests that omit one.
 */

export const PROJECT_SEGMENT = "projects";

/** Where a project's product pages begin. */
export const LANDING_SECTION = "agents";

/** The address of one page inside one project. */
export function projectPath(
  projectId: string,
  ...rest: readonly string[]
): string {
  return ["", PROJECT_SEGMENT, projectId, ...rest].join("/");
}

/** Where somebody entering a project lands. */
export function projectLanding(projectId: string): string {
  return projectPath(projectId, LANDING_SECTION);
}

type Address = {
  readonly projectId: string;
  /** The product area, which every project has its own copy of. */
  readonly section: string;
};

function addressIn(pathname: string): Address | null {
  const [, segment, projectId, section] = pathname.split("/");
  if (segment !== PROJECT_SEGMENT) return null;
  if (projectId === undefined || projectId === "") return null;
  return {
    projectId,
    section: section === undefined || section === "" ? LANDING_SECTION : section,
  };
}

/** The project this address names, or nothing when it names none. */
export function projectIdIn(pathname: string): string | null {
  return addressIn(pathname)?.projectId ?? null;
}

/** The product area this address is in, or nothing outside the product. */
export function sectionIn(pathname: string): string | null {
  return addressIn(pathname)?.section ?? null;
}

/**
 * Keep the section when switching projects, but drop record IDs that belong
 * to the old project. Addresses without a project use the new project's landing page.
 */
export function inProject(pathname: string, projectId: string): string {
  const address = addressIn(pathname);
  if (address === null) return projectLanding(projectId);

  // Settings pages are stable destinations, so keep their named page while
  // switching projects. The settings root has no page of its own.
  if (address.section === "settings") {
    const settingsPage = pathname.split("/")[4] || "organization";
    return projectPath(projectId, "settings", settingsPage);
  }

  return projectPath(projectId, address.section);
}
