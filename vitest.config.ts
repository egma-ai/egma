import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const resolve = (path: string) => fileURLToPath(new URL(path, import.meta.url));

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
    // developer runs; the grader test drives the one its image runs; and the
    // platform-binding acceptance check starts two whole APIs as real
    // processes, which run the built one too. Building them here keeps two
    // test files from racing to build one.
    globalSetup: [
      "apps/cli/test/support/build-cli.ts",
      "apps/grader/test/support/build-grader.ts",
      "apps/api/test/support/build-api.ts",
    ],
    include: [
      "packages/*/src/**/*.test.ts",
      "packages/*/test/**/*.test.ts",
      "apps/api/test/**/*.test.ts",
      "apps/grader/test/**/*.test.ts",
      "apps/web/test/**/*.test.ts",
      "apps/cli/test/**/*.test.ts",
    ],
    // The API logs a line per request, and a test run is thousands of them.
    env: { LOG_LEVEL: "silent" },
    // Every database test owns a freshly created database, so files can run in
    // parallel; within a file the order matters.
    fileParallelism: true,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
