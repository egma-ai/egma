import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { MEASURE_CATALOG } from "@egma/metrics";

/**
 * The span fixtures, held to the vocabulary document beside them.
 *
 * These files are the meeting point between the simulator's emitter and the
 * platform's OTLP ingest: they are worked examples of the Egma vocabulary,
 * and the ingest's own suite posts these same files and asserts what lands.
 * What this suite holds is the contract itself — every fixture speaks the one
 * scope, names its simulation on the resource, uses only the span names and
 * attribute keys the document declares, and derives its trace identity from
 * the simulation id the way the document says to. A shape used in a fixture
 * and missing from the document, or the other way round, fails here rather
 * than surfacing as two sides that each believed the other.
 */

const packageRoot = fileURLToPath(new URL("..", import.meta.url));

const document = await readFile(
  path.join(packageRoot, "span-vocabulary.md"),
  "utf8",
);

/** The one scope the vocabulary rides, and the ingest's registry is gated on. */
const SCOPE = "egma-simulator";

/** How a resource names the simulation its spans are evidence of. */
const SIMULATION_ID_ATTRIBUTE = "egma.simulation_id";

/** The conversation's own span names — everything that is not a measure. */
const CONVERSATION_SPAN_NAMES = [
  "simulation",
  "recording",
  "human_turn",
  "agent_turn",
] as const;

/**
 * A timing span is named for the measure it takes, so the rest of the legal
 * names are the catalog's own timing measures. Derived rather than listed: a
 * measure joining the catalog joins this vocabulary in the same edit.
 */
const MEASURE_SPAN_NAMES = MEASURE_CATALOG.filter(
  (entry) => entry.origin === "timing_span",
).map((entry) => entry.measure);

const SPAN_ATTRIBUTE_KEYS = ["egma.turn.text"] as const;

/**
 * The tool shapes this vocabulary used to carry, and no longer may.
 *
 * A simulation's tool record is the agent's own POV of the conversation, one
 * row per call, and egma writes no tool row of its own. So a fixture naming a
 * tool span or a tool attribute would be egma claiming the tool record again —
 * which is exactly the drift the golden files exist to catch.
 */
const RETIRED_TOOL_SHAPES = [
  "tool_call",
  "egma.tool.name",
  "egma.tool.arguments",
  "egma.tool.result",
  "egma.tool.provenance",
  "egma.tool.mock_tool",
  "egma.tool.late_attached",
] as const;

const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * The derivation the document promises: the simulation id's own 128 bits as 32
 * lowercase hex characters. Implemented here independently of both sides, so a
 * fixture whose trace id drifted from its simulation id fails no matter which
 * side wrote it.
 */
function traceIdOf(simulationId: string): string {
  const body = simulationId.slice("sim_".length);
  let value = 0n;
  for (const character of body) {
    const digit = CROCKFORD_ALPHABET.indexOf(character);
    expect(digit, `${simulationId} is not Crockford base32`).toBeGreaterThan(-1);
    value = (value << 5n) | BigInt(digit);
  }
  return value.toString(16).padStart(32, "0");
}

type FixtureSpan = {
  readonly traceId?: string;
  readonly spanId?: string;
  readonly parentSpanId?: string;
  readonly name?: string;
  readonly startTimeUnixNano?: string;
  readonly endTimeUnixNano?: string;
  readonly attributes?: readonly {
    readonly key: string;
    readonly value?: {
      readonly stringValue?: string;
      readonly boolValue?: boolean;
    };
  }[];
};

type Fixture = {
  readonly name: string;
  readonly resourceSpans: readonly {
    readonly resource?: {
      readonly attributes?: readonly {
        readonly key: string;
        readonly value?: { readonly stringValue?: string };
      }[];
    };
    readonly scopeSpans?: readonly {
      readonly scope?: { readonly name?: string; readonly version?: string };
      readonly spans?: readonly FixtureSpan[];
    }[];
  }[];
};

async function fixturesUnder(expectation: "valid" | "invalid"): Promise<Fixture[]> {
  const directory = path.join(packageRoot, "fixtures", "spans", expectation);
  const names = (await readdir(directory))
    .filter((name) => name.endsWith(".json"))
    .sort();
  return Promise.all(
    names.map(async (name) => ({
      name,
      ...(JSON.parse(
        await readFile(path.join(directory, name), "utf8"),
      ) as Omit<Fixture, "name">),
    })),
  );
}

const valid = await fixturesUnder("valid");
const invalid = await fixturesUnder("invalid");

function attributeOf(
  attributes: FixtureSpan["attributes"],
  key: string,
): string | undefined {
  return attributes?.find((entry) => entry.key === key)?.value?.stringValue;
}

function spansOf(fixture: Fixture): FixtureSpan[] {
  return fixture.resourceSpans.flatMap((resource) =>
    (resource.scopeSpans ?? []).flatMap((scope) => scope.spans ?? []),
  );
}

describe("the golden span fixtures", () => {
  it("exist on both sides of the contract, so there is something to hold", () => {
    expect(valid.length).toBeGreaterThan(0);
    expect(invalid.length).toBeGreaterThan(0);
  });

  it("all ride the one scope the ingest's registry is gated on", () => {
    for (const fixture of [...valid, ...invalid]) {
      for (const resource of fixture.resourceSpans) {
        for (const scopeSpans of resource.scopeSpans ?? []) {
          expect(scopeSpans.scope?.name, fixture.name).toBe(SCOPE);
        }
      }
    }
  });

  it("name their simulation on every resource, except the refusal fixture whose whole point is not to", () => {
    for (const fixture of valid) {
      for (const resource of fixture.resourceSpans) {
        const named = attributeOf(
          resource.resource?.attributes,
          SIMULATION_ID_ATTRIBUTE,
        );
        expect(named, fixture.name).toMatch(/^sim_[0-9A-HJKMNP-TV-Z]{26}$/);
      }
    }
    for (const fixture of invalid) {
      for (const resource of fixture.resourceSpans) {
        expect(
          attributeOf(resource.resource?.attributes, SIMULATION_ID_ATTRIBUTE),
          fixture.name,
        ).toBeUndefined();
      }
    }
  });

  it("derive every trace id from the simulation id, the way the document promises", () => {
    for (const fixture of valid) {
      for (const resource of fixture.resourceSpans) {
        const simulationId = attributeOf(
          resource.resource?.attributes,
          SIMULATION_ID_ATTRIBUTE,
        );
        if (simulationId === undefined) continue;
        const traceId = traceIdOf(simulationId);
        for (const scopeSpans of resource.scopeSpans ?? []) {
          for (const span of scopeSpans.spans ?? []) {
            expect(span.traceId, `${fixture.name} ${span.name}`).toBe(traceId);
          }
        }
      }
    }
  });

  it("use only span names the vocabulary declares, and mint well-formed ids that repeat nowhere", () => {
    const legal = new Set<string>([...CONVERSATION_SPAN_NAMES, ...MEASURE_SPAN_NAMES]);
    const minted = new Set<string>();

    for (const fixture of valid) {
      for (const span of spansOf(fixture)) {
        expect(legal.has(span.name ?? ""), `${fixture.name} ${span.name}`).toBe(true);
        expect(span.spanId, fixture.name).toMatch(/^[0-9a-f]{16}$/);
        // Unique across the whole fixture set: the flushes of one conversation
        // are disjoint, so posting them all lands each span exactly once.
        const key = `${span.traceId}/${span.spanId}`;
        expect(minted.has(key), `${fixture.name} repeats ${key}`).toBe(false);
        minted.add(key);
        // Stamped when the span happened, as decimal nanoseconds; an interval
        // never ends before it starts.
        expect(span.startTimeUnixNano, fixture.name).toMatch(/^\d+$/);
        expect(span.endTimeUnixNano, fixture.name).toMatch(/^\d+$/);
        expect(
          BigInt(span.endTimeUnixNano ?? "0") >=
            BigInt(span.startTimeUnixNano ?? "0"),
          `${fixture.name} ${span.name}`,
        ).toBe(true);
      }
    }
  });

  it("carry the conversation on the attributes the vocabulary declares, and no others", () => {
    for (const fixture of [...valid, ...invalid]) {
      for (const span of spansOf(fixture)) {
        for (const attribute of span.attributes ?? []) {
          expect(
            (SPAN_ATTRIBUTE_KEYS as readonly string[]).includes(attribute.key),
            `${fixture.name} ${span.name} carries ${attribute.key}`,
          ).toBe(true);
        }
        if (span.name === "human_turn" || span.name === "agent_turn") {
          expect(
            attributeOf(span.attributes, "egma.turn.text"),
            `${fixture.name} ${span.name}`,
          ).toBeTypeOf("string");
        }
        if (MEASURE_SPAN_NAMES.includes(span.name ?? "")) {
          // A measure span's value is its duration; an attribute repeating the
          // number would be a second copy free to disagree.
          expect(span.attributes ?? [], `${fixture.name} ${span.name}`).toEqual([]);
        }
      }
    }
  });

  it("parent every conversation span on the root, which alone names no parent and arrives last", () => {
    for (const fixture of valid) {
      for (const span of spansOf(fixture)) {
        if (span.name === "simulation") {
          expect(span.parentSpanId, fixture.name).toBeUndefined();
        } else {
          expect(span.parentSpanId, `${fixture.name} ${span.name}`).toMatch(
            /^[0-9a-f]{16}$/,
          );
        }
      }
      // The root, where present, is the last span of its flush: when it goes
      // out, everything else of the conversation is already on the wire.
      for (const resource of fixture.resourceSpans) {
        for (const scopeSpans of resource.scopeSpans ?? []) {
          const spans = scopeSpans.spans ?? [];
          const rootAt = spans.findIndex((span) => span.name === "simulation");
          if (rootAt !== -1) expect(rootAt, fixture.name).toBe(spans.length - 1);
        }
      }
    }
  });

  /**
   * The shapes this effort retired, held out of the fixtures for good.
   *
   * egma's simulator used to author a `tool_call` span for every call it
   * served or refused. It writes none now: the tool record is the agent's own
   * POV, one row per call, and whether a mock tool answered is read by name
   * from the pinned test version's mock tools at display time. A fixture that
   * grew one of these shapes back would be two records of one call, which is
   * the disagreement the change exists to remove.
   */
  it("carry no tool span and no tool attribute, on either side of the contract", () => {
    for (const fixture of [...valid, ...invalid]) {
      for (const span of spansOf(fixture)) {
        expect(span.name, `${fixture.name} authors a ${span.name} span`).not.toBe(
          "tool_call",
        );
        for (const attribute of span.attributes ?? []) {
          expect(
            (RETIRED_TOOL_SHAPES as readonly string[]).includes(attribute.key),
            `${fixture.name} ${span.name} carries ${attribute.key}`,
          ).toBe(false);
        }
      }
    }
    // And the document says so too, so a reader finds the reason rather than
    // an absence they have to interpret.
    expect(document).toContain("Why there is no tool span here");
    for (const shape of RETIRED_TOOL_SHAPES) {
      if (shape === "tool_call") continue;
      expect(document, `span-vocabulary.md still declares ${shape}`).not.toContain(
        shape,
      );
    }
  });

  it("show a voice flush whose turns genuinely overlap, because the shape has to permit it", () => {
    const voice = valid.filter((fixture) => fixture.name.startsWith("voice-"));
    expect(voice.length).toBeGreaterThan(0);
    // Some voice flush overlaps, rather than the first one found doing: voice
    // fixtures show more than one thing, and picking by position made adding a
    // second of them a way to break this.
    const crossing = voice.some((fixture) => {
      const turns = spansOf(fixture).filter(
        (span) => span.name === "human_turn" || span.name === "agent_turn",
      );
      return turns.some((one, index) =>
        turns.some(
          (other, otherIndex) =>
            index !== otherIndex &&
            BigInt(one.startTimeUnixNano ?? "0") <
              BigInt(other.endTimeUnixNano ?? "0") &&
            BigInt(other.startTimeUnixNano ?? "0") <
              BigInt(one.endTimeUnixNano ?? "0"),
        ),
      );
    });
    expect(crossing).toBe(true);
  });

  it("are all named in the vocabulary document, which is what a person reads first", () => {
    for (const name of [...CONVERSATION_SPAN_NAMES, ...MEASURE_SPAN_NAMES]) {
      expect(document, `span-vocabulary.md names ${name}`).toContain(name);
    }
    for (const key of [SIMULATION_ID_ATTRIBUTE, ...SPAN_ATTRIBUTE_KEYS]) {
      expect(document, `span-vocabulary.md names ${key}`).toContain(key);
    }
    for (const fixture of [...valid, ...invalid]) {
      expect(document, `span-vocabulary.md names ${fixture.name}`).toContain(
        fixture.name,
      );
    }
    expect(document).toContain(SCOPE);
    // The worked example in the document is the derivation actually applied.
    expect(document).toContain("sim_01K3XQ7M4E8YB2FVN0H9TZQWER");
    expect(document).toContain(traceIdOf("sim_01K3XQ7M4E8YB2FVN0H9TZQWER"));
  });
});
