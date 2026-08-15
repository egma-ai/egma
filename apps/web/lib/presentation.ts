/**
 * Light or dark, and where the choice is kept.
 *
 * The product navigation used to live here too. It is `lib/navigation.ts` now,
 * because navigation is a project's — every item carries the project it belongs
 * to — and a flat list of hrefs could not say that.
 */

export type Theme = "light" | "dark";

export const THEME_STORAGE_KEY = "egma-theme";

export function themeFromStored(value: string | null): Theme {
  return value === "dark" ? "dark" : "light";
}

export function nextTheme(theme: Theme): Theme {
  return theme === "light" ? "dark" : "light";
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
 * **Nothing in the product navigation points at either address, on purpose.**
 * Both screens are organization-wide, and the shell reads the project out of
 * the path — so on an address with no project in it the selector falls back to
 * whichever project is first in the viewer's list, and a person with three
 * projects would press Use on the wrong one with nothing saying so. The pages
 * stay in the tree as the working reference for their copy and their Use form;
 * wave two rebuilds them project-scoped and gives the section its navigation
 * back. `apps/web/lib/navigation.ts` is where that entry goes.
 */
export const GRADER_TABS = [
  { id: "library", label: "Library", href: "/graders" },
  { id: "running", label: "Running", href: "/graders/running" },
] as const;

export type GraderTab = (typeof GRADER_TABS)[number]["id"];
