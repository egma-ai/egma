import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import {
  appendSpans,
  connectClickHouse,
  disconnectClickHouse,
  measureFromSpans,
  measuresFromSpans,
  readTrace,
  worstSampleOf,
  type AuthContext,
  type NewSpan,
  type TraceDetail,
} from "@egma/db";
import { newId } from "@egma/ids";
import {
  MEASURE_CATALOG,
  SPAN_DERIVED_MEASURES,
} from "@egma/simulation-contract";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createMigratedTraceStore,
  type MigratedTraceStore,
} from "./support/clickhouse.ts";

/**
 * The shared measure module: the one place a measure is worked out.
 *
 * **Through the real store, deliberately.** The claim this file exists to prove
 * is that identical spans produce identical numbers whatever conducted the
 * conversation — so the same rows are written twice, once stamped `simulation`
 * and once stamped `production`, read back through the same trace read the
 * grader and the metrics display use, and computed. A hand-built pair of trees
 * would prove the arithmetic and nothing about the two worlds converging, which
 * is the part that could actually break.
 *
 * **The not-computable path is asked per measure in the catalog**, because each
 * needs different spans to be computable and a single case would only prove the
 * one it happened to pick. A conversation that carries every measure but one
 * answers for that one and nothing else, and the loop is over the catalog rather
 * than over a list written here — so a measure added to the catalog is a measure
 * this file starts asking about.
 */

let store: MigratedTraceStore;

const acme = { organizationId: newId("org"), userId: newId("usr") };
const PROJECT = newId("prj");

const auth: AuthContext = {
  userId: acme.userId,
  organizationId: acme.organizationId,
  projectId: PROJECT,
  role: "admin",
  via: "api_key",
};

/** The minute everything here happened in, and a window that holds it. */
const WHEN = new Date("2026-05-04T12:00:00Z");
const WINDOW = {
  from: BigInt(Date.parse("2026-05-04T00:00:00Z")) * 1000n,
  to: BigInt(Date.parse("2026-05-05T00:00:00Z")) * 1000n,
};

let nextSpanId = 0;
function spanId(): string {
  nextSpanId += 1;
  return nextSpanId.toString(16).padStart(16, "0");
}

let nextTraceId = 0;
function traceId(): string {
  nextTraceId += 1;
  return nextTraceId.toString(16).padStart(32, "0");
}

function span(overrides: Partial<NewSpan> = {}): NewSpan {
  return {
    traceId: "",
    spanId: spanId(),
    parentSpanId: "",
    source: "production",
    emitter: "agent",
    environment: "default",
    startedAtMicroseconds: BigInt(WHEN.getTime()) * 1000n,
    durationNanoseconds: 1_000_000_000n,
    name: "agent_session",
    kind: "root",
    status: "unset",
    text: "",
    audioUrl: "",
    toolName: "",
    toolArguments: "",
    toolResult: "",
    providerCallId: "room-1",
    connectionType: "livekit",
    audioSampleRateHz: 0,
    audioEncoding: "",
    runId: "",
    agentId: "",
    agentVersionId: "",
    testVersionId: "",
    personaVersionId: "",
    payload: "{}",
    ...overrides,
  };
}

/** What one conversation measured, said the way the catalog names it. */
type Measured = Readonly<Record<string, readonly number[]>>;

/**
 * One conversation as spans: a root, two turns, and a timing span per sample.
 *
 * The measurements hang off the root, which is where the simulator puts them,
 * and each one's **duration is its number** — nothing carries the value a second
 * time, exactly as the span vocabulary pins it.
 */
function aConversation(
  measured: Measured,
  stamped: Partial<NewSpan> = {},
): { readonly traceId: string; readonly spans: readonly NewSpan[] } {
  const id = traceId();
  const root = spanId();
  const at = BigInt(WHEN.getTime()) * 1000n;

  const spans: NewSpan[] = [
    span({ ...stamped, traceId: id, spanId: root }),
    span({
      ...stamped,
      traceId: id,
      spanId: spanId(),
      parentSpanId: root,
      name: "user_turn",
      kind: "turn:human",
      text: "Can you move my cleaning to Tuesday?",
      startedAtMicroseconds: at + 1_000_000n,
    }),
    span({
      ...stamped,
      traceId: id,
      spanId: spanId(),
      parentSpanId: root,
      name: "agent_turn",
      kind: "turn:agent",
      text: "Booked for Tuesday at four.",
      startedAtMicroseconds: at + 3_000_000n,
    }),
  ];

  let taken = 0n;
  for (const [measure, samples] of Object.entries(measured)) {
    for (const milliseconds of samples) {
      taken += 500_000n;
      spans.push(
        span({
          ...stamped,
          traceId: id,
          spanId: spanId(),
          parentSpanId: root,
          // A timing span is named for the measure it takes, and the ingest door
          // files every one of them as `timing`.
          name: measure,
          kind: "timing",
          startedAtMicroseconds: at + taken,
          durationNanoseconds: BigInt(Math.round(milliseconds * 1_000_000)),
        }),
      );
    }
  }

  return { traceId: id, spans };
}

/** One conversation, stored and read back exactly as a grader reads one. */
async function stored(
  measured: Measured,
  stamped: Partial<NewSpan> = {},
): Promise<TraceDetail> {
  const conversation = aConversation(measured, stamped);
  await appendSpans(auth, conversation.spans);
  const read = await readTrace(auth, conversation.traceId, { window: WINDOW });
  if (read === undefined) throw new Error("the trace store lost the spans");
  return read;
}

/** Everything a simulation's spans carry, which a production span does not. */
const AS_A_SIMULATION: Partial<NewSpan> = {
  source: "simulation",
  emitter: "egma-runtime",
  connectionType: "",
  runId: newId("run"),
  agentId: newId("agt"),
};

beforeAll(async () => {
  store = await createMigratedTraceStore("measures_from_spans");
  connectClickHouse({ clickhouseUrl: store.url, maxOpenConnections: 4 });
});

afterAll(async () => {
  await disconnectClickHouse();
  await store.drop();
});

describe("one conversation's measures", () => {
  it("reads a timing span's own duration as the number, to the half millisecond", async () => {
    const trace = await stored({
      first_response_latency: [1_214],
      turn_response_latency: [862.5, 1_100],
    });

    expect(measuresFromSpans(trace)).toEqual([
      {
        measure: "first_response_latency",
        unit: "milliseconds",
        samples: [1_214],
        spanIds: [expect.any(String)],
      },
      {
        measure: "turn_response_latency",
        unit: "milliseconds",
        // In the order they were taken, so a per-turn series is the
        // conversation read forwards — and the half is still here, which a
        // whole-number division would have floored away.
        samples: [862.5, 1_100],
        spanIds: [expect.any(String), expect.any(String)],
      },
    ]);
  });

  it("cites the span each sample came off, so a judgment can point at one", async () => {
    const trace = await stored({ turn_response_latency: [900, 2_400] });
    const measured = measureFromSpans(trace, "turn_response_latency");
    if (measured === undefined) throw new Error("the measure went missing");

    expect(measured.spanIds).toHaveLength(2);
    expect(new Set(measured.spanIds).size).toBe(2);

    // The worst measurement, and the span it happened in — which is what a
    // bound is held against and what a verdict row cites.
    const worst = worstSampleOf(measured);
    expect(worst?.value).toBe(2_400);
    expect(worst?.spanId).toBe(measured.spanIds[1]);
  });

  it("hands them back in the catalog's order, whatever order they were taken in", async () => {
    // Written backwards on purpose: the turn latency is measured first here.
    const trace = await stored({
      turn_response_latency: [900],
      first_response_latency: [1_214],
    });

    expect(measuresFromSpans(trace).map((one) => one.measure)).toEqual([
      "first_response_latency",
      "turn_response_latency",
    ]);
  });

  /**
   * The door recognises egma's vocabulary by the emitting scope and files those
   * spans as `timing`. A provider's own span that happens to share a measure's
   * name is not a measurement, and reading the name alone would let another
   * framework's bookkeeping become a number egma judges an agent against.
   */
  it("ignores a span named for a measure that the door did not file as timing", async () => {
    const id = traceId();
    await appendSpans(auth, [
      span({ traceId: id, spanId: spanId() }),
      span({
        traceId: id,
        spanId: spanId(),
        name: "turn_response_latency",
        kind: "other",
        durationNanoseconds: 900_000_000n,
      }),
    ]);
    const trace = await readTrace(auth, id, { window: WINDOW });
    if (trace === undefined) throw new Error("the trace store lost the spans");

    expect(measuresFromSpans(trace)).toEqual([]);
  });
});

/**
 * **The claim the whole module exists for.** The same spans are filed twice —
 * once as a conversation egma conducted, once as a real caller's — and the
 * numbers come out identical, because nothing in the computation can see which
 * is which.
 */
describe("the same spans, filed as a simulation and as production", () => {
  const MEASURED: Measured = {
    first_response_latency: [1_214],
    turn_response_latency: [862.5, 1_100, 2_400],
    time_to_first_word: [310.25],
  };

  it("produce identical numbers", async () => {
    const simulated = await stored(MEASURED, AS_A_SIMULATION);
    const production = await stored(MEASURED);

    // The two traces are different conversations — different ids, different
    // sources, different emitters — and the measures are the same list.
    expect(simulated.source).toBe("simulation");
    expect(production.source).toBe("production");
    expect(simulated.traceId).not.toBe(production.traceId);

    const withoutTheirSpans = (
      trace: TraceDetail,
    ): readonly Record<string, unknown>[] =>
      measuresFromSpans(trace).map(({ measure, unit, samples }) => ({
        measure,
        unit,
        samples,
      }));

    expect(withoutTheirSpans(simulated)).toEqual(withoutTheirSpans(production));
    expect(withoutTheirSpans(simulated)).toEqual([
      { measure: "first_response_latency", unit: "milliseconds", samples: [1_214] },
      {
        measure: "turn_response_latency",
        unit: "milliseconds",
        samples: [862.5, 1_100, 2_400],
      },
      { measure: "time_to_first_word", unit: "milliseconds", samples: [310.25] },
    ]);
  });

  it("reduce to the same worst measurement, which is what a bound is held to", async () => {
    const simulated = await stored(MEASURED, AS_A_SIMULATION);
    const production = await stored(MEASURED);

    for (const measure of SPAN_DERIVED_MEASURES) {
      const here = measureFromSpans(simulated, measure);
      const there = measureFromSpans(production, measure);
      expect(here === undefined).toBe(there === undefined);
      if (here === undefined || there === undefined) continue;
      expect(worstSampleOf(here)?.value).toBe(worstSampleOf(there)?.value);
    }
  });
});

/**
 * What a conversation that cannot produce a measure answers — asked **per
 * measure in the catalog**, because each needs different spans to be computable.
 *
 * A measure that is absent is a check that did not apply, which is `skipped` and
 * out of the score's denominator. Never a failure: an agent that answered
 * perfectly must not be marked down because a chat conversation has no audio, or
 * because its framework emits no timings.
 */
describe("a conversation a measure cannot be computed for", () => {
  for (const cataloged of MEASURE_CATALOG) {
    it(`answers nothing for ${cataloged.measure} when its spans are not there`, async () => {
      // Everything **except** this one, so the case is about this measure and
      // not about a conversation that measured nothing at all.
      const everythingElse: Record<string, readonly number[]> = {};
      for (const other of SPAN_DERIVED_MEASURES) {
        if (other !== cataloged.measure) everythingElse[other] = [900];
      }

      const trace = await stored(everythingElse);

      expect(measureFromSpans(trace, cataloged.measure)).toBeUndefined();
      expect(
        measuresFromSpans(trace).map((one) => one.measure),
      ).not.toContain(cataloged.measure);
      // And every other measure is still there, so the absence is this
      // measure's rather than a reading that fell over.
      expect(measuresFromSpans(trace)).toHaveLength(
        Object.keys(everythingElse).length,
      );
    });
  }

  it("answers nothing at all for a conversation with no timing spans", async () => {
    const trace = await stored({});
    expect(measuresFromSpans(trace)).toEqual([]);
    for (const measure of SPAN_DERIVED_MEASURES) {
      expect(measureFromSpans(trace, measure)).toBeUndefined();
    }
  });

  /**
   * A measure the catalog says no span carries is never computed, **even where
   * something has emitted a span by that name**. The number arrives on the
   * terminal transition and lives on the simulation row; deriving a second one
   * here would be two answers about one conversation, which is exactly what one
   * shared module exists to prevent. The write door refuses a grader naming one,
   * so this is the belt to that brace.
   */
  it("never computes a measure the catalog says no span carries", async () => {
    const notFromSpans = MEASURE_CATALOG.filter(
      (each) => each.fromSpans.rule === "no_span_carries_it",
    );
    expect(notFromSpans.length).toBeGreaterThan(0);

    const named: Record<string, readonly number[]> = {};
    for (const each of notFromSpans) named[each.measure] = [4];

    const trace = await stored(named);

    expect(measuresFromSpans(trace)).toEqual([]);
    for (const each of notFromSpans) {
      expect(measureFromSpans(trace, each.measure)).toBeUndefined();
    }
  });
});

/**
 * **One computation path, asserted rather than believed.**
 *
 * Everything above proves this module computes the right numbers. What it
 * cannot prove is that nothing *else* computes them too — and a second reader
 * is precisely the failure the module exists to prevent: two answers about one
 * conversation, with no stored number to settle the disagreement, so a page and
 * a verdict row can quietly come to disagree about how fast an agent answered.
 *
 * The whole vocabulary of a measurement is the span kind the ingest door files
 * a timing span under. Two places in egma's source may name it, for two
 * different reasons, and a third is a drift alarm rather than a style
 * preference: whoever adds one has to come here and say why.
 */
describe("the only place a measure is computed", () => {
  const REPOSITORY = path.resolve(import.meta.dirname, "..", "..", "..");

  /**
   * The two files allowed to name the timing kind.
   *
   * - The **ingest door** writes it: a span arriving under egma's own emitting
   *   scope, named for a measure the catalog says comes off a span, is filed as
   *   `timing`. That is the one place the word is produced.
   * - This **module** reads it, and is the one place a measurement becomes a
   *   number.
   */
  const MAY_NAME_THE_TIMING_KIND = [
    "apps/api/src/otlp/normalise.ts",
    "packages/db/src/measures/from-spans.ts",
  ];

  async function everySourceFile(): Promise<readonly string[]> {
    const found: string[] = [];

    const walk = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name === "dist") continue;
        const here = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          // Tests may say anything: what is being guarded is what egma runs.
          if (entry.name === "test" || entry.name === "tests") continue;
          await walk(here);
          continue;
        }
        if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
          found.push(here);
        }
      }
    };

    for (const root of ["apps", "packages"]) {
      await walk(path.join(REPOSITORY, root));
    }
    return found;
  }

  it("is the only source file that reads a timing span, and the door is the only one that writes one", async () => {
    const naming: string[] = [];
    for (const file of await everySourceFile()) {
      const source = await readFile(file, "utf8");
      if (!/(["'])timing\1/u.test(source)) continue;
      naming.push(path.relative(REPOSITORY, file).replaceAll(path.sep, "/"));
    }

    // A guard on the reading itself: a scan finding nothing would make this
    // assertion pass by looking in the wrong place.
    expect(naming.length).toBeGreaterThan(0);
    expect(naming.sort()).toEqual([...MAY_NAME_THE_TIMING_KIND].sort());
  });

  /**
   * And the conversion itself lives here alone. Nanoseconds on the wire,
   * milliseconds in the catalog: a second division somewhere else is a second
   * opinion about what a measurement is, and the half-millisecond that a
   * whole-number division floors away is exactly the kind of disagreement
   * nobody notices until a bound is argued about.
   */
  it("holds the only nanosecond-to-millisecond conversion a measure goes through", async () => {
    const source = await readFile(
      path.join(REPOSITORY, "packages/db/src/measures/from-spans.ts"),
      "utf8",
    );
    expect(source).toContain("NANOSECONDS_PER_MILLISECOND");
    expect(
      [...source.matchAll(/NANOSECONDS_PER_MILLISECOND/gu)],
      "the conversion is declared once and used once",
    ).toHaveLength(2);
  });
});
