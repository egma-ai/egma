import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  formatViewerInstant,
  relativeViewerInstant,
} from "../lib/instants.ts";
import {
  graderDisplayName,
  nextTheme,
  ownerDisplayName,
  themeFromStored,
} from "../lib/presentation.ts";

describe("viewer-local instants", () => {
  it("uses the viewer's zone at every display precision", () => {
    const instant = "2026-08-17T06:49:40.000Z";

    expect(formatViewerInstant(instant, "day", "America/Los_Angeles")).toBe(
      "2026-08-16",
    );
    expect(formatViewerInstant(instant, "minute", "America/Los_Angeles")).toBe(
      "2026-08-16 23:49 PDT",
    );
    expect(formatViewerInstant(instant, "second", "America/Los_Angeles")).toBe(
      "2026-08-16 23:49:40 PDT",
    );

    const now = Date.parse("2026-08-17T12:00:00.000Z");
    expect(relativeViewerInstant("2026-08-17T11:55:00.000Z", now)).toBe(
      "5 minutes ago",
    );
    expect(relativeViewerInstant("2026-08-16T12:00:00.000Z", now)).toBe(
      "yesterday",
    );
    expect(relativeViewerInstant("2026-08-01T12:00:00.000Z", now)).toBe(
      "2 weeks ago",
    );
    expect(relativeViewerInstant("2026-05-17T12:00:00.000Z", now)).toBe(
      "3 months ago",
    );
    expect(relativeViewerInstant("2024-08-17T12:00:00.000Z", now)).toBe(
      "2 years ago",
    );
  });
});

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
    expect(graderDisplayName("Never promises a price")).toBe(
      "Never promises a price",
    );
  });
});

describe("definition owners", () => {
  it("uses the same owner words for every reusable definition", () => {
    expect(ownerDisplayName("egma")).toBe("Egma");
    expect(ownerDisplayName("organization")).toBe("You");
    expect(ownerDisplayName("new-owner")).toBe("new-owner");
  });
});

describe("the shared form controls", () => {
  it("centers every enhanced select instead of relying on the browser default", async () => {
    const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

    expect(css).toMatch(/select, ::picker\(select\) \{ appearance: base-select; \}/);
    expect(css).toMatch(/select \{ align-items: center; \}/);
  });

  /*
   * The picker is the product's box to size once `base-select` is asked for,
   * and Chrome's default for a box nobody sized is `max-height: stretch` —
   * as tall as the space allows. A project with thirty test suites opened a
   * picker 584px tall whose lower edge sat flush against the window, which
   * reads as a broken render rather than as a list that scrolls. A short list
   * hides the fault entirely, so no page test can be trusted to catch it
   * coming back; the cap itself is what this holds.
   */
  it("bounds the open select picker instead of letting it fill the window", async () => {
    const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

    expect(css).toMatch(/::picker\(select\) \{ max-height: min\(/);
    expect(css).toMatch(/overscroll-behavior: contain;/);
  });
});
