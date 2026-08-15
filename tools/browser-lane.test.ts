import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * The one thing the lane split can still get wrong, and the only guard it needs.
 *
 * `vitest.config.ts` names one path twice: the fast lane excludes it, and the
 * browser lane includes exactly it. Rename or move that file and both halves
 * quietly stop meaning anything — the fast lane excludes nothing, so it starts
 * a real Chrome on every run, and the browser lane includes nothing, so the
 * proof that costs the most silently proves nothing at all. Neither failure
 * reports itself, because "no tests matched" is not an error a passing lane
 * distinguishes from "everything matched passed".
 *
 * Everything else the old hand-kept lane list checked is now Vitest's own
 * concern: the fast lane declares no `include`, so a new test file joins it by
 * existing rather than by somebody remembering to add a pattern.
 */
describe("the file the two lanes are built around", () => {
  it("is still where both lanes say it is", () => {
    const named = "apps/api/test/browser.test.ts";
    const onDisk = fileURLToPath(new URL(`../${named}`, import.meta.url));

    expect(
      existsSync(onDisk),
      `vitest.config.ts excludes ${named} from the fast lane and gives it to the ` +
        `browser lane, and it is not there. Update both halves of the config.`,
    ).toBe(true);
  });
});
