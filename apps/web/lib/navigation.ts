import { projectPath, sectionIn } from "./project-context.ts";

/**
 * The product areas, and how the navigation groups them.
 *
 * **The bar names the two jobs the product does.** Prove trust before release
 * is *Simulations*; keep trust in production is *Monitoring*. The two standing
 * things both jobs share — the agent under test, and the graders that judge —
 * sit above them in a group of their own:
 *
 * - **Global**: Agents, Graders.
 * - **Simulations**: Tests, Personas, Runs.
 * - **Monitoring**: Transcripts.
 *
 * **The objection to "Global", recorded because it was overruled rather than
 * answered.** It is not a glossary word, and nothing in this bar is global:
 * every entry is project-scoped, so switching project changes what the group
 * holds, and a new reader may predict organization-wide settings behind the
 * label. The developer heard that and prefers the label anyway — the group
 * names what stands above both halves, and the word is theirs to spend. If
 * first-user evidence shows the misread happening, the label reopens. The
 * group itself is settled.
 *
 * **The groups are presentation, and only presentation.** Every href is the one
 * it was before the groups existed, `activeSectionIn` still reads the address
 * rather than the group, and a copied URL keeps meaning what it meant. Nothing
 * here can move a page.
 *
 * What the words do:
 *
 * - **"Simulation runs" is now "Runs"**, because the group supplies the other
 *   word. The pairing a person reads — Simulations → Runs — preserves the
 *   settled reading that the runs surface holds simulated traffic and the
 *   monitoring surface holds production traffic. The addresses under
 *   `/projects/{projectId}/runs` do not move and the stored word stays `run`.
 * - **The monitoring item says "Transcripts"**, because the group label now
 *   carries the word "Monitoring" and an item should say what its page is.
 *   Same id, same address, same `opens`.
 * - **Personas rises into Simulations.** It is the one rank change a person
 *   feels: a persona is authored on its own and reused across tests, and it
 *   belongs beside the tests that use it rather than in a library shelf below.
 * - **Graders moves into Global.** A grader is switched on once and then judges
 *   everything in its scope without anybody visiting it again — which is what
 *   makes it standing rather than part of either job.
 * - **Settings lives in the account menu.** It is administrative work rather
 *   than a project destination, so it is in no group here.
 * - **A simulation has no navigation item at all.** It is evidence, reached
 *   from the run that produced it, and a top-level list of every simulation
 *   would be a different product.
 *
 * **No group holds a row for something that does not ship.** Measures joins
 * Monitoring when the measures bridge lands and not one day before: a "soon"
 * row is a state that is not truthful.
 *
 * Every item is a project's own, so every href carries the project. There is
 * no navigation to a page that is not in a project.
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
   * The page inside the area the item opens, where that is not the area's own
   * address.
   *
   * Monitoring is the one that has it. `/projects/{projectId}/monitoring` is a
   * real address and lands on the transcript list, but the item points straight
   * at the list rather than at a page whose whole job is to forward — a
   * navigation click should not cost a redirect, and a reserved neighbour under
   * the same area should never be able to become the landing by accident.
   */
  readonly opens?: readonly string[];
};

export type NavigationLink = NavigationItem & { readonly href: string };

export type NavigationGroup<Item = NavigationItem> = {
  readonly id: NavigationGroupId;
  readonly label: string;
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
    label: "Global",
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
