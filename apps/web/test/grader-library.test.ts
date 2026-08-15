import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import * as copy from "../lib/grader-library-copy.ts";
import { PRODUCT_NAVIGATION } from "../lib/presentation.ts";

/**
 * The Library screen: what it says, where it reaches, and how somebody gets to
 * it.
 *
 * The transcript pages' arrangement, applied to the second product screen. The
 * words are in one file so they can be held against the domain model's banned
 * list, and the page is held to rendering that file rather than string literals
 * of its own — a heading typed straight into the markup is a word nothing above
 * can check, which is the failure this whole arrangement exists to prevent.
 */

const WEB = path.join(import.meta.dirname, "..");

/**
 * The banned list, as the domain model writes it, for this screen.
 *
 * `evaluator`, `scorer` and `eval` are the words somebody arriving from another
 * product would type here first, which is exactly why this is the screen that
 * checks for them. `dimension` and `gate` are the redesign's own retirements —
 * the verdict store's old column name, and the word considered for the must-pass
 * flag and not chosen. `built-in` is the old name for what is now a predefined
 * grader. `metric` is banned *for scoring logic*, which this screen never
 * names: a metric measures and a grader judges, and the shelf holds graders.
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

describe("what the Library screen says out loud", () => {
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
   * The two words the schema stores are not the two words a person reads, and
   * the mapping is the screen's job rather than the API's: `llm_as_judge` is
   * the vocabulary a column is written in, and nobody should meet it.
   */
  it("turns the stored type and owner into words a person reads", () => {
    expect(copy.TYPES["llm_as_judge"]).toBeDefined();
    expect(copy.TYPES["code"]).toBeDefined();
    expect(copy.OWNERS["egma"]).toBe("egma");
    expect(copy.OWNERS["organization"]).toBeDefined();
  });

  it("is what the page actually renders", async () => {
    const page = await readFile(path.join(WEB, "app/graders/page.tsx"), "utf8");
    expect(page).toContain("grader-library-copy.ts");
  });
});

describe("getting to the Library screen", () => {
  it("is one click from anywhere signed in", () => {
    const graders = PRODUCT_NAVIGATION.find((item) => item.id === "graders");
    expect(graders?.href).toBe("/graders");
  });

  /**
   * A path the page fetches and the config does not forward would be served by
   * this process, which has no such route, and the screen would show Next's own
   * 404 as though egma had answered it.
   */
  it("reaches the API at a path this instance rewrites", async () => {
    const rewrites = await readFile(path.join(WEB, "next.config.ts"), "utf8");
    const page = await readFile(path.join(WEB, "app/graders/page.tsx"), "utf8");

    expect(rewrites).toContain("/api/grader-library");
    expect(page).toContain('fetch("/api/grader-library")');
  });

  /**
   * The three facts the shelf is read by. Owner is the one that is derived
   * rather than stored, so the page prints what the answer said and works none
   * of it out for itself.
   */
  it("shows the name, the type and the owner", async () => {
    const page = await readFile(path.join(WEB, "app/graders/page.tsx"), "utf8");

    expect(page).toContain("COLUMNS.name");
    expect(page).toContain("COLUMNS.type");
    expect(page).toContain("COLUMNS.owner");
    // Printed as the answer said it, never worked out from anything the page
    // knows: owner is the entry's own derivation and this screen only reads it.
    expect(page).toContain("OWNERS[entry.owner]");
  });

  /**
   * A slow request must not replace the application with the access-page
   * composition — the sidebar, the navigation and the account menu stay put
   * until the API has said the session is gone.
   */
  it("keeps the application shell while its data settles", async () => {
    const page = await readFile(path.join(WEB, "app/graders/page.tsx"), "utf8");
    expect(page).toContain('<AppShell active="graders">');
    expect(page).not.toMatch(/state\.status === "loading"[\s\S]*?return <StatePage/);
  });
});
