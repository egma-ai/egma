/**
 * Light or dark, and where the choice is kept.
 *
 * The product navigation used to live here too. It is `lib/navigation.ts` now,
 * because navigation is a project's — every item carries the project it belongs
 * to — and a flat list of hrefs could not say that.
 */

import { GRADERS_SECTION } from "./graders.ts";
import { projectPath } from "./project-context.ts";

export type Theme = "light" | "dark";

export const THEME_STORAGE_KEY = "egma-theme";

export function themeFromStored(value: string | null): Theme {
  return value === "dark" ? "dark" : "light";
}

export function nextTheme(theme: Theme): Theme {
  return theme === "light" ? "dark" : "light";
}

/**
 * Human labels for the machine names of predefined graders.
 *
 * The API keeps these stable keys because runs and frozen grading plans need
 * durable names. Product surfaces pass the stored value through this one
 * presentation seam instead of teaching each route how to title it. A team
 * name that is not one of these keys is returned exactly as it was written.
 */
const PREDEFINED_GRADER_DISPLAY_NAMES: ReadonlyMap<string, string> = new Map([
  ["expected_behaviors", "Expected behaviors"],
  ["latency", "Latency"],
]);

export function graderDisplayName(name: string): string {
  return PREDEFINED_GRADER_DISPLAY_NAMES.get(name) ?? name;
}

/**
 * The two owners shown for personas and grader definitions.
 *
 * The API says `egma` or `organization`. Product tables say who owns the
 * definition instead of turning ownership into a type. `Default` is not an
 * owner: it is a separate project choice that can point at either one.
 */
const OWNER_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  egma: "Egma",
  organization: "You",
};

export function ownerDisplayName(owner: string): string {
  return OWNER_DISPLAY_NAMES[owner] ?? owner;
}

/**
 * The two screens inside the Graders section, and the order they read in.
 *
 * **Running first, because that is the screen somebody comes back to.** The
 * library led, on the argument that a running grader is a copy of a library
 * entry and the shelf is where the idea starts. That is the right order for the
 * first visit and the wrong one for every visit after it: the shelf is read
 * once and switched on, and what is judging this project right now is the
 * question a person returns with. Ordering a two-tab strip by where a thing
 * comes from taught the product to somebody who already knew it, and charged
 * everybody else a click on every arrival.
 *
 * The first visit keeps its answer. Running is the one screen in the product
 * whose empty state has always pointed straight at the library, and it now says
 * so twice — in the empty state, and in the *Add grader* action on the strip.
 * Somebody who arrives at an empty Running screen is one press from the shelf,
 * which is the same journey the old order made them take blind.
 *
 * The sidebar follows the strip. `navigation.ts` opens Graders on `running`
 * through the same `opens` mechanism Monitoring already uses, because a first
 * tab a person never lands on is not a first tab. Both addresses still work,
 * and a link copied to either one still opens what it opened.
 *
 * Here rather than in either screen's copy file, because a strip whose labels
 * lived in one of the two pages would be a page naming its sibling — and the
 * tab that is not current has to be named by something neither page owns.
 *
 * **Both addresses carry the project, and that is a function rather than a
 * constant for exactly that reason.** The pair that arrived from `main` sat at
 * `/graders` and `/graders/running` with no project in either address, while
 * this shell reads the project out of the path — so the selector fell back to
 * whichever project came first in the viewer's list, and pressing Use put a
 * running copy on a project nobody was looking at. A constant href cannot say
 * which project it means; this asks.
 */
export const GRADER_VIEW_LABELS = {
  library: "Library",
  running: "Running",
} as const;

const GRADER_TABS = [
  { id: "running", label: GRADER_VIEW_LABELS.running, rest: ["running"] },
  { id: "library", label: GRADER_VIEW_LABELS.library, rest: [] },
] as const satisfies readonly {
  readonly id: string;
  readonly label: string;
  readonly rest: readonly string[];
}[];

export type GraderTab = (typeof GRADER_TABS)[number]["id"];

/** The two tabs of one project's Graders section, in reading order. */
export function graderTabsFor(projectId: string): readonly {
  readonly id: GraderTab;
  readonly label: string;
  readonly href: string;
}[] {
  return GRADER_TABS.map((tab) => ({
    id: tab.id,
    label: tab.label,
    href: projectPath(projectId, GRADERS_SECTION, ...tab.rest),
  }));
}
