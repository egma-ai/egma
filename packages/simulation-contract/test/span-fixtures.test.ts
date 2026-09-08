import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { MEASURE_CATALOG } from "@egma/metrics";

/**
 * Check span fixtures against span-vocabulary.md, including scope, resource
 * identity, span names, and attribute keys. Ingestion tests post these same
 * fixtures through the OTLP route.
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
  "tool_call",
  "provider_usage",
] as const;

/**
 * A timing span is named for the measure it takes, so the rest of the legal
 * names are the catalog's own timing measures. Derived rather than listed: a
 * measure joining the catalog joins this vocabulary in the same edit.
 */
const MEASURE_SPAN_NAMES = MEASURE_CATALOG.filter(
  (entry) => entry.origin === "timing_span",
).map((entry) => entry.measure);

const SPAN_ATTRIBUTE_KEYS = [
  "egma.turn.text",
  "egma.usage.provider",
  "egma.usage.model",
  "egma.usage.operation",
  "egma.usage.measurement",
  "egma.usage.provider_ref",
  "egma.usage.quantities",
  "egma.usage.raw",
  "egma.tool.name",
  "egma.tool.arguments",
  "egma.tool.result",
] as const;

/**
 * The SDK reports tool calls; the pinned test version identifies mock tools
 * by name. The mock-tool seam must not duplicate that record. Platforms that
 * serve mock tools themselves may still report tool_call spans.
 */
const RETIRED_TOOL_SHAPES = [
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
        if (span.name === "tool_call") {
          expect(
            attributeOf(span.attributes, "egma.tool.name"),
            fixture.name,
          ).toBeTruthy();
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
   * Reject retired mock-tool stamps. Whether a tool call was mocked is read
   * from the pinned test version, not duplicated in span attributes.
   */
  it("carry none of the stamps the seam used to write", () => {
    for (const fixture of [...valid, ...invalid]) {
      for (const span of spansOf(fixture)) {
        for (const shape of RETIRED_TOOL_SHAPES) {
          expect(
            (span.attributes ?? []).some((one) => one.key === shape),
            `${fixture.name} ${span.name} carries ${shape}`,
          ).toBe(false);
        }
      }
    }
    // And the document says why, so a reader finds the reason rather than an
    // absence they have to interpret.
    expect(document).toContain(
      "Why there is no tool span for a call Egma served itself",
    );
  });

  /**
   * The one lane that still writes a tool row, read back attribute by
   * attribute: what the platform reported, and — only for a tool the pinned
   * version covers — the answer egma itself authored.
   */
  it("read the reported flush's calls back exactly", () => {
    const flush = valid.find(
      (fixture) => fixture.name === "chat-flush-2-tools.json",
    );
    expect(flush).toBeDefined();
    const calls = spansOf(flush as Fixture)
      .filter((span) => span.name === "tool_call")
      .map((span) => ({
        name: attributeOf(span.attributes, "egma.tool.name"),
        arguments: attributeOf(span.attributes, "egma.tool.arguments"),
        result: attributeOf(span.attributes, "egma.tool.result"),
        // One instant: egma did not conduct this exchange and did not time it.
        instant: span.startTimeUnixNano === span.endTimeUnixNano,
      }));

    expect(calls).toEqual([
      {
        name: "reschedule_appointment",
        arguments:
          '{"appointment_id":"apt-88213","from":"2026-08-11T15:00:00Z","to":"2026-08-13T15:00:00Z"}',
        // A tool this simulation covers, so egma authored the answer and
        // recording it invents nothing.
        result: '{"moved":true}',
        instant: true,
      },
      {
        name: "send_confirmation_sms",
        // The platform reported the invocation and not its arguments, and an
        // absent fact stays absent.
        arguments: undefined,
        // A tool nothing covers: the real implementation ran, and its return
        // value is not egma's to claim.
        result: undefined,
        instant: true,
      },
    ]);
  });

  it("say what one provider request measured, in the unit that provider bills", () => {
    const usage = valid
      .flatMap((fixture) => spansOf(fixture))
      .filter((span) => span.name === "provider_usage");
    expect(usage.length).toBeGreaterThan(0);

    const units = new Set<string>();
    for (const span of usage) {
      // The provider, the model and the protocol are all three named: a price
      // is per model, and the same model can be reached over two protocols.
      expect(attributeOf(span.attributes, "egma.usage.provider")).toBeTruthy();
      expect(attributeOf(span.attributes, "egma.usage.model")).toBeTruthy();
      expect(attributeOf(span.attributes, "egma.usage.operation")).toBeTruthy();
      // Whether the number is the provider's own or Egma's count of what it
      // sent. The two are different facts and the record keeps which.
      expect(
        ["provider_reported", "client_measured"].includes(
          attributeOf(span.attributes, "egma.usage.measurement") ?? "",
        ),
        `${span.spanId} says how it was measured`,
      ).toBe(true);

      const quantities = JSON.parse(
        attributeOf(span.attributes, "egma.usage.quantities") ?? "null",
      ) as Record<string, number> | null;
      expect(quantities, `${span.spanId} measured something`).toBeTypeOf(
        "object",
      );
      const measured = Object.entries(quantities ?? {});
      expect(measured.length).toBeGreaterThan(0);
      for (const [type, quantity] of measured) {
        expect(quantity, `${span.spanId} ${type}`).toBeTypeOf("number");
        units.add(type);
      }

      // The record's occurrence is the span's own instant, so the span is the
      // moment the provider answered rather than an interval.
      expect(span.endTimeUnixNano).toBe(span.startTimeUnixNano);

      // A provider-reported quantity carries the provider's own object; a
      // client-measured one has none, because the provider said nothing.
      const raw = attributeOf(span.attributes, "egma.usage.raw");
      if (
        attributeOf(span.attributes, "egma.usage.measurement") ===
        "provider_reported"
      ) {
        expect(raw, `${span.spanId} keeps the provider's usage object`).toBeTypeOf(
          "string",
        );
      }
    }

    // All three legs are shown, so the fixtures cover the three units a
    // provider bills Egma in rather than only the one that is easiest.
    expect(units).toContain("input_tokens");
    expect(units).toContain("audio_seconds");
    expect(units).toContain("characters");
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
