import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  graderDisplayName,
  nextTheme,
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

describe("predefined grader names", () => {
  it("shows machine keys as human labels without changing team names", () => {
    expect(graderDisplayName("expected_behaviors")).toBe("Expected behaviors");
    expect(graderDisplayName("latency")).toBe("Latency");
    expect(graderDisplayName("Never promises a price")).toBe(
      "Never promises a price",
    );
  });
});

describe("the shared form controls", () => {
  it("centers every enhanced select instead of relying on the browser default", async () => {
    const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

    expect(css).toMatch(
      /select, ::picker\(select\) \{ appearance: base-select; align-items: center; \}/,
    );
  });
});
