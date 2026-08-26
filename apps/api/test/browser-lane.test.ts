import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Where each kind of proof lives, held so that the browser lane stays small.
 *
 * **The real-browser lane costs about two minutes and everything else costs
 * milliseconds**, so the pressure is always in one direction: a case is easier
 * to add to the file that already stands up Postgres, ClickHouse, the API, Next
 * and Chrome than to work out where it belongs. Ten of those and the ordered
 * journey is a suite, the lane is ten minutes, and nobody runs it.
 *
 * So the split is written down. A browser proves what only a browser can — that
 * the pages exist, that they are served from this instance's own origin, that
 * this process forwards the paths they use, that two independent tabs keep two
 * projects apart, that a real Chrome makes audio of a signed link, and that
 * clicking through in order gets somebody where they were going. **A matrix is
 * never one of those.** Every combination of role, lifecycle state, revision,
 * refusal, idempotency key and repository format is proved at
 * a seam where one case costs nothing, and the browser walks one path through
 * it.
 *
 * **What this file holds and what it does not.** It holds that each of those
 * proofs is still in the fast lane and still says something about its subject —
 * so moving one into the browser file means deleting it here, out loud, rather
 * than by drift. It does not measure the browser file, because a line count is
 * a number somebody raises rather than a rule anybody keeps. The discipline is
 * the ticket's own sentence: if you find yourself adding a permission case to
 * the browser, that is the signal it belongs here.
 */

const ROOT = path.join(import.meta.dirname, "../../..");

/**
 * Each concern this effort deliberately keeps out of the browser, the fast-lane
 * file that carries it, and a phrase that has to still be in it.
 *
 * The phrase is what stops this from being a list of filenames: a file can
 * survive as an empty shell, and an empty shell would keep this green while the
 * proof it names is gone.
 */
const PROVED_IN_THE_FAST_LANE: readonly {
  readonly concern: string;
  readonly file: string;
  readonly says: RegExp;
}[] = [
  {
    concern: "the archive matrix for agents and their connections",
    file: "apps/api/test/agents-lifecycle.test.ts",
    says: /archiv/iu,
  },
  {
    concern: "suite CRUD, permanent deletion, and immutable test membership",
    file: "apps/api/test/test-suites-cutover.test.ts",
    says: /immutable test membership/iu,
  },
  {
    concern: "what each role may do",
    file: "packages/db/test/permissions.test.ts",
    says: /viewer|member|admin/iu,
  },
  {
    concern: "the refusals a browser is shown, in egma's own words",
    file: "apps/api/test/project-context.test.ts",
    says: /project_outside_organization/u,
  },
  {
    // A persona used to carry a revision too, and this line named the file that
    // proved it. Personas are last-write-wins now, so that half of the concern
    // has no proof anywhere — it has no subject. The concern itself still
    // stands for the resources that kept their token, and this points at one of
    // them rather than being quietly dropped.
    concern: "revisions, and an edit sent against a stale one",
    file: "packages/db/test/projects.test.ts",
    says: /expectedRevision/u,
  },
  {
    concern: "idempotency keys on a run",
    file: "apps/api/test/runs-suite-contract.test.ts",
    says: /idempotency/iu,
  },
  {
    concern: "repository synchronization, atomicity, and what it refuses",
    file: "apps/api/test/test-suites-cutover.test.ts",
    says: /repository\/change-set/iu,
  },
  {
    concern: "the CLI and API suite contract for repository push and run",
    file: "apps/api/test/cli-platform-contract.test.ts",
    says: /atomic repository change/iu,
  },
];

describe("where the proof for each kind of thing lives", () => {
  it.each(PROVED_IN_THE_FAST_LANE)(
    "keeps $concern in the fast lane, in $file",
    async ({ file, says }) => {
      const full = path.join(ROOT, file);
      await expect(
        stat(full).then(() => true),
        `${file} is gone; if its proof moved, move this line with it`,
      ).resolves.toBe(true);

      const source = await readFile(full, "utf8");
      expect(says.test(source), `${file} no longer says anything about it`).toBe(
        true,
      );
    },
  );

  /**
   * And the lane really is one file.
   *
   * Read from the configuration rather than assumed, because the whole
   * arrangement above is only worth anything if the expensive lane is the small
   * one. Two Next development servers compile into one `apps/web/.next` and each
   * ends up serving half of the other's build, so this is also what keeps the
   * browser tests correct rather than merely quick.
   */
  it("runs exactly one file in the real-browser lane", async () => {
    const config = await readFile(path.join(ROOT, "vitest.config.ts"), "utf8");
    const named = [
      ...config.matchAll(/REAL_BROWSER_TEST = "([^"]+)"/gu),
    ].map((found) => found[1]);
    expect(named).toEqual(["apps/api/test/browser.test.ts"]);
    expect(config).toContain("include: [REAL_BROWSER_TEST]");
    expect(config).toContain(
      'const LOCAL_AGENT_WORKTREES = "**/.claude/worktrees/**"',
    );
    expect(config).toContain("LOCAL_AGENT_WORKTREES,");
  });

  it("builds the generated platform client before Next starts", async () => {
    const manifest = JSON.parse(
      await readFile(path.join(ROOT, "package.json"), "utf8"),
    ) as { readonly scripts?: Readonly<Record<string, string>> };

    expect(manifest.scripts?.["test:browser"]).toMatch(
      /^pnpm --filter @egma\/platform-api build && /u,
    );
  });
});
