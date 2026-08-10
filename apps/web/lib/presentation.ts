export type Theme = "light" | "dark";

export const THEME_STORAGE_KEY = "egma-theme";

export function themeFromStored(value: string | null): Theme {
  return value === "dark" ? "dark" : "light";
}

export function nextTheme(theme: Theme): Theme {
  return theme === "light" ? "dark" : "light";
}

export const PRODUCT_NAVIGATION = [
  { id: "home", label: "Home", href: "/" },
  { id: "transcripts", label: "Transcripts", href: "/traces" },
  { id: "people", label: "People", href: "/members" },
] as const;

export type ProductSection = (typeof PRODUCT_NAVIGATION)[number]["id"];
