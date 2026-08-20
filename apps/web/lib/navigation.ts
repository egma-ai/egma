import { projectPath, sectionIn } from "./project-context.ts";

/**
 * The product areas, and how the navigation groups them.
 *
 * **The bar names the two jobs the product does.** Prove trust before release
 * is *Simulations*; keep trust in production is *Monitoring*. The two standing
 * things both jobs share — the agent under test, and the graders that judge —
 * sit above them in a group of their own:
 *
 * - *(unlabelled)*: Agents, Graders.
 * - **Simulations**: Tests, Personas, Runs.
 * - **Monitoring**: Transcripts.
 *
 * **The first group has no label, and that is the whole of the change.** It
 * used to say "Global". The objection was recorded here when the word was
 * overruled: it is not a glossary word, and nothing in this bar is global —
 * every entry is project-scoped, so switching project changes what the group
 * holds, and a new reader may predict organization-wide settings behind it.
 * Seeing it built, the developer dropped the word rather than replace it. No
 * substitute was needed: the two rows that stand above both jobs are the two
 * rows at the top of the bar, and their position already says so. A heading
 * over them would name a category a person never has to think about.
 *
 * So the group keeps its identity in code and loses its voice on screen. It is
 * still a group — the rows still cluster, still space as a cluster — and it is
 * the one group with `label: null`. Nothing announces it either: with no
 * heading there is no accessible name to point at, so the group is drawn as a
 * plain wrapper rather than a named region reading a heading that is not
 * there.
 *
 * **The groups are presentation, and only presentation.** A group cannot move a
 * page: `activeSectionIn` reads the address rather than the group, an item is
 * found by its own id, and grouping these six rows moved no href at all.
 *
 * **What can move an href is a decision, taken here and written down.** The bar
 * points at an address; it does not own one. Every address a row has ever
 * pointed at still resolves, and a copied URL still opens what it opened — that
 * is the invariant, and it is a different and smaller claim than the one this
 * paragraph used to make.
 *
 * One row has moved, once. The 2026-08-20 annotation batch put Running at the
 * front of the Graders strip, and Graders gained `opens: ["running"]` so the
 * bar opens the tab the strip leads with — a first tab nobody lands on is not a
 * first tab. `/projects/{projectId}/graders` is still the library and still
 * opens it. Monitoring has pointed one step deeper since it was written, for
 * its own reason, recorded on `opens` below.
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
 * - **Graders joins Agents in the top group.** A grader is switched on once and
 *   then judges everything in its scope without anybody visiting it again —
 *   which is what makes it standing rather than part of either job.
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
   * Monitoring and Graders both have it. `/projects/{projectId}/monitoring` is a
   * real address and lands on the transcript list, but the item points straight
   * at the list rather than at a page whose whole job is to forward — a
   * navigation click should not cost a redirect, and a reserved neighbour under
   * the same area should never be able to become the landing by accident.
   *
   * Graders has it for a different reason: its section holds two screens behind
   * one strip, and the strip now reads Running first. The shelf is read once
   * and switched on; what is judging this project right now is the question a
   * person comes back with. A first tab nobody lands on is not a first tab, so
   * the bar opens the one the strip leads with. `/projects/{projectId}/graders`
   * is still the library and still opens it — a copied link is unmoved.
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
      { id: "graders", label: "Graders", opens: ["running"] },
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
