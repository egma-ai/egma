export type Theme = "light" | "dark";

export const THEME_STORAGE_KEY = "egma-theme";

export function themeFromStored(value: string | null): Theme {
  return value === "dark" ? "dark" : "light";
}

export function nextTheme(theme: Theme): Theme {
  return theme === "light" ? "dark" : "light";
}

export const PRODUCT_NAVIGATION = [
  { id: "transcripts", label: "Transcripts", href: "/traces" },
  // One section for both grader screens: the shelf of definitions, and the
  // copies a project is judging with. Its label is the plain word for what is
  // in it rather than "Library", which says where something is kept and not
  // what it is.
  { id: "graders", label: "Graders", href: "/graders" },
] as const;

export type ProductSection = (typeof PRODUCT_NAVIGATION)[number]["id"];

/**
 * The two screens inside the Graders section, and the order they read in.
 *
 * **The library first, because that is where a grader comes from.** A running
 * grader is a copy of a library entry, so somebody who has just arrived meets
 * the shelf, presses Use on something, and finds it on the second tab. The
 * reverse order would show a list of copies before anything explained what they
 * were copies of.
 *
 * Here beside the main navigation rather than in either screen's copy file,
 * because a strip whose labels lived in one of the two pages would be a page
 * naming its sibling — and the tab that is not current has to be named by
 * something neither page owns.
 */
export const GRADER_TABS = [
  { id: "library", label: "Library", href: "/graders" },
  { id: "running", label: "Running", href: "/graders/running" },
] as const;

export type GraderTab = (typeof GRADER_TABS)[number]["id"];
