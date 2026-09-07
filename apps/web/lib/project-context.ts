/**
 * Which project a tab is looking at, and how it says so.
 *
 * **The address is the whole of the product-navigation answer.** There is no
 * mutable chosen project in a cookie or local storage — a person with Outbound
 * open in one tab and Support in another is an ordinary person, and neither tab
 * can be right if one mutable value decides for both. The API session does
 * carry its initial project for projectless requests, but every project page
 * names its project in both its URL and its requests. Reload, Back, Forward and
 * a pasted link therefore restore the same product context.
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
 * The same page, in another project.
 *
 * **The area survives the change and the resource does not.** Somebody
 * switching project from a list wants that list in the other project; somebody
 * switching from one agent's page cannot want *that* agent, because it is not
 * in the project they just picked and the link would land on a refusal. So the
 * section is kept and everything under it is dropped.
 *
 * An address with no project in it at all becomes the new project's landing
 * page, because there is no area to carry across. `/new-project` carries no
 * project and can reach this function, because the only
 * caller is the selector's click handler and `AppShell` draws the selector on
 * every page it wraps, unconditionally, whatever the address says:
 *
 * - `/new-project`, which an organization holding none has to be able to reach.
 *
 * It lands on the new project's landing page because there is no area on the
 * address to carry into the project just picked.
 */
export function inProject(pathname: string, projectId: string): string {
  const address = addressIn(pathname);
  return address === null
    ? projectLanding(projectId)
    : projectPath(projectId, address.section);
}
