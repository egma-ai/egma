import { fileURLToPath } from "node:url";

import { defaultExclude, defineConfig } from "vitest/config";

const resolve = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/**
 * The real-browser acceptance proof: one ordered file, deliberately.
 *
 * Two Next development servers compile into one `apps/web/.next` and each ends
 * up serving half of the other's build, so this file runs alone and its tests
 * run in order. `apps/api/test/support/instance.ts` and
 * `apps/web/tools/output-lock.ts` record what enforces that.
 */
const REAL_BROWSER_TEST = "apps/api/test/browser.test.ts";

/**
 * The private planning repository, linked into this checkout rather than nested.
 *
 * It is a separate Git repository with test files of its own, and Vitest's
 * default search reaches through the link and finds them. They are not this
 * repository's tests and must not run here.
 */
const THE_PLANNING_REPOSITORY = "egma-planning/**";

/**
 * Two lanes, so daily work does not pay for a real browser on every edit.
 *
 * **The lanes are defined by what they leave out, never by a list of what they
 * hold.** Vitest's own default already finds every test file in every
 * JavaScript and TypeScript extension, so a new test file joins the fast lane
 * by existing. A hand-kept list of what to include cannot do that: a file the
 * list does not name runs nowhere, fails nothing, and leaves the run green. It
 * is the one mistake in this area that gives no signal at all, so the shape
 * here is chosen to make it impossible rather than to guard against it.
 */
const SHARED = {
  env: { LOG_LEVEL: "silent" },
  testTimeout: 30_000,
  hookTimeout: 60_000,
} as const;

export default defineConfig({
  // The web application's own tsconfig says `jsx: preserve`, because Next does
  // the transform. Nothing does it here, so the component tests say who.
  esbuild: { jsx: "automatic" },
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
    // Every database test owns a freshly created database, so files can run in
    // parallel; within a file the order matters. Root-only, not per project.
    fileParallelism: true,
    projects: [
      {
        extends: true,
        test: {
          name: "fast",
          // No `include`. The default finds everything; the lane is the
          // exclusion. See the note above for why that direction is the
          // load-bearing part of this config.
          exclude: [
            ...defaultExclude,
            THE_PLANNING_REPOSITORY,
            "**/.next/**",
            REAL_BROWSER_TEST,
          ],
          // The CLI tests drive the built entry point, because that is what a
          // developer runs, and the grader test drives the one its image runs.
          // Building both here keeps two test files from racing to build one.
          globalSetup: [
            "apps/cli/test/support/build-cli.ts",
            "apps/grader/test/support/build-grader.ts",
          ],
          ...SHARED,
        },
      },
      {
        extends: true,
        test: {
          name: "browser",
          include: [REAL_BROWSER_TEST],
          // Builds neither entry point: this lane runs neither, and two builds
          // it will not use are a minute added to the proof that already costs
          // the most.
          globalSetup: [],
          ...SHARED,
        },
      },
    ],
  },
});
