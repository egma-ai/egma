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
 * page, because there is no area to carry across. **Three addresses carry no
 * project, and every one of them can reach this function**, because the only
 * caller is the selector's click handler and `AppShell` draws the selector on
 * every page it wraps, unconditionally, whatever the address says:
 *
 * - `/new-project`, which an organization holding none has to be able to reach.
 * - `/runs/{runId}`, the address a terminal prints, which reads the run's own
 *   project and forwards into it.
 * - `/members`, the kept legacy Settings address, which chooses the caller's
 *   first project on purpose because People is the organization's and any
 *   project serves as its frame.
 *
 * The two transcript addresses used to be on that list. They are inside the
 * project now — `/projects/{projectId}/monitoring/transcripts` and one
 * conversation beneath it — so switching project from Monitoring lands on the
 * other project's Monitoring rather than throwing somebody out to Agents.
 *
 * **The last two forward, and forwarding is not the same as never being here.**
 * Both draw `ProductStatePage`, which is this shell around a page, so the
 * selector is on screen for as long as the read takes — and longer than that
 * when the read does not end in a forward at all. Open a `results_url` for a
 * run in a project the session cannot reach and `/runs/{runId}` settles into
 * its `missing` state and stays there, shell and selector included, with one
 * click on the selector calling straight into this function. So the two that
 * were once written down as unreachable are in fact the two most likely to
 * arrive, because they are the two that can get stuck.
 *
 * All three land on the same answer, which is the right one for each: there is
 * no area on any of these addresses to carry into the project just picked.
 */
export function inProject(pathname: string, projectId: string): string {
  const address = addressIn(pathname);
  return address === null
    ? projectLanding(projectId)
    : projectPath(projectId, address.section);
}
