import { readFile } from "node:fs/promises";

import { expect, it } from "vitest";

const ADAPTERS = [
  "projects",
  "repository",
  "runs",
  "test-suites",
  "tests",
] as const;

it("keeps every suite repository adapter on the generated v1 client", async () => {
  for (const adapter of ADAPTERS) {
    const source = await readFile(
      new URL(`../src/platform/${adapter}.ts`, import.meta.url),
      "utf8",
    );
    expect(source, adapter).toContain("@egma/platform-api/client");
    expect(source, adapter).not.toMatch(/['"`]\/api\//u);
    expect(source, adapter).not.toMatch(/\.\/(?:contract|identity|wire)\.ts/u);
  }
});
