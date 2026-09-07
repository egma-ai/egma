import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Filesystem guards against duplicate metric computation outside @egma/metrics:
 * timing-span selection, conversion to milliseconds, and series reduction.
 * Run without stores so missing containers cannot skip these guards.
 */

const REPOSITORY = path.resolve(import.meta.dirname, "..", "..", "..");

/** The module every one of these rules exists to keep alone. */
const THE_MODULE = "packages/metrics/src/from-spans.ts";

/**
 * The page that prints a reduction it was handed, named once.
 *
 * It moved into the project with the monitoring surface — it used to answer at
 * `app/traces/[traceId]` — and it is named twice below, so it is written once
 * here. Two names for one page is how one of them goes stale: the walk-reaches-
 * the-source guard would keep failing on a path nobody serves any more, while
 * the rule that matters quietly stopped covering the page it is about.
 */
const THE_TRANSCRIPT_PAGE =
  "apps/web/app/projects/[projectId]/monitoring/transcripts/[transcriptId]/page.tsx";

/**
 * Every file egma actually runs.
 *
 * Tests may say anything — a fixture builder writes timing spans by name, and
 * should — so what is scanned is source. `dist` is the same source compiled and
 * would double every finding.
 */
async function everySourceFile(): Promise<readonly string[]> {
  const found: string[] = [];

  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      const here = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "test" || entry.name === "tests") continue;
        await walk(here);
        continue;
      }
      if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
        found.push(path.relative(REPOSITORY, here).replaceAll(path.sep, "/"));
      }
    }
  };

  for (const root of ["apps", "packages"]) {
    await walk(path.join(REPOSITORY, root));
  }
  return found;
}

/**
 * Strip block comments and standalone line comments before scanning code.
 * Keep inline // text so URLs inside strings remain intact.
 */
function theCodeIn(source: string): string {
  return source
    .replaceAll(/\/\*[\s\S]*?\*\//gu, " ")
    .replaceAll(/^[ \t]*\/\/[^\n]*/gmu, " ");
}

/** Every source file whose code matches, in repository-relative form. */
async function filesMatching(pattern: RegExp): Promise<readonly string[]> {
  const naming: string[] = [];
  for (const file of await everySourceFile()) {
    const source = await readFile(path.join(REPOSITORY, file), "utf8");
    if (pattern.test(theCodeIn(source))) naming.push(file);
  }
  return naming.sort();
}

describe("the scan itself", () => {
  /**
   * A guard on the guard. Every rule below is "these files and no others", and
   * a walk that found nothing would satisfy all of them by looking in the wrong
   * place — which is exactly how a drift alarm ends up green for a year.
   */
  it("reaches the source it claims to read", async () => {
    const files = await everySourceFile();

    expect(files.length).toBeGreaterThan(100);
    expect(files).toContain(THE_MODULE);
    expect(files).toContain(THE_TRANSCRIPT_PAGE);
    // And nothing from a test directory, which is allowed to say anything.
    for (const file of files) {
      expect(file).not.toMatch(/\/tests?\//u);
    }
  });
});

describe("reading a measurement", () => {
  /**
   * The two files allowed to name the span kind a measurement arrives under.
   *
   * - The **ingest door** writes it: a span arriving under egma's own emitting
   *   scope, named for a measure the catalog says comes off a span, is filed as
   *   `timing`. That is the one place the word is produced.
   * - The **module** reads it, and is the one place a measurement becomes a
   *   number.
   */
  const MAY_NAME_THE_TIMING_KIND = [
    "apps/api/src/otlp/normalise.ts",
    THE_MODULE,
  ];

  /**
   * All three quotes, and the backtick is not padding.
   *
   * The kind is a module-private constant with no export, so a second reader
   * has no way to refer to it except by writing the literal again — which makes
   * this pattern the whole doorway. A version of it that read only `"timing"`
   * and `'timing'` left the third door open, and a probe file walked through
   * it.
   */
  it("is only ever selected on by the module, and only ever written by the door", async () => {
    expect(await filesMatching(/(["'`])timing\1/u)).toEqual(
      [...MAY_NAME_THE_TIMING_KIND].sort(),
    );
  });
});

describe("turning a measurement into milliseconds", () => {
  /**
   * A **plain** million, which is the only kind that can make a millisecond
   * here. Every other million in this codebase is a `bigint` — microseconds per
   * second, a window cushion, an instant being formatted — and a `bigint`
   * division is deliberately not how a measure is converted, because a measure
   * is `862.5ms` and whole-number arithmetic floors every one of them.
   */
  const A_PLAIN_MILLION = /1_?000_?000(?!n)/u;

  /**
   * Allow transcripts.ts to format individual span durations. These timeline
   * values are not metric reductions and are not used by graders.
   */
  const A_SPAN_DURATION_FOR_DISPLAY = "apps/web/lib/transcripts.ts";

  /**
   * The other exclusion: money.
   *
   * Every amount in this product is counted in millionths of a US dollar, and
   * these two files turn that into dollars for a person to read, or a typed
   * dollar amount back into the unit the ledger holds. A million there is a
   * price, not a nanosecond, and no measure is anywhere near it. Named here for
   * the same reason as the one above: so a fourth site has to be argued for.
   */
  const MONEY_IN_MILLIONTHS_OF_A_DOLLAR = [
    "apps/web/lib/billing.ts",
    "apps/web/lib/simulation-usage.ts",
  ];

  it("happens in the module, and nowhere else that could make a measure", async () => {
    expect(await filesMatching(A_PLAIN_MILLION)).toEqual(
      [
        THE_MODULE,
        A_SPAN_DURATION_FOR_DISPLAY,
        ...MONEY_IN_MILLIONTHS_OF_A_DOLLAR,
      ].sort(),
    );
  });

  it("is declared once and used once inside the module", async () => {
    const source = await readFile(path.join(REPOSITORY, THE_MODULE), "utf8");
    expect(
      [...source.matchAll(/NANOSECONDS_PER_MILLISECOND/gu)],
      "the conversion is declared once and used once",
    ).toHaveLength(2);
  });
});

/**
 * **The reduction, which is the number a bound is actually held against.**
 *
 * This is the rule the other two cannot see. A second reducer never names the
 * timing kind and never divides by anything: it takes the series off the answer
 * and picks the biggest, which is four correct-looking lines in a browser. The
 * page held exactly those four lines, and both other rules passed the whole
 * time.
 */
describe("reducing the measurements to one number", () => {
  /**
   * Every file allowed to hold the series at all, each with what it does with
   * it. A new name here is the moment somebody has to answer "and does it
   * reduce?", which is the question this whole block exists to force.
   */
  const MAY_HOLD_THE_SERIES: Readonly<Record<string, string>> = {
    [THE_MODULE]: "builds it, and reduces it",
    "apps/api/src/http/metrics.ts":
      "sends it, beside the module's own reduction of it — for both surfaces",
    "apps/grader/src/judge/input.ts": "renders it, as words a judge reads",
    "apps/web/lib/transcripts.ts":
      "counts it, and words the reduction it was handed — for both pages",
    "packages/platform-api/src/contract/schemas.ts":
      "defines it once on the platform wire",
    "packages/platform-api/src/generated/types.gen.ts":
      "declares what arrives through the generated client",
  };

  it("is held by exactly the files that say what they do with it", async () => {
    expect(await filesMatching(/\bsamples\b/u)).toEqual(
      Object.keys(MAY_HOLD_THE_SERIES).sort(),
    );
  });

  /**
   * What a reduction looks like when somebody writes a second one: folding the
   * series, sorting it, or reaching into it by position. Counting it
   * (`samples.length`) and mapping it (`samples.map`) are not reductions and
   * are what the readers above legitimately do.
   */
  const REDUCES_THE_SERIES =
    /\bsamples\s*\.\s*(reduce|sort|toSorted)\b|\bsamples\s*\[|Math\.(max|min)\s*\(\s*\.\.\.[\w.]*samples/u;

  /**
   * Exclude the shared measure module so its reducers can be refactored.
   * No other scanned file may reduce metric series.
   */
  it("happens nowhere by hand", async () => {
    const byHand = (await filesMatching(REDUCES_THE_SERIES)).filter(
      (file) => file !== THE_MODULE,
    );
    expect(byHand).toEqual([]);
  });

  it("keeps every allowed reduction in the one module", async () => {
    expect(
      await filesMatching(/export function worstSampleOf\b/u),
    ).toEqual([THE_MODULE]);
    expect(
      await filesMatching(/export function p90Of\b/u),
    ).toEqual([THE_MODULE]);
  });

  /**
   * And a proof that the rule above is not vacuous: the exact four lines the
   * page used to hold would be caught.
   */
  it("would catch the reduction a browser is most likely to write", () => {
    const asAPageWouldWriteIt = [
      "const worst = one.samples.reduce(",
      "  (highest, sample) => (sample > highest ? sample : highest),",
      "  one.samples[0] ?? 0,",
      ");",
    ].join("\n");

    expect(REDUCES_THE_SERIES.test(asAPageWouldWriteIt)).toBe(true);
    // And is not set off by the counting and mapping the readers do.
    expect(REDUCES_THE_SERIES.test("one.samples.length === 1")).toBe(false);
    expect(
      REDUCES_THE_SERIES.test("samples.map((sample) => sample.value)"),
    ).toBe(false);
  });
});
