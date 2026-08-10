import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * The words the mocked world is described in, held to the ones the product has
 * settled on.
 *
 * One entity, one word: a **mock tool**. The inverted form and the two
 * near-synonyms each read as a different thing to somebody arriving from
 * another tool, and a schema, a wire field or a refusal sentence carrying one
 * of them is the version that sticks — a column is renamed by a migration, and
 * a refusal sentence a client branches on is renamed by nobody at all. So the
 * whole surface is read back and checked, rather than trusted to review.
 *
 * The files are the whole of what a caller can meet: the tables, the factory
 * and its refusals, the shared resolver, and the two route groups that carry
 * mock tools across the wire.
 */

const root = fileURLToPath(new URL("../../..", import.meta.url));

const SURFACE = [
  "packages/db/src/schema/mock-tools.ts",
  "packages/db/src/schema/runs.ts",
  "packages/db/migrations/0020_mock_tools.sql",
  "packages/db/src/access/mock-tools.ts",
  "packages/db/src/access/tests.ts",
  "packages/db/src/access/runs.ts",
  "packages/db/src/mock-tools/resolve.ts",
  "packages/db/src/access/errors.ts",
  "apps/api/src/http/mock-tools.ts",
  "apps/api/src/routes/mock-tools.ts",
  "apps/api/src/routes/tests.ts",
  "apps/api/src/routes/runs.ts",
];

/**
 * What must appear nowhere. Whole words, so `retrieval` is not read as an
 * `eval` and `mock_tool_agent` is not read as a `tool mock`.
 */
const BANNED: readonly { readonly word: string; readonly instead: string }[] = [
  { word: String.raw`tool\s+mocks?`, instead: "mock tool" },
  { word: String.raw`stubs?`, instead: "mock tool" },
  { word: String.raw`fakes?`, instead: "mock tool" },
  { word: String.raw`evals?`, instead: "nothing — say what is meant" },
  { word: String.raw`evaluations?`, instead: "nothing — say what is meant" },
  { word: String.raw`evaluators?`, instead: "grader" },
];

describe("the words the mocked world is described in", () => {
  it("carry no word the product has ruled out", async () => {
    for (const file of SURFACE) {
      const source = await readFile(path.join(root, file), "utf8");
      for (const { word, instead } of BANNED) {
        const found = new RegExp(`\\b${word}\\b`, "iu").exec(source);
        expect(
          found === null,
          `${file} says "${found?.[0] ?? ""}"; say ${instead}`,
        ).toBe(true);
      }
    }
  });
});
