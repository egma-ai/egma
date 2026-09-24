import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { isCatalogedMeasure, MEASURE_CATALOG } from "../src/measures.ts";

/**
 * Keep simulator-emitted measure names aligned with the catalog. Read
 * simulator source rather than maintaining another list.
 */

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const repositoryRoot = path.resolve(packageRoot, "..", "..");

/**
 * Extract literal names passed to the simulator's measurement emitters.
 * This detects emitted measures missing from the shared catalog.
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
        /\b(?:measure|_measure|on_timing|timing)\(\s*"([a-z_]+)"/g,
      )) {
        if (measure !== undefined) emitted.add(measure);
      }
    }
  };

  await walk(source);
  return [...emitted].sort();
}

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
   * Not everything in the catalog is a timing span. `turn_count` arrives on
   * the terminal transition inside its facts, so the ones the scan cannot see
   * are exactly the ones the catalog marks as terminal facts, and nothing else.
   */
  it("names nothing beyond what the simulator emits or reports as a fact", async () => {
    const emitted = new Set(await measuresTheSimulatorEmits());

    for (const cataloged of MEASURE_CATALOG) {
      if (cataloged.origin === "timing_span") {
        expect(
          emitted.has(cataloged.measure),
          `${cataloged.measure} is cataloged as a timing span and nothing emits it`,
        ).toBe(true);
      } else {
        // The scan cannot see a terminal fact (it arrives on the transition,
        // not as a span) and cannot see a platform stage (only the agent's
        // own machinery holds it) — and those are exactly the two origins a
        // non-timing measure may carry. Anything else is a measure claiming
        // an arrival nothing implements.
        expect(["terminal_fact", "platform_telemetry"]).toContain(
          cataloged.origin,
        );
      }
    }
  });
});
