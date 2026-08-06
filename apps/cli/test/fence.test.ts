import { describe, expect, it } from "vitest";

import {
  FENCE_MESSAGE,
  fencedFileIn,
  fencedReferenceIn,
  isFenced,
  stringsIn,
} from "../src/acp/fence.ts";

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
    expect(fencedReferenceIn({ locations: [{ path: "/repo/.env" }] })).toBe(".env");
    expect(fencedReferenceIn({ rawInput: { file_path: "/repo/.env.local" } })).toBe(".env.local");
    expect(
      fencedReferenceIn({
        locations: [{ path: "/repo/README.md" }],
        rawInput: { pattern: "TODO" },
      }),
    ).toBeNull();
  });

  it("reads a command line, where the file is a word and not a path", () => {
    expect(fencedFileIn("cat .env")).toBe(".env");
    expect(fencedFileIn("grep KEY .env.local")).toBe(".env.local");
    expect(fencedFileIn("head -n 5 /repo/.env.production")).toBe(".env.production");
    expect(fencedFileIn("cat ./.env && echo done")).toBe(".env");
    expect(fencedFileIn('cat "$(pwd)/.env"')).toBe(".env");
    expect(fencedFileIn("cat --file=.env")).toBe(".env");
  });

  it("does not refuse a command that only mentions the word", () => {
    expect(fencedFileIn("npm run build")).toBeNull();
    expect(fencedFileIn("node -e 'console.log(process.env.PORT)'")).toBeNull();
    expect(fencedFileIn("grep -rn environment docs")).toBeNull();
    expect(fencedFileIn("cat src/env.ts")).toBeNull();
  });

  it("refuses a shell tool call, which carries a command and no path at all", () => {
    expect(fencedReferenceIn({ rawInput: { command: "cat .env" } })).toBe(".env");
    expect(fencedReferenceIn({ rawInput: { command: "grep KEY .env.local" } })).toBe(".env.local");
    expect(fencedReferenceIn({ rawInput: { command: "ls -la" } })).toBeNull();
  });

  it("refuses an arguments array, and a shape with the command buried in it", () => {
    expect(
      fencedReferenceIn({ rawInput: { command: "grep", args: ["-n", "KEY", ".env.local"] } }),
    ).toBe(".env.local");
    expect(
      fencedReferenceIn({
        rawInput: { tool: { input: { terminal: { command: "cat /repo/.env.production" } } } },
      }),
    ).toBe(".env.production");
    expect(fencedReferenceIn({ rawInput: { steps: [{ run: ["cat", ".env"] }] } })).toBe(".env");
    expect(fencedReferenceIn({ rawInput: { steps: [{ run: ["ls", "src"] }] } })).toBeNull();
  });

  it("reads every string a raw input holds, through arrays and objects alike", () => {
    expect(stringsIn({ a: "one", b: [2, "two", { c: "three" }] })).toEqual([
      "one",
      "two",
      "three",
    ]);
    expect(stringsIn(null)).toEqual([]);
    expect(stringsIn(undefined)).toEqual([]);
  });

  it("tells the agent where to go instead", () => {
    expect(FENCE_MESSAGE).toContain("ask the developer");
  });
});
