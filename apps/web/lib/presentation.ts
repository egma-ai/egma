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
 * Human labels for the machine names of predefined graders.
 *
 * The API keeps these stable keys because runs and frozen grading plans need
 * durable names. Product surfaces pass the stored value through this one
 * presentation seam instead of teaching each route how to title it. A team
 * name that is not one of these keys is returned exactly as it was written.
 */
const PREDEFINED_GRADER_DISPLAY_NAMES: ReadonlyMap<string, string> = new Map([
  ["expected_behaviors", "Expected behaviors"],
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
