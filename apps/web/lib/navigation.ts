import { projectPath, sectionIn } from "./project-context.ts";

/**
 * The project navigation has one unlabelled group for Agents and Graders, one
 * Simulations group, and one Monitoring group. Every link carries the project.
 * Groups control presentation only; the address decides the active item.
 */

export type SectionId =
  | "agents"
  | "tests"
  | "runs"
  | "monitoring"
  | "personas"
  | "graders"
  | "settings";

/** The three groups, which are labels over the items rather than addresses. */
export type NavigationGroupId = "global" | "simulations" | "monitoring";

export type NavigationItem = {
  readonly id: SectionId;
  readonly label: string;
  /**
   * An optional page inside the section that the item opens directly.
   * Monitoring uses this to open its transcript list without a redirect.
   */
  readonly opens?: readonly string[];
};

export type NavigationLink = NavigationItem & { readonly href: string };

export type NavigationGroup<Item = NavigationItem> = {
  readonly id: NavigationGroupId;
  /**
   * The word over the group, or `null` where the group is drawn without one.
   *
   * `null` rather than an absent key, because a group either has decided to say
   * nothing or has not been given a label yet, and those are different bugs. An
   * unlabelled group gets no heading and no accessible name — not a hidden one,
   * and not the group's id used as a stand-in.
   */
  readonly label: string | null;
  readonly items: readonly Item[];
};

/**
 * The bar, top to bottom.
 *
 * Agents stays the first row, and stays the signed-in landing area. Everything
 * below it is grouped rather than ranked.
 */
export const NAVIGATION_GROUPS: readonly NavigationGroup[] = [
  {
    id: "global",
    label: null,
    items: [
      { id: "agents", label: "Agents" },
      { id: "graders", label: "Graders" },
    ],
  },
  {
    id: "simulations",
    label: "Simulations",
    items: [
      { id: "tests", label: "Tests" },
      { id: "personas", label: "Personas" },
      { id: "runs", label: "Runs" },
    ],
  },
  {
    id: "monitoring",
    label: "Monitoring",
    items: [{ id: "monitoring", label: "Transcripts", opens: ["transcripts"] }],
  },
];

/** Every item the bar offers, in the order it offers them. */
export const EVERY_NAVIGATION_ITEM: readonly NavigationItem[] =
  NAVIGATION_GROUPS.flatMap((group) => group.items);

const EVERY_SECTION: readonly SectionId[] = EVERY_NAVIGATION_ITEM.map(
  (item) => item.id,
);

/** The navigation of one project, as the shell renders it. */
export function navigationFor(
  projectId: string,
): readonly NavigationGroup<NavigationLink>[] {
  return NAVIGATION_GROUPS.map((group) => ({
    ...group,
    items: group.items.map((item) => ({
      ...item,
      href: projectPath(projectId, item.id, ...(item.opens ?? [])),
    })),
  }));
}

/**
 * Which navigation item an address is under, or nothing.
 *
 * Read from the address rather than passed down by each page: a page that has
 * to remember to say where it is, is a page that can be wrong about it, and
 * every detail page under an area would have to remember too. **The groups
 * changed nothing here** — an item is found by its own id, so the same address
 * lights the same item it lit before it had a group over it.
 */
export function activeSectionIn(pathname: string): SectionId | null {
  const section = sectionIn(pathname);
  return EVERY_SECTION.find((known) => known === section) ?? null;
}
