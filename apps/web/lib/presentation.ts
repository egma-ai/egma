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
