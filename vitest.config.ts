import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

import { announcement, laneNamed } from "./tools/test-lanes.ts";

const resolve = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/**
 * Which tests this run holds, chosen by `EGMA_TEST_LANE` and said out loud.
 *
 * `tools/test-lanes.ts` owns what each lane selects and why there are lanes at
 * all. The line below is printed before anything runs, because the whole point
 * of a split suite is that a reader can tell which proof they just got — a
 * green run means something different in each lane.
 */
const lane = laneNamed(process.env.EGMA_TEST_LANE);
process.stderr.write(`\n${announcement(lane)}\n\n`);

export default defineConfig({
  resolve: {
    alias: {
      "@egma/ids": resolve("./packages/ids/src/index.ts"),
      "@egma/db": resolve("./packages/db/src/index.ts"),
      "@egma/simulation-contract": resolve(
        "./packages/simulation-contract/src/index.ts",
      ),
    },
  },
  test: {
    // The CLI tests drive the built entry point, because that is what a
    // developer runs, and the grader test drives the one its image runs.
    // Building both here keeps two test files from racing to build one. The
    // browser lane runs neither, so it waits on neither.
    globalSetup: lane.buildsEntryPoints
      ? [
          "apps/cli/test/support/build-cli.ts",
          "apps/grader/test/support/build-grader.ts",
        ]
      : [],
    include: [...lane.include],
    exclude: [...lane.exclude, "**/node_modules/**", "**/dist/**"],
    // The API logs a line per request, and a test run is thousands of them.
    env: { LOG_LEVEL: "silent" },
    // Every database test owns a freshly created database, so files can run in
    // parallel; within a file the order matters.
    fileParallelism: true,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
