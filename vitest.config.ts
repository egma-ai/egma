import { availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const resolve = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/**
 * How many test files run at once — half the cores, not all of them.
 *
 * Vitest's default is one worker per core, which is right for a suite whose
 * files are the work. Here a file is rarely the work: one starts the built CLI,
 * a coding agent and a pseudo-terminal; one starts two whole APIs; one starts a
 * Next development server that compiles pages; one starts the Python simulator
 * and the grader. A worker is three or four processes, so one worker per core
 * is three or four times the machine.
 *
 * What that oversubscription does is not spread evenly. Everything with a
 * deadline measured in wall-clock time — every wizard walk driven through a
 * terminal — is what starves, and it starves spectacularly: the same file has
 * been seen taking 22 seconds in one run and 319 in the next on a four-core
 * box, still working when its budget ran out. Halving the workers is the fix
 * that treats the cause; raising the budget only moves the moment it is reached.
 */
const WORKERS = Math.max(1, Math.floor(availableParallelism() / 2));

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
    poolOptions: {
      forks: { maxForks: WORKERS },
      threads: { maxThreads: WORKERS },
    },
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
