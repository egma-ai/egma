import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import * as copy from "../lib/grader-running-copy.ts";
import { GRADER_TABS, PRODUCT_NAVIGATION } from "../lib/presentation.ts";

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
   * shelf and the copies are two halves of one idea and the sidebar names the
   * idea; the strip is what moves between them. Two sidebar entries would make
   * them look like two features.
   */
  it("is one tab away from the library, inside the one Graders section", () => {
    const graders = PRODUCT_NAVIGATION.find((item) => item.id === "graders");
    expect(graders?.href).toBe("/graders");

    expect(GRADER_TABS.map((tab) => tab.href)).toEqual([
      "/graders",
      "/graders/running",
    ]);
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

/**
 * The two acts this screen owns, and the ones the shelf beside it cannot do.
 *
 * Pressing Use makes a copy; changing what that copy judges by and switching it
 * off are decisions about a grader that already exists. Before this screen had
 * them, a bound typed too tight was permanent — every run red for ever, with no
 * way back short of somebody editing the database by hand.
 */
describe("changing a running copy and switching one off", () => {
  /**
   * A path the page writes to and the config does not forward would be served
   * by this process, which has no such route, and the screen would read Next's
   * own 404 as though egma had refused the edit.
   */
  it("writes at the copy's own address, which this instance rewrites", async () => {
    const rewrites = await readFile(path.join(WEB, "next.config.ts"), "utf8");
    const form = await readFile(
      path.join(WEB, "app/graders/running/edit-form.tsx"),
      "utf8",
    );

    expect(rewrites).toContain("/api/graders/:path*");
    expect(form).toContain("`/api/graders/${copy.id}`");
    expect(form).toContain('method: "PATCH"');
    expect(form).toContain('method: "DELETE"');
  });

  /**
   * **The edit form is the Use form's controls.** What a grader asks for is the
   * library entry's own declaration, and both forms render that one list
   * through one component — so this file names no measure and no bound, and a
   * parameter that learns a new kind of control learns it once. A second
   * rendering here would be a second reading of the platform's declaration,
   * drifting the first time one of them was changed.
   */
  it("draws its controls from the entry, through the form Use is drawn with", async () => {
    const form = await readFile(
      path.join(WEB, "app/graders/running/edit-form.tsx"),
      "utf8",
    );

    expect(form).toContain("EntryFields");
    expect(form).toContain('from "../use-form.tsx"');

    // Not one measure name, nor the parameter names the latency entry happens
    // to use. The comments are read past on purpose: prose explaining why the
    // list is not here is the opposite of the list being here.
    const running = form.replaceAll(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/gu, "");
    for (const named of [
      "turn_response_latency",
      "first_response_latency",
      "milliseconds",
      "latency",
      "metric",
      "bound",
    ]) {
      expect(running, `the form names ${named} itself`).not.toContain(named);
    }
  });

  /**
   * The page needs the shelf as well as the copies: what a copy's form asks for
   * is its entry's declaration, and a page holding the copies without their
   * entries would draw an edit form with no controls in it — which reads as a
   * grader that asks nothing rather than as a page still loading.
   */
  it("reads the shelf beside the copies, so a form can be drawn from an entry", async () => {
    const page = await readFile(
      path.join(WEB, "app/graders/running/page.tsx"),
      "utf8",
    );
    expect(page).toContain('fetch("/api/grader-library")');
    expect(page).toContain("library_id");
  });

  /**
   * **The delete has to say what stays, not only what stops.**
   *
   * Deleting is the off switch — there is no enable flag and no scope that
   * means nowhere — so the button removes a project's judging, and the fear it
   * raises is about the runs already read. Every verdict the copy wrote stays
   * readable because its versions outlive it, and saying so is what makes the
   * button pressable by somebody whose grader is failing every run.
   */
  it("says plainly that what a switched-off grader already judged is unchanged", () => {
    expect(copy.SWITCH_OFF.stops).toBeTruthy();
    expect(copy.SWITCH_OFF.keeps.toLowerCase()).toContain("already judged");
    expect(copy.SWITCH_OFF.done("Latency").toLowerCase()).toContain(
      "already judged",
    );
    // And what pressing it cannot be undone into, since there is no other
    // switch to put it back with.
    expect(copy.SWITCH_OFF.again).toContain("Use");
  });

  /**
   * An edit is two acts wearing one verb, and only one of them touches what a
   * verdict was decided by. Somebody who did not know that would read a
   * tightened bound as a rewriting of history.
   */
  it("says that changing a value starts a version", () => {
    expect(copy.EDIT.lead.toLowerCase()).toContain("version");
  });

  /**
   * **The claim after a save has to be the narrow one, and this is the case
   * that keeps it narrow.**
   *
   * "What has already been judged is unchanged" is true of the verdict rows and
   * false of the runs they add up to — and it was being shown at the exact
   * moment somebody had turned `required` off, which is when it was most wrong.
   * Whether a grader can fail a run is read fresh on every page, so a run that
   * failed on this one alone reads as passed from that moment.
   */
  it("claims only that no verdict was rewritten, never that nothing changed", () => {
    const saved = copy.EDIT.saved("Latency").toLowerCase();
    expect(saved).toContain("verdict");
    expect(saved).not.toContain("is unchanged");
    expect(saved).not.toContain("nothing already judged");
  });

  it("says what required means, in both positions", () => {
    expect(copy.EDIT.requiredOn).toContain("cannot pass");
    expect(copy.EDIT.requiredOff.toLowerCase()).toContain("diagnostic");
  });

  /**
   * And both positions warn about the one thing a live setting does reach: the
   * verdicts stay put, and what they add up to does not.
   */
  it("says that turning the required flag round re-counts runs already read", () => {
    for (const said of [copy.EDIT.requiredOn, copy.EDIT.requiredOff]) {
      expect(said.toLowerCase()).toContain("rewrites no verdict");
      expect(said.toLowerCase()).toContain("add up to");
    }
  });

  /**
   * The buttons are the copy file's words like every other string on this
   * screen, so the banned list above reaches them too.
   */
  it("is what the page and the form actually render", async () => {
    const page = await readFile(
      path.join(WEB, "app/graders/running/page.tsx"),
      "utf8",
    );
    const form = await readFile(
      path.join(WEB, "app/graders/running/edit-form.tsx"),
      "utf8",
    );

    expect(page).toContain("EDIT.open");
    expect(page).toContain("SWITCH_OFF.open");
    expect(form).toContain("grader-running-copy.ts");
  });
});
