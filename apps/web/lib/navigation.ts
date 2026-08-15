import { projectPath, sectionIn } from "./project-context.ts";

/**
 * The product areas, and which of them the navigation offers.
 *
 * **Primary navigation is the three things a team works on today**: the agent
 * under test, the tests, and the runs that executed them. Everything else earns
 * its place separately:
 *
 * - **Graders has no item, and this is wave one's decision.** The grader
 *   redesign shelved the authoring surface this effort built at
 *   `/projects/:id/graders`, and the screens that replace it — the library and
 *   the running copies — are organization-wide: their addresses carry no
 *   project, and the shell reads the project out of the address. An item
 *   pointing at them would show whichever project is first in the viewer's
 *   list, and pressing **Use** would put a copy on a project nobody was
 *   looking at. Wave two rebuilds them project-scoped and the item comes back
 *   here.
 *
 * - **Personas has a direct path and not a primary slot.** A persona is
 *   authored on its own, reused across tests, and visited far less often than
 *   the four — but it must never be reachable only from inside a test form,
 *   which is how a reusable thing quietly becomes a field.
 * - **Settings is in the account menu.** Administration is not a product area
 *   and crowding it into the same list makes the list mean two things.
 * - **A simulation has no navigation item at all.** It is evidence, reached
 *   from the run that produced it, and a top-level list of every conversation
 *   would be a different product.
 *
 * Every item is a project's own, so every href carries the project. There is
 * no navigation to a page that is not in a project.
 */

export type SectionId = "agents" | "tests" | "runs" | "personas";

export type NavigationItem = {
  readonly id: SectionId;
  readonly label: string;
};

export type NavigationLink = NavigationItem & { readonly href: string };

export const PRIMARY_NAVIGATION: readonly NavigationItem[] = [
  { id: "agents", label: "Agents" },
  { id: "tests", label: "Tests" },
  { id: "runs", label: "Runs" },
];

export const SECONDARY_NAVIGATION: readonly NavigationItem[] = [
  { id: "personas", label: "Personas" },
];

const EVERY_SECTION: readonly SectionId[] = [
  ...PRIMARY_NAVIGATION,
  ...SECONDARY_NAVIGATION,
].map((item) => item.id);

function linksFor(
  items: readonly NavigationItem[],
  projectId: string,
): readonly NavigationLink[] {
  return items.map((item) => ({ ...item, href: projectPath(projectId, item.id) }));
}

/** The navigation of one project, as the shell renders it. */
export function navigationFor(projectId: string): {
  readonly primary: readonly NavigationLink[];
  readonly secondary: readonly NavigationLink[];
} {
  return {
    primary: linksFor(PRIMARY_NAVIGATION, projectId),
    secondary: linksFor(SECONDARY_NAVIGATION, projectId),
  };
}

/**
 * Which navigation item an address is under, or nothing.
 *
 * Read from the address rather than passed down by each page: a page that has
 * to remember to say where it is, is a page that can be wrong about it, and
 * every detail page under an area would have to remember too.
 */
export function activeSectionIn(pathname: string): SectionId | null {
  const section = sectionIn(pathname);
  return EVERY_SECTION.find((known) => known === section) ?? null;
}
