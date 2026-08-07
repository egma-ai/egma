import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  catalogedMeasure,
  isCatalogedMeasure,
  measureAccepts,
  CATALOGED_MEASURES,
  MEASURE_AGGREGATIONS,
  MEASURE_CATALOG,
  MEASURE_CATALOG_DOCUMENT,
  MEASURE_CATALOG_VERSION,
} from "../src/measures.ts";

/**
 * The measure catalog, held to the three things it exists to be.
 *
 * **Versioned**, so that neither side can change what a measure means quietly.
 * **Complete**, so that a threshold grader names a measure the simulator
 * actually emits — which is checked here against the simulator's own Python
 * rather than against a list somebody kept up to date by hand. And **readable**,
 * so that the document a refusal points somebody at says the same thing the
 * constant does.
 *
 * The document and the constant are two halves of one contract, exactly as the
 * two JSON schemas beside them are two halves of another. A measure in one and
 * not the other fails here rather than surfacing months later as a grader
 * nobody noticed was silent.
 */

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const repositoryRoot = path.resolve(packageRoot, "..", "..");

const document = await readFile(
  path.join(packageRoot, "measure-catalog.md"),
  "utf8",
);

/**
 * Every measure name the simulator emits as a literal, read out of its own
 * source.
 *
 * The simulator emits timing measures by calling one of three functions with a
 * name; a measure passed through as a variable is one of those calls made
 * again from a caller that named it, so the literals are the whole vocabulary.
 * Reading them rather than listing them is what makes this a drift test: a
 * measure added in Python and not added to the catalog fails the TypeScript
 * build's test run, which is the only place the two languages meet.
 */
async function measuresTheSimulatorEmits(): Promise<readonly string[]> {
  const source = path.join(repositoryRoot, "apps", "simulator", "src");
  const emitted = new Set<string>();

  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const here = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(here);
        continue;
      }
      if (!entry.name.endsWith(".py")) continue;
      const python = await readFile(here, "utf8");
      for (const [, measure] of python.matchAll(
        /\b(?:timing|_measure|on_timing)\(\s*"([a-z_]+)"/g,
      )) {
        if (measure !== undefined) emitted.add(measure);
      }
    }
  };

  await walk(source);
  return [...emitted].sort();
}

describe("the catalog as a versioned contract", () => {
  it("declares its version in the document and in the constant, identically", () => {
    expect(MEASURE_CATALOG_VERSION).toBeGreaterThanOrEqual(1);
    expect(document).toContain(`**Catalog version: ${MEASURE_CATALOG_VERSION}**`);
  });

  it("names where it lives, so a refusal can point somebody at it", async () => {
    // The path the write door's refusal prints has to be a path that exists,
    // or the refusal sends a reader somewhere there is nothing.
    await expect(
      readFile(path.join(repositoryRoot, MEASURE_CATALOG_DOCUMENT), "utf8"),
    ).resolves.toContain("The measure catalog");
  });
});

describe("what the catalog names", () => {
  it("lists every measure the simulator emits today", async () => {
    const emitted = await measuresTheSimulatorEmits();

    // A guard on the reading itself: an empty scan would make every assertion
    // below pass by finding nothing.
    expect(emitted.length).toBeGreaterThan(0);
    for (const measure of emitted) {
      expect(
        isCatalogedMeasure(measure),
        `${measure} is emitted by the simulator and is not in the catalog`,
      ).toBe(true);
    }
  });

  /**
   * Not everything in the catalog is a timing event. `turn_count` is counted
   * and the audio band is measured, and both arrive on the terminal transition
   * inside its facts — so the ones the scan cannot see are exactly the ones the
   * catalog marks as terminal facts, and nothing else.
   */
  it("names nothing beyond what the simulator emits or reports as a fact", async () => {
    const emitted = new Set(await measuresTheSimulatorEmits());

    for (const cataloged of MEASURE_CATALOG) {
      if (cataloged.origin === "timing_event") {
        expect(
          emitted.has(cataloged.measure),
          `${cataloged.measure} is cataloged as a timing event and nothing emits it`,
        ).toBe(true);
      } else {
        expect(cataloged.origin).toBe("terminal_fact");
      }
    }
  });

  it("says what every measure is, in one line a person can read", () => {
    for (const cataloged of MEASURE_CATALOG) {
      expect(cataloged.means.length).toBeGreaterThan(20);
      expect(document).toContain(`\`${cataloged.measure}\``);
    }
  });

  it("names each measure once", () => {
    expect(new Set(CATALOGED_MEASURES).size).toBe(CATALOGED_MEASURES.length);
  });

  it("answers about a measure nobody emits without inventing one", () => {
    expect(isCatalogedMeasure("time_to_resolution")).toBe(false);
    expect(catalogedMeasure("time_to_resolution")).toBeUndefined();
    expect(measureAccepts("time_to_resolution", "p90")).toBe(false);
  });
});

describe("the aggregations a threshold may ask", () => {
  it("are named in the document, every one of them", () => {
    expect(MEASURE_AGGREGATIONS.length).toBe(8);
    for (const aggregation of MEASURE_AGGREGATIONS) {
      expect(document).toContain(`\`${aggregation}\``);
    }
  });

  it("are stated per measure, so one measure can one day refuse one", () => {
    for (const cataloged of MEASURE_CATALOG) {
      expect(cataloged.aggregations.length).toBeGreaterThan(0);
      for (const aggregation of cataloged.aggregations) {
        expect(MEASURE_AGGREGATIONS).toContain(aggregation);
        expect(measureAccepts(cataloged.measure, aggregation)).toBe(true);
      }
    }
  });

  it("are all eight today, on every measure named", () => {
    for (const cataloged of MEASURE_CATALOG) {
      expect([...cataloged.aggregations].sort()).toEqual(
        [...MEASURE_AGGREGATIONS].sort(),
      );
    }
  });

  it("refuse a reduction egma does not know, whatever the measure", () => {
    expect(measureAccepts("turn_response_latency", "p42")).toBe(false);
  });
});
