import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { MEASURE_CATALOG } from "../src/measures.ts";

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
  "human_turn",
  "agent_turn",
  "tool_call",
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
  "egma.tool.name",
  "egma.tool.arguments",
  "egma.tool.result",
  "egma.tool.provenance",
  "egma.tool.mock_tool",
  "egma.tool.late_attached",
] as const;

/**
 * How a recorded tool call was answered — the two things egma can honestly
 * claim about a call that reached it. `mocked` says egma itself served the
 * answer, so the result beside it is not a guess about somebody else's return.
 * `refused` says egma was asked and would not answer, so nothing ran at all.
 *
 * An absent stamp is neither of them and is the third fact: egma was not in
 * the path, and the agent's own backend ran unobserved.
 */
const TOOL_PROVENANCES = ["mocked", "refused"] as const;

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

/**
 * A flag attribute, which is a genuine OTLP boolean rather than the word
 * "true" in a string: a fact that is either so or not so should not arrive as
 * text somebody has to parse. Absent is the ordinary case and reads as `false`
 * — a stamp for the thing that did not happen would be on every span.
 */
function flagOf(attributes: FixtureSpan["attributes"], key: string): boolean {
  return attributes?.find((entry) => entry.key === key)?.value?.boolValue === true;
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

  it("read the flush's calls back exactly, attribute by attribute", () => {
    const flush = valid.find(
      (fixture) => fixture.name === "voice-mocked-tool-calls.json",
    );
    expect(flush).toBeDefined();
    const calls = spansOf(flush as Fixture)
      .filter((span) => span.name === "tool_call")
      .map((span) => ({
        name: attributeOf(span.attributes, "egma.tool.name"),
        arguments: attributeOf(span.attributes, "egma.tool.arguments"),
        result: attributeOf(span.attributes, "egma.tool.result"),
        provenance: attributeOf(span.attributes, "egma.tool.provenance"),
        mockTool: attributeOf(span.attributes, "egma.tool.mock_tool"),
        lateAttached: flagOf(span.attributes, "egma.tool.late_attached"),
      }));

    expect(calls).toEqual([
      {
        name: "check_calendar",
        arguments: '{"date":"2026-08-13","duration_minutes":30}',
        // The answer that makes the calendar full, which is a branch no real
        // backend can be asked for on demand.
        result: '{"slots":[]}',
        provenance: "mocked",
        mockTool: "check_calendar",
        lateAttached: false,
      },
      {
        name: "send_confirmation_sms",
        // Nothing arrived: this tool was not among those the agent reported
        // having, so there was no shape for the arguments to take.
        arguments: undefined,
        result: '{"delivered":true}',
        provenance: "mocked",
        mockTool: "send_confirmation_sms",
        lateAttached: true,
      },
      {
        name: "charge_card",
        // A tool this simulation answers for nothing of. The arguments
        // arrived and are kept — they are what the agent tried to do — but
        // nothing was served, so there is no result and no mock tool.
        arguments: '{"amount_cents":4200}',
        result: undefined,
        provenance: "refused",
        mockTool: undefined,
        lateAttached: false,
      },
    ]);
  });

  /**
   * The distinction this stamp exists for. A refused call and a call egma
   * never stood in the path of are opposite facts — the backend did not run,
   * versus the backend ran and egma saw only that it was called — and written
   * the same way a reader could not tell them apart.
   */
  it("tell a refused call apart from one egma was never in the path of", () => {
    const calls = valid
      .flatMap((fixture) => spansOf(fixture))
      .filter((span) => span.name === "tool_call");

    const refused = calls.filter(
      (span) =>
        attributeOf(span.attributes, "egma.tool.provenance") === "refused",
    );
    const unobserved = calls.filter(
      (span) =>
        attributeOf(span.attributes, "egma.tool.provenance") === undefined,
    );
    expect(refused.length).toBeGreaterThan(0);
    expect(unobserved.length).toBeGreaterThan(0);

    for (const span of refused) {
      // Nothing answered it, so there is nothing to record as an answer and
      // no mock tool to name — and the flag that qualifies a served call has
      // nothing here to qualify.
      expect(attributeOf(span.attributes, "egma.tool.result")).toBeUndefined();
      expect(
        attributeOf(span.attributes, "egma.tool.mock_tool"),
      ).toBeUndefined();
      expect(flagOf(span.attributes, "egma.tool.late_attached")).toBe(false);
      // The tool the agent asked for is kept: what it tried to do is the
      // whole value of a refusal being on the record.
      expect(attributeOf(span.attributes, "egma.tool.name")).toBeTruthy();
    }

    // And no unstamped call can be mistaken for one of them: the two sets do
    // not overlap, which is the property the stamp was added to create.
    for (const span of unobserved) {
      expect(
        attributeOf(span.attributes, "egma.tool.provenance"),
      ).toBeUndefined();
    }
  });

  it("show a mocked call carrying the answer egma served and the mock tool that served it", () => {
    const mocked = valid
      .flatMap((fixture) => spansOf(fixture))
      .filter(
        (span) =>
          span.name === "tool_call" &&
          attributeOf(span.attributes, "egma.tool.provenance") === "mocked" &&
          !flagOf(span.attributes, "egma.tool.late_attached"),
      );
    expect(mocked.length).toBeGreaterThan(0);

    for (const span of mocked) {
      // The answer is egma's own, so recording it invents nothing — and a
      // mocked call that recorded no answer would be a served call with the
      // served half missing.
      expect(attributeOf(span.attributes, "egma.tool.result")).toBeTypeOf(
        "string",
      );
      expect(attributeOf(span.attributes, "egma.tool.mock_tool")).toBeTruthy();
      // egma stood between the agent and the answer, so the span brackets the
      // exchange it conducted rather than being the instant an observer sees.
      expect(
        BigInt(span.endTimeUnixNano ?? "0") -
          BigInt(span.startTimeUnixNano ?? "0"),
      ).toBeGreaterThan(0n);
      // An ordinary mocked call is one whose tool the agent had reported
      // having, so its arguments arrived whole.
      expect(attributeOf(span.attributes, "egma.tool.arguments")).toBeTypeOf(
        "string",
      );
    }
  });

  it("show a late-attached call, distinguishable from an ordinary mocked call by its own flag", () => {
    const late = valid
      .flatMap((fixture) => spansOf(fixture))
      .filter((span) => flagOf(span.attributes, "egma.tool.late_attached"));
    expect(late.length).toBeGreaterThan(0);

    for (const span of late) {
      expect(span.name).toBe("tool_call");
      // Still a mocked call: the flag says which tool it was served for, never
      // that something other than a mock tool answered.
      expect(attributeOf(span.attributes, "egma.tool.provenance")).toBe(
        "mocked",
      );
      expect(attributeOf(span.attributes, "egma.tool.mock_tool")).toBeTruthy();
      expect(attributeOf(span.attributes, "egma.tool.result")).toBeTypeOf(
        "string",
      );
    }
  });

  it("stamp every recorded answer with how it was answered, so no result is of unknown origin", () => {
    for (const fixture of [...valid, ...invalid]) {
      for (const span of spansOf(fixture)) {
        const provenance = attributeOf(span.attributes, "egma.tool.provenance");
        if (attributeOf(span.attributes, "egma.tool.result") !== undefined) {
          expect(
            provenance,
            `${fixture.name} records an answer without saying who served it`,
          ).toBeTypeOf("string");
        }
        if (provenance !== undefined) {
          expect(
            (TOOL_PROVENANCES as readonly string[]).includes(provenance),
            `${fixture.name} claims provenance ${provenance}`,
          ).toBe(true);
        }
        // The two mock-shaped attributes belong to a mocked call and nowhere
        // else: naming a mock tool on a call no mock tool answered would be
        // the invented structure this vocabulary refuses.
        if (provenance === undefined) {
          expect(
            attributeOf(span.attributes, "egma.tool.mock_tool"),
            fixture.name,
          ).toBeUndefined();
          expect(flagOf(span.attributes, "egma.tool.late_attached")).toBe(false);
        }
      }
    }
  });

  it("still carry a call egma only observed, with neither answer nor stamp, so the expand breaks nobody", () => {
    const bare = valid
      .flatMap((fixture) => spansOf(fixture))
      .filter(
        (span) =>
          span.name === "tool_call" &&
          attributeOf(span.attributes, "egma.tool.provenance") === undefined,
      );
    expect(bare.length).toBeGreaterThan(0);
    for (const span of bare) {
      expect(attributeOf(span.attributes, "egma.tool.name")).toBeTruthy();
      expect(
        attributeOf(span.attributes, "egma.tool.result"),
        "an observed call cannot report a return nobody saw",
      ).toBeUndefined();
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
