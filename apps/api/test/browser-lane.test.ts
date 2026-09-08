import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Keep permission, lifecycle, refusal, run-start, and repository-format
 * matrices in focused tests. Reserve browser coverage for navigation, origin
 * rewrites, independent tabs, layout, and media behavior.
 * This file checks that the focused test coverage remains present.
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
    concern: "each repeated run start creates a separate run",
    file: "packages/db/test/test-suites.test.ts",
    says: /creates separate runs for repeated/iu,
  },
  {
    concern: "repository synchronization, atomicity, and what it refuses",
    file: "apps/api/test/test-suites-cutover.test.ts",
    says: /repository\/change-set/iu,
  },
  {
    concern: "the CLI and API suite contract for repository push and run",
    file: "apps/api/test/cli-platform-contract.test.ts",
    says: /starts a suite through the CLI/iu,
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
