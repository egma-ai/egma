import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { traceIdOfSimulation } from "../src/trace-identity.ts";

/**
 * The derivation, held to the document that promises it.
 *
 * `span-vocabulary.md` states one worked example — a simulation id and the
 * trace id it is, "always" — and this is that sentence executed. The fixtures
 * are the same promise as bytes, so every one of them is checked through this
 * export too: a fixture the emitter wrote and a trace id the platform derives
 * have to be the same 32 characters, or a verdict and its evidence would file
 * under two different traces and neither side would notice.
 *
 * `span-fixtures.test.ts` beside this file checks the fixtures against its own
 * independent implementation of the same derivation, and deliberately does not
 * import this one — two implementations that must agree is what catches a
 * change to either. This file is the other half: the export, held to the
 * document and to the fixtures.
 */

const packageRoot = fileURLToPath(new URL("..", import.meta.url));

const document = await readFile(
  path.join(packageRoot, "span-vocabulary.md"),
  "utf8",
);

/** The worked example the vocabulary document carries, read out of it. */
const WORKED_EXAMPLE = {
  simulationId: "sim_01K3XQ7M4E8YB2FVN0H9TZQWER",
  traceId: "0198fb73d08e479627eea08a75fbf1d8",
} as const;

describe("the trace a simulation's spans belong to", () => {
  it("is the worked example the vocabulary document writes down", () => {
    // The document is the contract; if this pair ever changes there, it changes
    // here in the same edit or the two stop meaning the same thing.
    expect(document).toContain(WORKED_EXAMPLE.simulationId);
    expect(document).toContain(WORKED_EXAMPLE.traceId);
    expect(traceIdOfSimulation(WORKED_EXAMPLE.simulationId)).toBe(
      WORKED_EXAMPLE.traceId,
    );
  });

  it("is 32 lowercase hex characters, which is what a trace id is on the wire", () => {
    expect(traceIdOfSimulation("sim_01K3XQ7M4E8YB2FVN0H9TZQWER")).toMatch(
      /^[0-9a-f]{32}$/,
    );
    // Leading zeros are kept rather than trimmed: a trace id is a fixed width,
    // and a short one names no trace at all.
    expect(traceIdOfSimulation("sim_00000000000000000000000001")).toBe(
      "0".repeat(31) + "1",
    );
  });

  it("answers the same thing every time, and something different for every id", () => {
    const ids = [
      "sim_01K3XQ7M4E8YB2FVN0H9TZQWER",
      "sim_01K3XQ7M4E8YB2FVN0H9TZQWES",
      "sim_01K3XQ7M4E8YB2FVN0H9TZQWET",
    ];
    const derived = ids.map(traceIdOfSimulation);
    expect(derived).toEqual(ids.map(traceIdOfSimulation));
    expect(new Set(derived).size).toBe(ids.length);
  });

  it("names no trace for a string that is not one of egma's simulation ids", () => {
    // Not a refusal a caller has to catch: the platform mints every simulation
    // id it reads, so this is unreachable there — and answering `undefined`
    // rather than a made-up trace is what keeps it that way.
    expect(traceIdOfSimulation("sim_not-crockford-at-all")).toBeUndefined();
    expect(traceIdOfSimulation("run_01K3XQ7M4E8YB2FVN0H9TZQWER")).toBeUndefined();
    expect(traceIdOfSimulation("01K3XQ7M4E8YB2FVN0H9TZQWER")).toBeUndefined();
    expect(traceIdOfSimulation("")).toBeUndefined();
    // Twenty-six Crockford characters hold 130 bits and a trace id holds 128.
    // egma's own ids never reach the top two — a UUIDv7's millisecond field
    // does not — and one that somehow did would be truncated into somebody
    // else's trace.
    expect(traceIdOfSimulation("sim_ZZZZZZZZZZZZZZZZZZZZZZZZZZ")).toBeUndefined();
  });

  it("agrees with every golden fixture, which is what the emitter actually sends", async () => {
    const directory = path.join(packageRoot, "fixtures", "spans", "valid");
    const names = (await readdir(directory)).filter((name) =>
      name.endsWith(".json"),
    );
    expect(names.length).toBeGreaterThan(0);

    for (const name of names) {
      const fixture = JSON.parse(
        await readFile(path.join(directory, name), "utf8"),
      ) as {
        resourceSpans: readonly {
          resource?: {
            attributes?: readonly {
              key: string;
              value?: { stringValue?: string };
            }[];
          };
          scopeSpans?: readonly { spans?: readonly { traceId?: string }[] }[];
        }[];
      };

      for (const resource of fixture.resourceSpans) {
        const simulationId = resource.resource?.attributes?.find(
          (attribute) => attribute.key === "egma.simulation_id",
        )?.value?.stringValue;
        expect(simulationId, name).toBeDefined();
        const traceId = traceIdOfSimulation(simulationId as string);
        for (const scopeSpans of resource.scopeSpans ?? []) {
          for (const span of scopeSpans.spans ?? []) {
            expect(span.traceId, `${name} ${simulationId as string}`).toBe(
              traceId,
            );
          }
        }
      }
    }
  });
});
