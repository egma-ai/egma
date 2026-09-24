import { describe, expect, it } from "vitest";

import {
  formatViewerInstant,
  relativeViewerInstant,
} from "../lib/instants.ts";

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
