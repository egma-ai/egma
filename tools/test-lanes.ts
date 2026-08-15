import { glob } from "node:fs/promises";

/**
 * Which tests a command runs, and how that command says which it chose.
 *
 * The TypeScript suite holds two kinds of proof with two very different costs.
 * Almost all of it is unit, database, API, grader, CLI and web tests: hundreds
 * of files, each measured in milliseconds, and the loop somebody edits code in.
 * One file is the real-browser acceptance proof — a real Chrome driven against a
 * real Next process, a real API, a real PostgreSQL and a real ClickHouse — and
 * it costs about a minute of compiling before it asserts anything.
 *
 * Paying that minute after every small edit is how a suite stops being run. So
 * the two are named lanes: `fast` for the loop, `browser` for the proof, and
 * `all` for the run that has to be complete. Nothing is dropped by the split —
 * `all` is exactly `fast` plus `browser`, and a test above holds the three to
 * that.
 *
 * A lane is data rather than a switch inside the Vitest configuration so that
 * what each one selects can be asked in a test, against the files really on
 * disk. A pattern that stopped matching the CLI tests would otherwise look
 * exactly like a suite that had got faster.
 */

export const LANE_NAMES = ["all", "fast", "browser"] as const;

export type LaneName = (typeof LANE_NAMES)[number];

/**
 * Every TypeScript test the repository has, by where each kind lives.
 *
 * `tools/` is here because this file's own tests live beside it, and a rule
 * about which tests run is worth nothing if the rule itself is unproved.
 */
const EVERY_TEST = [
  "tools/**/*.test.ts",
  "packages/*/src/**/*.test.ts",
  "packages/*/test/**/*.test.ts",
  "apps/api/test/**/*.test.ts",
  "apps/grader/test/**/*.test.ts",
  "apps/web/test/**/*.test.ts",
  "apps/cli/test/**/*.test.ts",
] as const;

/**
 * The real-browser acceptance proof: one file, deliberately.
 *
 * Two Next development servers compile into one `apps/web/.next` and each ends
 * up serving half of the other's build, so the browser tests run one at a time —
 * and Vitest runs the tests within one file in order, which makes one file the
 * whole of that arrangement. `apps/api/test/support/instance.ts` records the
 * alternatives and what they cost.
 */
export const REAL_BROWSER_TESTS = ["apps/api/test/browser.test.ts"] as const;

export type Lane = {
  readonly name: LaneName;
  /** Glob patterns, repository-relative, exactly as Vitest reads them. */
  readonly include: readonly string[];
  readonly exclude: readonly string[];
  /** One line saying what this lane proves, printed before it runs. */
  readonly proves: string;
  /**
   * Whether the run has to build the CLI and grader entry points first.
   *
   * The tests that drive `egma` as a real command and the grader as a real
   * container's process run the built entry point rather than the sources, so
   * the suite builds both up front. The browser lane runs neither, and waiting
   * on two builds it will not use is a minute added to the proof that already
   * costs the most.
   */
  readonly buildsEntryPoints: boolean;
};

const LANES: { readonly [name in LaneName]: Lane } = {
  all: {
    name: "all",
    include: EVERY_TEST,
    exclude: [],
    proves: "every fast test and the real-browser proof, in one run",
    buildsEntryPoints: true,
  },
  fast: {
    name: "fast",
    include: EVERY_TEST,
    exclude: REAL_BROWSER_TESTS,
    proves:
      "the unit, database, API, grader, CLI and web tests — no Chrome, no web application",
    buildsEntryPoints: true,
  },
  browser: {
    name: "browser",
    include: REAL_BROWSER_TESTS,
    exclude: [],
    proves:
      "the ordered real-browser journey, against a real Chrome, the web application, the API, PostgreSQL and ClickHouse",
    buildsEntryPoints: false,
  },
};

/**
 * The lane a command asked for, or the complete run when it asked for none.
 *
 * A name this file does not have is refused rather than quietly widened to
 * everything: a typo in a CI job would otherwise run the browser proof under a
 * job that says it is the fast lane, and the run would pass while proving
 * something other than what its name claims.
 */
export function laneNamed(asked: string | undefined): Lane {
  if (asked === undefined || asked === "") return LANES.all;

  const found = LANE_NAMES.find((name) => name === asked);
  if (found === undefined) {
    throw new Error(
      `there is no "${asked}" test lane. The lanes are ${LANE_NAMES.join(", ")}.`,
    );
  }
  return LANES[found];
}

/** The line a run prints first, so a reader can tell which proof they got. */
export function announcement(lane: Lane): string {
  return `egma test lane: ${lane.name} — ${lane.proves}`;
}

async function matching(
  patterns: readonly string[],
  root: string,
): Promise<Set<string>> {
  const found = new Set<string>();
  for (const pattern of patterns) {
    for await (const file of glob(pattern, { cwd: root })) {
      found.add(file.split("\\").join("/"));
    }
  }
  return found;
}

/**
 * The files a lane really selects, resolved against a checkout.
 *
 * This is what the tests beside this file ask, and it reads the same two
 * pattern lists Vitest is handed — so a lane that has stopped matching what it
 * claims answers differently here before anybody notices a suite that got
 * suspiciously quick.
 */
export async function filesInLane(
  lane: Lane,
  root: string,
): Promise<readonly string[]> {
  const included = await matching(lane.include, root);
  for (const excluded of await matching(lane.exclude, root)) {
    included.delete(excluded);
  }
  return [...included].sort();
}
