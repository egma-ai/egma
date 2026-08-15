import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  announcement,
  filesInLane,
  laneNamed,
  REAL_BROWSER_TESTS,
} from "./test-lanes.ts";

/**
 * What each lane actually selects, resolved against the files on disk.
 *
 * The patterns are only worth what they match, so nothing here asserts about a
 * pattern. Each case globs the repository the way Vitest will and asks what came
 * back — which is the one question a wrong pattern answers differently.
 */

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

describe("choosing a lane", () => {
  it("runs everything when nobody asked for a lane", () => {
    expect(laneNamed(undefined).name).toBe("all");
    expect(laneNamed("").name).toBe("all");
  });

  it("refuses a lane it does not have, and names the ones it does", () => {
    expect(() => laneNamed("browsers")).toThrow(/browsers/);
    expect(() => laneNamed("browsers")).toThrow(/all, fast, browser/);
  });

  it("says which lane is running, by name and by what it proves", () => {
    // Written out rather than read back off the lane, which would be the same
    // sentence compared with itself and could never disagree with anything.
    expect(announcement(laneNamed("fast"))).toBe(
      "egma test lane: fast — the unit, database, API, grader, CLI and web " +
        "tests — no Chrome, no web application",
    );
    expect(announcement(laneNamed("browser"))).toBe(
      "egma test lane: browser — the ordered real-browser journey, against a " +
        "real Chrome, the web application, the API, PostgreSQL and ClickHouse",
    );
    expect(announcement(laneNamed("all"))).toBe(
      "egma test lane: all — every fast test and the real-browser proof, in " +
        "one run",
    );
  });
});

describe("what a lane selects", () => {
  it("gives the browser lane the real-browser acceptance file and nothing else", async () => {
    expect(await filesInLane(laneNamed("browser"), ROOT)).toEqual([
      ...REAL_BROWSER_TESTS,
    ]);
  });

  it("starts no browser in the fast lane", async () => {
    const fast = await filesInLane(laneNamed("fast"), ROOT);

    for (const browserTest of REAL_BROWSER_TESTS) {
      expect(fast).not.toContain(browserTest);
    }
  });

  it("keeps the unit, database, API, grader, CLI and web tests in the fast lane", async () => {
    const fast = await filesInLane(laneNamed("fast"), ROOT);
    const someFileUnder = (directory: string): string | undefined =>
      fast.find((file) => file.startsWith(directory));

    for (const directory of [
      "packages/ids/src/",
      "packages/db/test/",
      "apps/api/test/",
      "apps/grader/test/",
      "apps/cli/test/",
      "apps/web/test/",
    ]) {
      expect(someFileUnder(directory), `no fast test under ${directory}`).toBeDefined();
    }
  });

  it("loses no test file to the split", async () => {
    const all = await filesInLane(laneNamed("all"), ROOT);
    const fast = await filesInLane(laneNamed("fast"), ROOT);
    const browser = await filesInLane(laneNamed("browser"), ROOT);

    expect([...fast, ...browser].sort()).toEqual(all);
    expect(fast.filter((file) => browser.includes(file))).toEqual([]);
  });
});
