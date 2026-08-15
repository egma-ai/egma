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
  // The shelf of grader definitions. Its label is the plain word for what is
  // on it rather than "Library", which says where it is kept and not what it
  // holds — and the running copies join this same section when they arrive.
  { id: "graders", label: "Graders", href: "/graders" },
] as const;

export type ProductSection = (typeof PRODUCT_NAVIGATION)[number]["id"];
