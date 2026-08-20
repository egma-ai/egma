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
 * **The library first, because that is where a grader comes from.** A running
 * grader is a copy of a library entry, so somebody who has just arrived meets
 * the shelf, presses Use on something, and finds it on the second tab. The
 * reverse order would show a list of copies before anything explained what they
 * were copies of.
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
  { id: "library", label: GRADER_VIEW_LABELS.library, rest: [] },
  { id: "running", label: GRADER_VIEW_LABELS.running, rest: ["running"] },
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
