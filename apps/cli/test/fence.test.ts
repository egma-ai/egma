import { describe, expect, it } from "vitest";

import { FENCE_MESSAGE, fencedPathIn, isFenced } from "../src/acp/fence.ts";

describe("the .env fence", () => {
  it("refuses every file whose name starts with .env", () => {
    expect(isFenced(".env")).toBe(true);
    expect(isFenced("/home/dev/repo/.env.local")).toBe(true);
    expect(isFenced("config/.env.production")).toBe(true);
    expect(isFenced(".env.example")).toBe(true);
  });

  it("leaves everything else alone", () => {
    expect(isFenced("package.json")).toBe(false);
    expect(isFenced("/home/dev/repo/src/env.ts")).toBe(false);
    expect(isFenced("docs/environment.md")).toBe(false);
    expect(isFenced("")).toBe(false);
  });

  it("finds a fenced file wherever a tool call names one", () => {
    expect(fencedPathIn({ locations: [{ path: "/repo/.env" }] })).toBe("/repo/.env");
    expect(fencedPathIn({ rawInput: { file_path: "/repo/.env.local" } })).toBe(
      "/repo/.env.local",
    );
    expect(
      fencedPathIn({ locations: [{ path: "/repo/README.md" }], rawInput: { pattern: "TODO" } }),
    ).toBeNull();
  });

  it("tells the agent where to go instead", () => {
    expect(FENCE_MESSAGE).toContain("ask the developer");
  });
});
