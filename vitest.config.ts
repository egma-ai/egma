import { availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const resolve = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/**
 * The files that need the machine to themselves, run one at a time.
 *
 * Seven of these drive the built wizard through a real pseudo-terminal, and
 * one starts two whole APIs as real processes. A test file elsewhere in the
 * suite is one process doing one thing; each of these is three or four
 * processes, and what they check is a *screen* — a frame the wizard paints
 * while a coding agent it started writes files. That makes them the only files
 * here with a deadline measured in wall-clock time, and the only ones a busy
 * machine can fail without anything being wrong.
 *
 * Two of them at once is what does it. On a four-core box a walk that takes
 * two seconds alone has been caught still generating its third test a minute
 * later, beside another walk and a pair of APIs. Raising the budget was tried
 * first and does not work — the budget went to two minutes and then to five,
 * and a walk reached five — because the walk is not slow, it is starved.
 *
 * So they run in a pool of their own, one at a time, while the rest of the
 * suite runs beside them at full width. They add nothing to the wall clock:
 * together they are about two minutes, inside a run that is five.
 */
const WALKS = [
  "apps/cli/test/binding-across-platforms.test.ts",
  "apps/cli/test/connect-screen.test.ts",
  "apps/cli/test/gate-screen.test.ts",
  "apps/cli/test/interrupt.test.ts",
  "apps/cli/test/login-screen.test.ts",
  "apps/cli/test/run-screen.test.ts",
  "apps/cli/test/teaching.test.ts",
  "apps/cli/test/tui.test.ts",
];

const EVERYTHING_ELSE = [
  "packages/*/src/**/*.test.ts",
  "packages/*/test/**/*.test.ts",
  "apps/api/test/**/*.test.ts",
  "apps/grader/test/**/*.test.ts",
  "apps/web/test/**/*.test.ts",
  "apps/cli/test/**/*.test.ts",
];

/** One core is the walk's; the rest of the suite has the others. */
const REST = Math.max(1, availableParallelism() - 1);

const shared = {
  resolve: {
    alias: {
      "@egma/ids": resolve("./packages/ids/src/index.ts"),
      "@egma/db": resolve("./packages/db/src/index.ts"),
      "@egma/simulation-contract": resolve(
        "./packages/simulation-contract/src/index.ts",
      ),
    },
  },
};

export default defineConfig({
  ...shared,
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
    projects: [
      {
        ...shared,
        test: {
          name: "walks",
          include: WALKS,
          // The whole point of the split: one of these at a time. `isolate`
          // stays on, so sharing the one worker does not mean sharing state.
          poolOptions: {
            forks: { singleFork: true, isolate: true },
            threads: { singleThread: true, isolate: true },
          },
          env: { LOG_LEVEL: "silent" },
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
      {
        ...shared,
        test: {
          name: "rest",
          include: EVERYTHING_ELSE,
          exclude: WALKS,
          env: { LOG_LEVEL: "silent" },
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
    // Every database test owns a freshly created database, so files can run in
    // parallel; within a file the order matters. How many at once is set here
    // rather than per project, which is where vitest reads it: one core is the
    // walk's, and the rest of the suite has the others.
    fileParallelism: true,
    poolOptions: {
      forks: { maxForks: REST },
      threads: { maxThreads: REST },
    },
  },
});
