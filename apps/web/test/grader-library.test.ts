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

/**
 * **Use**: the one act on this screen, and the form drawn from the entry it is
 * opened on.
 *
 * What is checked here is the property the whole arrangement exists for — that
 * this page holds **no list of measures of its own**. A dropdown typed into a
 * browser page would be a second copy of egma's measure catalog: stale the first
 * time a measure joined or left, and its first symptom a write refused for
 * offering exactly what the form offered. The options ride the entry, the write
 * door checks the catalog they were built from, and neither can drift.
 */
describe("pressing Use", () => {
  /**
   * The `fetch` itself moved into `lib/write.ts` when a second and third form
   * on this section needed the same four steps — post, read egma's own refusal
   * off the body, fall back to a sentence of its own where the body carried
   * none, and treat a thrown request as the platform being out of reach. What
   * this case is about is unchanged: the address and the verb, which is what
   * the rewrite rule beside it has to match.
   */
  it("writes the copy at the path this instance rewrites", async () => {
    const rewrites = await readFile(path.join(WEB, "next.config.ts"), "utf8");
    const form = await readFile(path.join(WEB, "app/graders/use-form.tsx"), "utf8");

    expect(rewrites).toContain("/api/graders");
    expect(form).toContain('url: "/api/graders"');
    expect(form).toContain('method: "POST"');
    expect(form).toContain("library_id");
    expect(form).toContain('from "../../lib/write.ts"');
  });

  it("draws its controls from the entry's own declaration, and names no measure", async () => {
    const form = await readFile(path.join(WEB, "app/graders/use-form.tsx"), "utf8");

    // The dropdown is whatever the entry published, rendered.
    expect(form).toContain("parameter.options");
    // And the control follows the declared kind, so what a person may type and
    // what a write will take are one decision made on the entry.
    expect(form).toContain('parameter.kind === "number"');

    // Not one measure name in the code this screen runs — nor the parameter
    // names the latency entry happens to use, which are equally the entry's
    // business. The comments are read past on purpose: prose explaining why the
    // list is not here is the opposite of the list being here.
    const running = form.replaceAll(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/gu, "");
    for (const named of [
      "turn_response_latency",
      "first_response_latency",
      "time_to_first_word",
      "milliseconds",
      "latency",
      "metric",
      "bound",
    ]) {
      expect(running, `the form names ${named} itself`).not.toContain(named);
    }
  });

  /**
   * **The form is keyed by the entry it is filling.**
   *
   * Its state is the answers to *this* entry's questions, and React keeps a
   * component's state when only its props change — so pressing Use on a second
   * entry while the first one's form was open drew the second entry's controls
   * over the first entry's answers. A measure dropdown displays its first option
   * whether or not one is chosen, so the field looked answered, and submitting
   * sent a bound with no measure for the write door to refuse.
   *
   * What the page actually does is proved in a real browser, in
   * `apps/api/test/browser.test.ts` — two presses, a submission, and a copy at
   * the end of it. This is the cheap half: the attribute that makes the two
   * forms two components rather than one wearing new props.
   */
  it("gives the form a key of its own entry, so switching starts it over", async () => {
    const page = await readFile(path.join(WEB, "app/graders/page.tsx"), "utf8");
    expect(page).toContain("key={using.id}");
  });

  /**
   * A bound arriving as `"2000"` is refused by the write door with a message
   * about types — correct, and useless to somebody who typed a perfectly good
   * number. The conversion happens at the edge that knows the control was
   * numeric.
   */
  it("sends a number as a number", async () => {
    const form = await readFile(path.join(WEB, "app/graders/use-form.tsx"), "utf8");
    expect(form).toContain("Number(typed)");
  });

  /**
   * **The unit is shown, and it stays shown.**
   *
   * It used to be the input's placeholder, which meant it disappeared the
   * instant somebody typed — exactly the moment knowing whether the figure is
   * milliseconds or turns starts to matter. It is now a sibling of the control.
   *
   * And it is only offered where exactly one parameter carries a list. Nothing
   * in an entry's declaration links a typed value to a choice, so with two lists
   * there is no honest answer; matching any filled value against any list is a
   * guess that is right until an entry declares a second one.
   */
  it("shows the chosen option's unit beside the control, not inside it", async () => {
    const form = await readFile(path.join(WEB, "app/graders/use-form.tsx"), "utf8");

    // The code, not the prose: a comment saying why the unit is *not* a
    // placeholder is the opposite of a placeholder.
    const running = form.replaceAll(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/gu, "");
    expect(running).not.toContain("placeholder");
    expect(running).toContain("{unit}");
    // One list, or none: the lookup is not a search across every parameter.
    expect(running).toContain("listed.length === 1");
  });

  /**
   * `required` is v0's only loudness switch and neither reading is obvious from
   * the flag's name, so the form says both out loud beside the control.
   */
  it("says what required means, in both positions", () => {
    expect(copy.USE.requiredOn).toContain("cannot pass");
    expect(copy.USE.requiredOff.toLowerCase()).toContain("diagnostic");
  });
});
