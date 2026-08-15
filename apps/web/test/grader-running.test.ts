import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import * as copy from "../lib/grader-running-copy.ts";
import { GRADER_TABS } from "../lib/presentation.ts";
import { navigationFor } from "../lib/navigation.ts";

/**
 * The Running-graders screen: what it says, where it reaches, and how somebody
 * gets between it and the shelf beside it.
 *
 * The Library screen's arrangement, applied to its sibling. The words are in
 * one file so they can be held against the domain model's banned list, and the
 * page is held to rendering that file rather than string literals of its own —
 * a heading typed straight into the markup is a word nothing above can check,
 * which is the failure this whole arrangement exists to prevent.
 */

const WEB = path.join(import.meta.dirname, "..");

/**
 * The banned list, as the domain model writes it, for this screen.
 *
 * `evaluator`, `scorer` and `eval` are the words somebody arriving from another
 * product would type here first. `dimension` and `gate` are the redesign's own
 * retirements — the verdict store's old column name, and the word considered
 * for the must-pass flag and not chosen, which is exactly the word a heading
 * for `required` would reach for. `check` is the borrowed word for one
 * criterion inside a grader, and it is the one this screen would reach for when
 * counting a copy's filled-in values. `built-in` is the old name for what is
 * now a predefined grader, and this is the screen where the old built-in became
 * a row.
 *
 * `metric` is deliberately **not** here, and the distinction is the reason: a
 * metric measures and a grader judges, so the word is banned for *scoring
 * logic* and is the right word for the thing a latency copy reads. This screen
 * will name one the moment it shows a copy's bound.
 *
 * `assertion` is deliberately **not** here. It was un-banned by the same
 * redesign that built this screen and is now the canonical word for one 0-or-1
 * decision inside a grader — the ban that stands is narrower: an assertion is
 * never a grader.
 */
const NEVER_SAID = [
  "eval",
  "evaluation",
  "evaluator",
  "scorer",
  "check",
  "dimension",
  "gate",
  "built-in",
  "digital human",
  "trace",
  "span",
  "conversation",
  "caller",
  "scenario",
  "experiment",
  "batch",
];

/** Every string this screen can put in front of somebody. */
function everySentence(said: unknown): string[] {
  if (typeof said === "string") return [said];
  if (typeof said === "function") {
    // The counted ones, asked at both the singular and the plural.
    return [1, 2].map((howMany) => String((said as (n: number) => string)(howMany)));
  }
  if (Array.isArray(said)) return said.flatMap(everySentence);
  if (typeof said === "object" && said !== null) {
    return Object.values(said).flatMap(everySentence);
  }
  return [];
}

describe("what the Running-graders screen says out loud", () => {
  it("is gathered in one place, so it can be held against the list", () => {
    expect(everySentence(copy).length).toBeGreaterThan(15);
  });

  it("uses no banned word and no retired one", () => {
    for (const sentence of everySentence(copy)) {
      for (const banned of NEVER_SAID) {
        expect(
          new RegExp(`\\b${banned}`, "iu").test(sentence),
          `"${sentence}" says "${banned}"`,
        ).toBe(false);
      }
    }
  });

  /**
   * The stored words are the vocabulary a column is written in, and nobody
   * should meet one. `simulations` is a storage word for "the tests you run";
   * `required` is a boolean, and what a person wants to know is whether a
   * failure stops a test passing.
   */
  it("turns the stored scope and the required flag into words a person reads", () => {
    expect(copy.SCOPES["simulations"]).toBeDefined();
    expect(copy.SCOPES["production"]).toBeDefined();
    expect(copy.SCOPES["both"]).toBeDefined();
    expect(copy.REQUIRED.yes).toBeDefined();
    expect(copy.REQUIRED.no).toBeDefined();
  });

  /**
   * **A grader holding nothing is complete, not half-finished.** The
   * expected-behaviors grader checks whatever the test in front of it says, so
   * there is nothing for anybody to fill in — and a count of nought in that
   * cell would read as a grader somebody forgot to set up.
   */
  it("says what an empty configuration means rather than showing a nought", () => {
    expect(copy.CONFIG.fromTheTest).toBeTruthy();
    expect(copy.CONFIG.counted(1)).toContain("1");
  });

  it("is what the page actually renders", async () => {
    const page = await readFile(
      path.join(WEB, "app/graders/running/page.tsx"),
      "utf8",
    );
    expect(page).toContain("grader-running-copy.ts");
  });
});

describe("getting to the Running-graders screen", () => {
  /**
   * Two screens, one section. A grader is a copy *of* a library entry, so the
   * shelf and the copies are two halves of one idea and the strip is what
   * moves between them.
   *
   * **Neither is in the product navigation yet.** Both addresses carry no
   * project, and the shell reads the project out of the address — so wave one
   * leaves them unreachable rather than showing somebody whichever project
   * happens to be first in their list. See the Library screen's own note.
   */
  it("is one tab away from the library, and neither is in the navigation", () => {
    expect(GRADER_TABS.map((tab) => tab.href)).toEqual([
      "/graders",
      "/graders/running",
    ]);

    const { primary, secondary } = navigationFor("prj_01JQZ0000000000000000000AA");
    expect(
      [...primary, ...secondary].map((item) => item.id),
    ).not.toContain("graders");
  });

  it("puts the strip on both screens, each marking itself current", async () => {
    const library = await readFile(path.join(WEB, "app/graders/page.tsx"), "utf8");
    const running = await readFile(
      path.join(WEB, "app/graders/running/page.tsx"),
      "utf8",
    );

    expect(library).toContain('<GraderTabs active="library" />');
    expect(running).toContain('<GraderTabs active="running" />');
  });

  /**
   * A path the page fetches and the config does not forward would be served by
   * this process, which has no such route, and the screen would show Next's own
   * 404 as though egma had answered it.
   */
  it("reaches the API at a path this instance rewrites", async () => {
    const rewrites = await readFile(path.join(WEB, "next.config.ts"), "utf8");
    const page = await readFile(
      path.join(WEB, "app/graders/running/page.tsx"),
      "utf8",
    );

    expect(rewrites).toContain("/api/graders");
    expect(page).toContain('fetch("/api/graders")');
  });

  /**
   * The three facts somebody looking at this list actually wants: which grader
   * this is, where it applies, and whether its failure stops a run — plus what
   * it checks, which is the copy's own filled-in values and never the
   * definition behind them.
   */
  it("shows the scope, the required flag and a summary of what it checks", async () => {
    const page = await readFile(
      path.join(WEB, "app/graders/running/page.tsx"),
      "utf8",
    );

    expect(page).toContain("RUNNING_COLUMNS.scope");
    expect(page).toContain("RUNNING_COLUMNS.required");
    expect(page).toContain("RUNNING_COLUMNS.config");
    // Printed from what the answer said, never worked out from anything else
    // the page knows.
    expect(page).toContain("SCOPES[copy.scope]");
  });

  /**
   * A slow request must not replace the application with the access-page
   * composition — the sidebar, the navigation and the account menu stay put
   * until the API has said the session is gone.
   */
  it("keeps the application shell while its data settles", async () => {
    const page = await readFile(
      path.join(WEB, "app/graders/running/page.tsx"),
      "utf8",
    );
    expect(page).toContain('<AppShell active="graders">');
    expect(page).not.toMatch(/state\.status === "loading"[\s\S]*?return <StatePage/);
  });
});
