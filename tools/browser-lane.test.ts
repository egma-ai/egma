import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * Check that the browser test exists and is included only in its own lane.
 * Its path appears in both the browser include and fast-lane exclusion, so
 * a rename must update both.
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
