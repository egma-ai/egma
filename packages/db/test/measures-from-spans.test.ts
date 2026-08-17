import {
  appendSpans,
  connectClickHouse,
  disconnectClickHouse,
  measuresFromSpans,
  readTrace,
  worstSampleOf,
  type AuthContext,
  type MeasuredFromSpans,
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
 *
 * **Two customers, because one proves nothing about the filter.** Every measure
 * here is computed from a trace a read handed back, and a read is where tenancy
 * is enforced — so a file with one organization in it would pass identically
 * whether the predicate existed or not. The second customer's spans sit in the
 * same store, in the same window, and are asked for by the wrong credential.
 *
 * The drift alarm that keeps this module the only one is in
 * `one-measure-path.test.ts`, deliberately apart: it is a filesystem scan and
 * has no business waiting on a container.
 */

let store: MigratedTraceStore;

const acme = { organizationId: newId("org"), userId: newId("usr") };
const globex = { organizationId: newId("org"), userId: newId("usr") };
const PROJECT = newId("prj");

function actingFor(customer: typeof acme): AuthContext {
  return {
    userId: customer.userId,
    organizationId: customer.organizationId,
    projectId: PROJECT,
    role: "admin",
    via: "api_key",
  };
}

const auth = actingFor(acme);
const elsewhere = actingFor(globex);

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
/**
 * Whether the door recognised this conversation's emitter.
 *
 * `unrecognised` files every span as `other`, which is what the door does for a
 * scope its table does not know — so nothing is derivable from the shape and a
 * case can be about egma's own timing spans and nothing else. `recognised` is
 * the ordinary LiveKit-shaped conversation, whose turns a derivation reads.
 */
type Framework = "recognised" | "unrecognised";

function aConversation(
  measured: Measured,
  stamped: Partial<NewSpan> = {},
  framework: Framework = "unrecognised",
): { readonly traceId: string; readonly spans: readonly NewSpan[] } {
  const id = traceId();
  const root = spanId();
  const at = BigInt(WHEN.getTime()) * 1000n;
  const known = framework === "recognised";

  const spans: NewSpan[] = [
    span({ ...stamped, traceId: id, spanId: root, kind: known ? "root" : "other" }),
    span({
      ...stamped,
      traceId: id,
      spanId: spanId(),
      parentSpanId: root,
      name: "user_turn",
      kind: known ? "turn:human" : "other",
      text: "Can you move my cleaning to Tuesday?",
      startedAtMicroseconds: at + 1_000_000n,
    }),
    span({
      ...stamped,
      traceId: id,
      spanId: spanId(),
      parentSpanId: root,
      name: "agent_turn",
      kind: known ? "turn:agent" : "other",
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
  customer: AuthContext = auth,
  framework: Framework = "unrecognised",
): Promise<TraceDetail> {
  const conversation = aConversation(measured, stamped, framework);
  await appendSpans(customer, conversation.spans);
  const read = await readTrace(customer, conversation.traceId, {
    window: WINDOW,
  });
  if (read === undefined) throw new Error("the trace store lost the spans");
  return read;
}

/** One measure, or nothing, the way every case here asks for one. */
function measureIn(
  trace: TraceDetail,
  measure: string,
): MeasuredFromSpans | undefined {
  return measuresFromSpans(trace).find((one) => one.measure === measure);
}

/** The numbers alone, for a case comparing two conversations' arithmetic. */
function valuesOf(measured: MeasuredFromSpans): readonly number[] {
  return measured.samples.map((sample) => sample.value);
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
        // Timed by egma's own vocabulary, so it is read rather than worked out.
        derived: false,
        samples: [{ value: 1_214, spanId: expect.any(String) }],
      },
      {
        measure: "turn_response_latency",
        unit: "milliseconds",
        derived: false,
        // In the order they were taken, so a per-turn series is the
        // conversation read forwards — and the half is still here, which a
        // whole-number division would have floored away.
        samples: [
          { value: 862.5, spanId: expect.any(String) },
          { value: 1_100, spanId: expect.any(String) },
        ],
      },
    ]);
  });

  it("cites the span each measurement came off, so a judgment can point at one", async () => {
    const trace = await stored({ turn_response_latency: [900, 2_400] });
    const measured = measureIn(trace, "turn_response_latency");
    if (measured === undefined) throw new Error("the measure went missing");

    // A measurement carries its own span, so there is no second list for an
    // index to fall out of step with.
    expect(measured.samples).toHaveLength(2);
    expect(new Set(measured.samples.map((one) => one.spanId)).size).toBe(2);

    // The worst measurement, and the span it happened in — which is what a
    // bound is held against and what a verdict row cites.
    expect(worstSampleOf(measured)).toEqual(measured.samples[1]);
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

    // The span ids differ — they are different rows of different conversations
    // — and the numbers must not, which is what this compares.
    const numbersOnly = (
      trace: TraceDetail,
    ): readonly Record<string, unknown>[] =>
      measuresFromSpans(trace).map((one) => ({
        measure: one.measure,
        unit: one.unit,
        samples: valuesOf(one),
      }));

    expect(numbersOnly(simulated)).toEqual(numbersOnly(production));
    expect(numbersOnly(simulated)).toEqual([
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
      const here = measureIn(simulated, measure);
      const there = measureIn(production, measure);
      expect(here === undefined).toBe(there === undefined);
      if (here === undefined || there === undefined) continue;
      expect(worstSampleOf(here)?.value).toBe(worstSampleOf(there)?.value);
    }
  });
});

/**
 * **Another customer's conversation, in the same store and the same window.**
 *
 * Every number in this file comes off a trace a read handed back, and a read is
 * where tenancy is enforced — so a file with one organization in it would pass
 * exactly the same whether the predicate were there or not. This is the case
 * that can tell.
 */
describe("a trace belonging to somebody else", () => {
  it("is not readable, so its measures are not computable either", async () => {
    const theirs = aConversation({ turn_response_latency: [900, 1_100] });
    await appendSpans(elsewhere, theirs.spans);

    // Their own credential finds it, so the spans really are in the store.
    const toThem = await readTrace(elsewhere, theirs.traceId, { window: WINDOW });
    expect(measuresFromSpans(toThem ?? { turns: [], spans: [] })).toHaveLength(1);

    // And the other customer's finds nothing at all — not an empty trace, not a
    // refusal that says a trace exists: nothing, exactly as an id nobody minted
    // answers. There is no trace for the module to be handed.
    expect(
      await readTrace(auth, theirs.traceId, { window: WINDOW }),
    ).toBeUndefined();
  });

  it("does not reach the measures of a conversation that is this customer's", async () => {
    const ours = await stored({ first_response_latency: [1_214] });

    expect(measuresFromSpans(ours).map((one) => one.measure)).toEqual([
      "first_response_latency",
    ]);
    expect(
      await readTrace(elsewhere, ours.traceId, { window: WINDOW }),
    ).toBeUndefined();
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

      expect(measureIn(trace, cataloged.measure)).toBeUndefined();
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
      expect(measureIn(trace, measure)).toBeUndefined();
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
      expect(measureIn(trace, each.measure)).toBeUndefined();
    }
  });
});

/* ------------------------------------------------------------------- *
 * The derived measures: a framework's own spans, read as these numbers.
 * ------------------------------------------------------------------- */

/**
 * What egma works out for a conversation that timed nothing itself.
 *
 * **Constructed trees, and the shapes are the point.** Each case here is one
 * arrangement of turns and speech that a rule has to answer the same way twice —
 * turns out of order, a turn that answered without speaking, an interruption,
 * an emitter the door did not recognise, and a conversation carrying both
 * vocabularies. The captured LiveKit trace proves the whole path in
 * `apps/api/test/otlp-derived-measures.test.ts`, against numbers hand-computed
 * from its own timestamps; what is proved here is the arithmetic itself.
 *
 * Rows are written and read back through the real store, exactly as every case
 * above is, so the derivation is asked the same question a grader asks.
 */

/** One turn of a constructed conversation, in whole milliseconds from the root. */
type Turn = {
  readonly who: "human" | "agent";
  readonly from: number;
  readonly to: number;
  /** The `speaking` children the door filed inside it, if any. */
  readonly spoke?: readonly (readonly [number, number])[];
};

const MILLISECOND = 1_000n;

/**
 * A LiveKit-shaped conversation: a root, its turns, and the speech inside them.
 *
 * Timing spans are the caller's to add, so a case can put both vocabularies on
 * one conversation and ask which wins.
 */
async function aLiveKitCall(
  turns: readonly Turn[],
  timed: Measured = {},
): Promise<TraceDetail> {
  const id = traceId();
  const root = spanId();
  const at = BigInt(WHEN.getTime()) * 1000n;
  const ends = turns.reduce((longest, turn) => Math.max(longest, turn.to), 0);

  const spans: NewSpan[] = [
    span({
      traceId: id,
      spanId: root,
      name: "agent_session",
      kind: "root",
      startedAtMicroseconds: at,
      durationNanoseconds: BigInt(ends) * 1_000_000n,
    }),
  ];

  for (const turn of turns) {
    const id_ = spanId();
    spans.push(
      span({
        traceId: id,
        spanId: id_,
        parentSpanId: root,
        name: turn.who === "human" ? "user_turn" : "agent_turn",
        kind: turn.who === "human" ? "turn:human" : "turn:agent",
        startedAtMicroseconds: at + BigInt(turn.from) * MILLISECOND,
        durationNanoseconds: BigInt(turn.to - turn.from) * 1_000_000n,
      }),
    );
    for (const [from, to] of turn.spoke ?? []) {
      spans.push(
        span({
          traceId: id,
          spanId: spanId(),
          parentSpanId: id_,
          name: turn.who === "human" ? "user_speaking" : "agent_speaking",
          kind: "speaking",
          startedAtMicroseconds: at + BigInt(from) * MILLISECOND,
          durationNanoseconds: BigInt(to - from) * 1_000_000n,
        }),
      );
    }
  }

  let taken = 0n;
  for (const [measure, samples] of Object.entries(timed)) {
    for (const milliseconds of samples) {
      taken += 100_000n;
      spans.push(
        span({
          traceId: id,
          spanId: spanId(),
          parentSpanId: root,
          name: measure,
          kind: "timing",
          startedAtMicroseconds: at + taken,
          durationNanoseconds: BigInt(Math.round(milliseconds * 1_000_000)),
        }),
      );
    }
  }

  await appendSpans(auth, spans);
  const read = await readTrace(auth, id, { window: WINDOW });
  if (read === undefined) throw new Error("the trace store lost the spans");
  return read;
}

describe("measures derived from a recognised framework's own spans", () => {
  /**
   * Two exchanges, so the series is a conversation read forwards rather than a
   * bag of numbers — the order is what makes a percentile mean anything.
   */
  it("measures every human turn's wait, in the order the turns happened", async () => {
    const trace = await aLiveKitCall([
      { who: "human", from: 0, to: 1_000 },
      { who: "agent", from: 1_100, to: 3_000, spoke: [[1_400, 3_000]] },
      { who: "human", from: 4_000, to: 5_000 },
      { who: "agent", from: 5_050, to: 7_000, spoke: [[5_600, 7_000]] },
    ]);

    const measured = measureIn(trace, "turn_response_latency");
    expect(measured?.derived).toBe(true);
    // 1400 − 1000, then 5600 − 5000: the human turn's end to the agent's first
    // word, once per human turn and in that order.
    expect(measured === undefined ? [] : valuesOf(measured)).toEqual([400, 600]);
  });

  /**
   * A turn that answered with a tool call and no speech still answered. The
   * turn's own start stands in for the first word it never said, which is the
   * only endpoint the trace holds.
   */
  it("falls back to an agent turn's own start when it never spoke", async () => {
    const trace = await aLiveKitCall([
      { who: "human", from: 0, to: 1_000 },
      { who: "agent", from: 1_250, to: 2_000 },
    ]);

    const measured = measureIn(trace, "turn_response_latency");
    expect(measured === undefined ? [] : valuesOf(measured)).toEqual([250]);
    // And a turn that never spoke has no speech duration at all — not a zero,
    // which would measure something that did not happen.
    expect(measureIn(trace, "agent_speech_duration")).toBeUndefined();
  });

  /**
   * A caller who says "hello" and then "are you there" before the agent replies
   * has taken two turns and been answered once. Counting the one reply for both
   * would file the same wait twice — the same number in the series twice over,
   * a worse worst on the page, and a bound failed by a duplicate. The first turn
   * measures nothing, because the wait it would have measured ended when the
   * caller spoke again rather than when the agent did.
   */
  it("answers only the nearest human turn when the caller spoke twice", async () => {
    const trace = await aLiveKitCall([
      { who: "human", from: 0, to: 1_000 },
      { who: "human", from: 2_000, to: 3_000 },
      { who: "agent", from: 3_200, to: 5_000, spoke: [[3_500, 5_000]] },
    ]);

    const measured = measureIn(trace, "turn_response_latency");
    // One sample, and it is the second turn's: 3500 − 3000.
    expect(measured === undefined ? [] : valuesOf(measured)).toEqual([500]);
  });

  /**
   * The agent talking over the caller is an interruption, not a fast answer.
   * The measurement runs backwards, so it is dropped — and the turns around it
   * are still measured, which is the half that matters.
   */
  it("drops a turn the agent interrupted, and keeps the ones it did not", async () => {
    const trace = await aLiveKitCall([
      { who: "human", from: 0, to: 5_000 },
      // Begins speaking two seconds before the caller stops.
      { who: "agent", from: 2_500, to: 6_000, spoke: [[3_000, 6_000]] },
      { who: "human", from: 7_000, to: 8_000 },
      { who: "agent", from: 8_100, to: 9_000, spoke: [[8_300, 9_000]] },
    ]);

    const measured = measureIn(trace, "turn_response_latency");
    expect(measured === undefined ? [] : valuesOf(measured)).toEqual([300]);
  });

  it("measures the first answer from the moment the conversation began", async () => {
    const trace = await aLiveKitCall([
      { who: "agent", from: 40, to: 4_000, spoke: [[1_500, 4_000]] },
      { who: "human", from: 5_000, to: 6_000 },
    ]);

    const measured = measureIn(trace, "first_response_latency");
    expect(measured?.derived).toBe(true);
    // The root's start to the first agent turn's first word, and taken once.
    expect(measured === undefined ? [] : valuesOf(measured)).toEqual([1_500]);
  });

  /**
   * Silence inside an answer is not speech. Two bursts with a gap between them
   * sum to what was said, which is what the turn's own duration would have got
   * wrong.
   */
  it("sums the speech inside each agent turn, once per turn that spoke", async () => {
    const trace = await aLiveKitCall([
      {
        who: "agent",
        from: 0,
        to: 5_000,
        spoke: [
          [500, 1_500],
          [3_000, 3_750],
        ],
      },
      { who: "human", from: 6_000, to: 7_000 },
      { who: "agent", from: 8_000, to: 9_000, spoke: [[8_100, 9_000]] },
    ]);

    const measured = measureIn(trace, "agent_speech_duration");
    expect(measured?.derived).toBe(true);
    expect(measured === undefined ? [] : valuesOf(measured)).toEqual([
      1_750, 900,
    ]);
    // The number is the turn's, so it cites the turn rather than one child.
    expect(measured?.samples[0]?.spanId).toBe(trace.turns[0]?.spanId);
  });

  /**
   * **The trust rule.** Recognition rides the kinds the ingest door assigns from
   * the emitting scope, and a scope it does not know is filed as `other`. A
   * framework egma has not been taught therefore derives nothing, however
   * conversation-shaped its spans look.
   */
  it("derives nothing at all from an emitter the door did not recognise", async () => {
    const trace = await stored({}, {}, auth, "unrecognised");

    expect(measuresFromSpans(trace)).toEqual([]);
  });

  /**
   * **egma's own timing vocabulary wins absolutely.** The conversation below
   * carries both — turns a derivation could read and a timing span that measured
   * the same thing — and the answer is the timed one, alone. Appending both
   * would double one turn's samples and move every percentile a grader reduces
   * by.
   */
  it("never derives a measure the conversation already timed itself", async () => {
    const turns: readonly Turn[] = [
      { who: "human", from: 0, to: 1_000 },
      { who: "agent", from: 1_100, to: 3_000, spoke: [[1_400, 3_000]] },
    ];
    const both = await aLiveKitCall(turns, { turn_response_latency: [862.5] });

    const measured = measureIn(both, "turn_response_latency");
    expect(measured?.derived).toBe(false);
    // The timed number, and not the 400 the same spans would have derived.
    expect(measured === undefined ? [] : valuesOf(measured)).toEqual([862.5]);

    // The measures it did **not** time are still derived, so precedence is per
    // measure rather than a switch that turns the whole conversation off.
    expect(measureIn(both, "agent_speech_duration")?.derived).toBe(true);
  });
});

/**
 * A Retell-shaped production trace: a `conversation` root holding the whole
 * thing's width, and turns beneath it that hold none.
 *
 * Exactly the rows `apps/api/src/retell/normalise.ts` writes. The provider
 * reports no per-turn timing, so every turn opens where the trace opened and
 * closes in the same instant, and nothing `speaking` is filed anywhere.
 */
async function aRetellTrace(
  speakers: readonly ("human" | "agent")[],
): Promise<TraceDetail> {
  const id = traceId();
  const root = spanId();
  const at = BigInt(WHEN.getTime()) * 1000n;

  const spans: NewSpan[] = [
    span({
      traceId: id,
      spanId: root,
      name: "retell_call",
      kind: "conversation",
      connectionType: "retell",
      startedAtMicroseconds: at,
      durationNanoseconds: 143_000_000_000n,
    }),
  ];

  for (const speaker of speakers) {
    spans.push(
      span({
        traceId: id,
        spanId: spanId(),
        parentSpanId: root,
        name: speaker === "human" ? "human_turn" : "agent_turn",
        kind: speaker === "human" ? "turn:human" : "turn:agent",
        connectionType: "retell",
        startedAtMicroseconds: at,
        durationNanoseconds: 0n,
      }),
    );
  }

  await appendSpans(auth, spans);
  const read = await readTrace(auth, id, { window: WINDOW });
  if (read === undefined) throw new Error("the trace store lost the spans");
  return read;
}

/**
 * **A turn nobody timed measures nothing**, and this is the shape that made the
 * rule necessary.
 *
 * Retell publishes no per-turn timing, so its normalizer writes placeholders and
 * says so plainly. Read as geometry they describe an agent that answered
 * instantly every time — a series of zeroes that holds any bound put to it, so a
 * production trace whose worst wait was really 2145 ms passed a two-second bound
 * with "0 milliseconds at its worst" as its rationale. A false pass is the exact
 * false trust this product exists to kill, and it is worse than the `skipped` a
 * provider reporting no timing has earned.
 */
describe("a production trace whose turns were never timed", () => {
  it("derives nothing at all, so every measure is absent", async () => {
    const trace = await aRetellTrace([
      "agent",
      "human",
      "agent",
      "human",
      "agent",
    ]);

    // Nothing — not a series of zeroes. A zero here would be a measurement of a
    // wait nobody observed, and an absent measure is the `skipped` grader that
    // says so, which is out of the score's denominator rather than a pass.
    expect(measuresFromSpans(trace)).toEqual([]);
    for (const measure of SPAN_DERIVED_MEASURES) {
      expect(measureIn(trace, measure)).toBeUndefined();
    }
  });
});
