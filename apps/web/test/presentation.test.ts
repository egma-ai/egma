import { describe, expect, it } from "vitest";

import {
  nextTheme,
  PRODUCT_NAVIGATION,
  themeFromStored,
} from "../lib/presentation.ts";

describe("the visual theme", () => {
  it("starts light when no choice was stored", () => {
    expect(themeFromStored(null)).toBe("light");
    expect(themeFromStored("system")).toBe("light");
  });

  it("keeps an explicit dark choice and toggles in both directions", () => {
    expect(themeFromStored("dark")).toBe("dark");
    expect(nextTheme("light")).toBe("dark");
    expect(nextTheme("dark")).toBe("light");
  });
});

describe("the product navigation", () => {
  it("names only pages that exist", () => {
    expect(PRODUCT_NAVIGATION).toEqual([
      { id: "home", label: "Home", href: "/" },
      { id: "transcripts", label: "Transcripts", href: "/traces" },
    ]);
  });
});
