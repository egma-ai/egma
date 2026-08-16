/**
 * Which project a tab is looking at, and how it says so.
 *
 * **The address is the whole of the answer.** There is no chosen project in a
 * cookie, in local storage, or on the server's session — a person with
 * Outbound open in one tab and Support in another is an ordinary person, and
 * neither tab can be right if one mutable value decides for both. Reload,
 * Back, Forward and a pasted link all keep working for the same reason: they
 * all restore an address, and the address is all there is.
 *
 * Every product page therefore lives under `/projects/{projectId}/…` and every
 * product request it makes carries the same identifier. The identifier is the
 * project's stable id rather than its slug, because a slug is an admin's to
 * rename and a link somebody sent last month must still open the same project.
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
  /** Whatever named one thing inside that area. */
  readonly rest: readonly string[];
};

function addressIn(pathname: string): Address | null {
  const [, segment, projectId, section, ...rest] = pathname.split("/");
  if (segment !== PROJECT_SEGMENT) return null;
  if (projectId === undefined || projectId === "") return null;
  return {
    projectId,
    section: section === undefined || section === "" ? LANDING_SECTION : section,
    rest,
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
 * The same page, in another project.
 *
 * **The area survives the change and the resource does not.** Somebody
 * switching project from a list wants that list in the other project; somebody
 * switching from one agent's page cannot want *that* agent, because it is not
 * in the project they just picked and the link would land on a refusal. So the
 * section is kept and everything under it is dropped.
 *
 * An address with no project in it at all becomes the new project's landing
 * page, because there is no area to carry across. Three addresses are like
 * that and each on purpose: `/new-project`, which an organization holding none
 * has to be able to reach; `/runs/{runId}`, which a terminal prints and which
 * forwards by reading the run's own project; and `/traces`, which is
 * organization-wide.
 */
export function inProject(pathname: string, projectId: string): string {
  const address = addressIn(pathname);
  return address === null
    ? projectLanding(projectId)
    : projectPath(projectId, address.section);
}
