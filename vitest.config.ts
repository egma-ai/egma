import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const resolve = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@egma/ids": resolve("./packages/ids/src/index.ts"),
      "@egma/db": resolve("./packages/db/src/index.ts"),
    },
  },
  test: {
    // The CLI tests drive the built entry point, because that is what a
    // developer runs. Building it here keeps two test files from racing to
    // build it themselves.
    globalSetup: ["apps/cli/test/support/build-cli.ts"],
    include: [
      "packages/*/src/**/*.test.ts",
      "packages/*/test/**/*.test.ts",
      "apps/api/test/**/*.test.ts",
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
