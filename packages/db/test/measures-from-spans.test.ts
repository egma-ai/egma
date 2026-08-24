import {
  appendSpans,
  connectClickHouse,
  disconnectClickHouse,
  measuresFromSpans,
  readTrace,
  reportedMeasurementsPayload,
  worstSampleOf,
  type AuthContext,
  type MeasuredFromSpans,
  type NewSpan,
  type ReportedMeasurement,
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
    agentPlatform: "livekit_agents",
    platformAgentId: "",
    platformAgentName: "",
    platformAgentVersion: "",
    connectionType: "livekit",
    runId: "",
    agentId: "",
    agentVersionId: "",
    testVersionId: "",
    personaVersionId: "",
    payload: "{}",
    endsTrace: false,
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
        // Timed by egma's own vocabulary, so it is read rather than worked out,
        // and reported by nobody.
        origin: "timed",
        reportedBy: "",
        samples: [{ value: 1_214, spanId: expect.any(String) }],
      },
      {
        measure: "turn_response_latency",
        unit: "milliseconds",
        origin: "timed",
        reportedBy: "",
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

  it("cites the span each measurement came off, so a grade can point at one", async () => {
    const trace = await stored({ turn_response_latency: [900, 2_400] });
    const measured = measureIn(trace, "turn_response_latency");
    if (measured === undefined) throw new Error("the measure went missing");

    // A measurement carries its own span, so there is no second list for an
    // index to fall out of step with.
    expect(measured.samples).toHaveLength(2);
    expect(new Set(measured.samples.map((one) => one.spanId)).size).toBe(2);

    // The worst measurement, and the span it happened in — which is what a
    // bound is held against and what a grade can cite.
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
  reported: readonly ReportedMeasurement[] = [],
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
      // A block on a framework-shaped trace, for the case that asks which of
      // the two sources wins. Empty by default, which is every other case.
      ...(reported.length === 0
        ? {}
        : { payload: payloadReporting("retell", reported) }),
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
    expect(measured?.origin).toBe("derived");
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
    expect(measured?.origin).toBe("derived");
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
    expect(measured?.origin).toBe("derived");
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
    expect(measured?.origin).toBe("timed");
    // The timed number, and not the 400 the same spans would have derived.
    expect(measured === undefined ? [] : valuesOf(measured)).toEqual([862.5]);

    // The measures it did **not** time are still derived, so precedence is per
    // measure rather than a switch that turns the whole conversation off.
    expect(measureIn(both, "agent_speech_duration")?.origin).toBe("derived");
  });
});

/* ------------------------------------------------------------------- *
 * The reported measures: what the agent platform measured about its own
 * conversation.
 * ------------------------------------------------------------------- */

/**
 * The last source in the chain, and for a managed platform the only one there
 * is.
 *
 * A Retell production trace carries no timing spans, because Retell publishes
 * no per-turn timing and the store never writes a span nobody observed. What it
 * does carry is Retell's own raw measurements, translated at the ingest door
 * into the neutral block and written on the root span's payload. These cases
 * store that payload, read it back through the same trace read a grader reads
 * through, and ask what the shared measure module makes of it.
 *
 * **Deliberately without turn spans of any kind.** What a zero-width turn
 * derives is a separate question with its own fix, and a case here that leaned
 * on it would be proving two things at once and failing for either.
 */

/** Where the block rides, in the payload's own words rather than a constant's.
 * A rename then has to be a deliberate change in two places, which is what a
 * wire shape deserves. */
function payloadReporting(
  reportedBy: string,
  measurements: readonly ReportedMeasurement[],
): string {
  return JSON.stringify({
    call_id: "call_c0ffee",
    egma_normalised: {
      degraded: false,
      // Built by the contract's own writer, so the block's inner casing is the
      // normalizers' and cannot drift from what the reader parses.
      reported_measurements: reportedMeasurementsPayload(
        reportedBy,
        measurements,
      ),
    },
  });
}

/**
 * A trace as a managed platform filed it: one root span carrying the block, and
 * nothing else unless a case asks for it.
 *
 * The root's kind is the platform normalizer's own — `conversation`, not
 * `root` — which is exactly why the read finds the block by the parent nobody
 * named rather than by a kind.
 */
async function aReportedTrace(
  measurements: readonly ReportedMeasurement[],
  timed: Measured = {},
  reportedBy = "retell",
  customer: AuthContext = auth,
  id: string = traceId(),
): Promise<TraceDetail> {
  const root = spanId();
  const at = BigInt(WHEN.getTime()) * 1000n;

  const spans: NewSpan[] = [
    span({
      traceId: id,
      spanId: root,
      parentSpanId: "",
      name: "retell_call",
      kind: "conversation",
      connectionType: "retell",
      providerCallId: "call_c0ffee",
      startedAtMicroseconds: at,
      durationNanoseconds: 42_000_000_000n,
      payload: payloadReporting(reportedBy, measurements),
    }),
  ];

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

  await appendSpans(customer, spans);
  const read = await readTrace(customer, id, { window: WINDOW });
  if (read === undefined) throw new Error("the trace store lost the spans");
  return read;
}

/** The live proof's own numbers: one fast turn, and the 2145 ms one that is
 * over the two-second bound nothing said a word about. */
const AS_RETELL_MEASURED: readonly ReportedMeasurement[] = [
  {
    measure: "turn_response_latency",
    unit: "milliseconds",
    values: [517, 2_145],
  },
  {
    measure: "retell/llm_latency",
    unit: "milliseconds",
    values: [220, 310],
  },
];

describe("measures an agent platform reported about its own conversation", () => {
  /**
   * **The bridge, end to end.** No timing spans, no turns, nothing to derive
   * from — and the conversation still measures its response latency, because
   * the platform measured it and said so in the block.
   */
  it("reads the block off the root when the trace carries nothing else", async () => {
    const trace = await aReportedTrace(AS_RETELL_MEASURED);
    const root = trace.spans[0];

    expect(measuresFromSpans(trace)).toEqual([
      {
        measure: "turn_response_latency",
        unit: "milliseconds",
        // The platform measured, and the answer says whose measurement it is.
        origin: "reported",
        reportedBy: "retell",
        // Retell's raw series in Retell's own order, every sample citing the
        // root the block rode in on — an aggregate describes the whole
        // conversation and happened at no moment inside it.
        samples: [
          { value: 517, spanId: root?.spanId },
          { value: 2_145, spanId: root?.spanId },
        ],
      },
    ]);

    // And the worst measurement is the one the live proof found: 2145 ms,
    // which is what a two-second bound is held against.
    const measured = measureIn(trace, "turn_response_latency");
    expect(measured === undefined ? undefined : worstSampleOf(measured)).toEqual(
      { value: 2_145, spanId: root?.spanId },
    );
  });

  /**
   * A provider stage with no counterpart in the catalog keeps its
   * platform-prefixed name and stays in the block. Folding it into a catalog
   * answer would put a stage that means something else beside the numbers a
   * grader bounds; it is captured now and surfaced the day a display asks.
   */
  it("does not answer a platform-prefixed name as a measure", async () => {
    const trace = await aReportedTrace(AS_RETELL_MEASURED);

    for (const one of measuresFromSpans(trace)) {
      expect(one.measure.startsWith("retell/")).toBe(false);
    }
    expect(measureIn(trace, "retell/llm_latency")).toBeUndefined();
  });

  /**
   * **A measurement that runs backwards is not kept, exactly as the derivation
   * does not keep one.** The −2103 below is not invented: a real conversation
   * on a real Retell account reports it. Folded verbatim it could never fail a
   * bound — the worst sample decides, and a negative is never the worst — so it
   * would sit in the series holding every bound trivially, and drag every mean
   * and percentile the day a grader can ask for one.
   */
  it("drops a reported measurement that runs backwards, and keeps the rest", async () => {
    const trace = await aReportedTrace([
      {
        measure: "turn_response_latency",
        unit: "milliseconds",
        values: [-2_103, 517, 2_145],
      },
    ]);

    const measured = measureIn(trace, "turn_response_latency");
    expect(measured?.origin).toBe("reported");
    expect(measured === undefined ? [] : valuesOf(measured)).toEqual([
      517, 2_145,
    ]);
    // The bound is still held against the worst turn that really happened.
    expect(
      measured === undefined ? undefined : worstSampleOf(measured)?.value,
    ).toBe(2_145);

    // And the block itself is untouched: the writer keeps everything the
    // platform said, and the fold is what refuses what cannot be true.
    expect(trace.reported?.measurements[0]?.values).toEqual([
      -2_103, 517, 2_145,
    ]);
  });

  it("answers nothing for a measurement whose every value runs backwards", async () => {
    const trace = await aReportedTrace([
      { measure: "turn_response_latency", unit: "milliseconds", values: [-5, -1] },
    ]);

    // Absent, exactly as a measure the platform never took is — which is a
    // `skipped` check rather than a bound quietly passed by nothing.
    expect(measureIn(trace, "turn_response_latency")).toBeUndefined();
    expect(measuresFromSpans(trace)).toEqual([]);
  });

  /**
   * **A number in the wrong unit is worse than no number.** Two point one
   * four five seconds read as milliseconds is a conversation that answered
   * instantly, and a two-second bound would pass exactly the turn it exists to
   * fail. So the measurement is skipped and the measure is absent — a `skipped`
   * check rather than a false pass.
   */
  it("skips a measurement stated in a unit the catalog does not use", async () => {
    const trace = await aReportedTrace([
      { measure: "turn_response_latency", unit: "seconds", values: [2.145] },
    ]);

    expect(measureIn(trace, "turn_response_latency")).toBeUndefined();
    expect(measuresFromSpans(trace)).toEqual([]);
  });

  /**
   * **egma's own observation outranks the platform's account of itself**, by
   * the same absolute rule that puts a timed measure over a derived one. The
   * conversation below carries both, and the answer is the timed one alone —
   * never the two appended, which would file one turn's wait twice and move
   * every percentile.
   */
  it("lets a measure egma timed itself win over the one the platform reported", async () => {
    const trace = await aReportedTrace(AS_RETELL_MEASURED, {
      turn_response_latency: [862.5],
    });

    const measured = measureIn(trace, "turn_response_latency");
    expect(measured?.origin).toBe("timed");
    expect(measured?.reportedBy).toBe("");
    expect(measured === undefined ? [] : valuesOf(measured)).toEqual([862.5]);
  });

  /**
   * **Derived beats reported, exactly as timed beats both.** The trace below is
   * LiveKit-shaped — turns egma can read the geometry of — and its root also
   * carries a block naming the same measure. egma working a number out from
   * spans it can see outranks the platform's account of itself, so the answer
   * is the derived one and the block is not appended to it.
   */
  it("lets a measure egma derived win over the one the platform reported", async () => {
    const trace = await aLiveKitCall(
      [
        { who: "human", from: 0, to: 1_000 },
        { who: "agent", from: 1_100, to: 3_000, spoke: [[1_400, 3_000]] },
      ],
      {},
      [
        {
          measure: "turn_response_latency",
          unit: "milliseconds",
          values: [517, 2_145],
        },
      ],
    );

    // The block really was read — this is a precedence case, not an absence one.
    expect(trace.reported?.reportedBy).toBe("retell");

    const measured = measureIn(trace, "turn_response_latency");
    expect(measured?.origin).toBe("derived");
    expect(measured?.reportedBy).toBe("");
    // 1400 − 1000, worked out from the turns, and not the platform's series.
    expect(measured === undefined ? [] : valuesOf(measured)).toEqual([400]);
  });

  /**
   * **The block sits behind the same tenancy wall every other read does.**
   *
   * Two customers and one trace id, in one window — the only arrangement that
   * can tell a real predicate from a lucky one. Without the shared id the wrong
   * customer's read finds no rows at all and answers `undefined` for a reason
   * that has nothing to do with the block's own query. Here their read
   * succeeds on their own rows, and the question is whether somebody else's
   * block came back with it.
   */
  it("never hands one customer the block another customer's trace carries", async () => {
    const shared = traceId();

    const theirs = await aReportedTrace(
      AS_RETELL_MEASURED,
      {},
      "retell",
      elsewhere,
      shared,
    );
    expect(theirs.reported?.reportedBy).toBe("retell");

    // The same id, this customer's own rows, and no block written on them.
    const ours = await aReportedTrace([], {}, "retell", auth, shared);

    expect(ours.traceId).toBe(theirs.traceId);
    expect(ours.reported).toBeUndefined();
    expect(measuresFromSpans(ours)).toEqual([]);
  });

  /**
   * A trace whose root carries no block at all, which is nearly every trace in
   * the store. Nothing is reported, nothing is answered, and nothing throws.
   */
  it("answers nothing for a conversation whose platform reported nothing", async () => {
    const trace = await aReportedTrace([]);

    expect(trace.reported).toBeUndefined();
    expect(measuresFromSpans(trace)).toEqual([]);
  });
});

/**
 * **Simulation traffic is unchanged, at the level this module decides it.**
 *
 * A simulation carries its own timing spans and no platform reports anything
 * about it, so every number it produces comes from the first source in the
 * chain and the answer is the one this module always gave. The same claim about
 * the wire — the `derived` boolean a client integrated against — is asked where
 * the wire is, over HTTP, in the API's own suite.
 */
describe("a simulation, after the platform's numbers joined the chain", () => {
  it("answers exactly what it answered before there was a third source", async () => {
    const trace = await stored(
      {
        first_response_latency: [1_214],
        turn_response_latency: [862.5, 1_100],
      },
      AS_A_SIMULATION,
    );

    // Nothing reported anything about it, so there is no block to have read.
    expect(trace.reported).toBeUndefined();

    expect(measuresFromSpans(trace)).toEqual([
      {
        measure: "first_response_latency",
        unit: "milliseconds",
        origin: "timed",
        reportedBy: "",
        samples: [{ value: 1_214, spanId: expect.any(String) }],
      },
      {
        measure: "turn_response_latency",
        unit: "milliseconds",
        origin: "timed",
        reportedBy: "",
        samples: [
          { value: 862.5, spanId: expect.any(String) },
          { value: 1_100, spanId: expect.any(String) },
        ],
      },
    ]);
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
 * **A zero read off a turn that had no width is not a measurement**, and this is
 * the shape that made the rule necessary.
 *
 * Retell publishes no per-turn timing, so its normalizer writes placeholders and
 * says so plainly. Subtract one from the next and the answer is zero every time
 * — a series a bound cannot fail, so a production trace whose worst wait was
 * really 2145 ms held a two-second bound with "0 milliseconds at its worst" as
 * its rationale. A false pass is the exact false trust this product exists to
 * kill, and it is worse than the `skipped` a provider reporting no timing has
 * earned.
 *
 * **`turn_response_latency` is the whole of what is load-bearing below**, and
 * the empty answer is stated in full only so nothing arrives here unremarked.
 * The other two were never derivable on a Retell trace and are not evidence of
 * this rule: `first_response_latency` needs a root, and Retell's root is filed
 * as `conversation` while the module reads `root`. `agent_speech_duration` needs
 * `speaking` children, and Retell reports none, so no turn here has any.
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

/**
 * **A turn of no width is not the same thing as a turn nobody timed**, and the
 * two cases below are why the rule is a pair rather than a width.
 *
 * A chat simulation has no duration to write — a typed message is one instant —
 * so every turn it files is zero nanoseconds wide at a real, distinct moment.
 * Its geometry is honestly timed and its waits are real. `apps/grader` reads
 * exactly these numbers into the evidence a judge is shown, and the rule is
 * pinned here as well so it lives beside the arithmetic it constrains.
 *
 * The stamps say `production` on these rows, as they do on every constructed
 * tree in this file, and it changes nothing: the module cannot see which world a
 * conversation came from, which is what the pair of describes above proves.
 */
describe("turns of no width at real instants", () => {
  it("measures the gaps between them, because the gaps were observed", async () => {
    const trace = await aLiveKitCall([
      { who: "human", from: 0, to: 0 },
      { who: "agent", from: 2_000, to: 2_000 },
      { who: "human", from: 4_000, to: 4_000 },
      { who: "agent", from: 6_000, to: 6_000 },
    ]);

    const measured = measureIn(trace, "turn_response_latency");
    expect(measured?.origin).toBe("derived");
    // Each human turn answered 2000 ms later, which is what the instants say
    // and what a chat simulation's evidence carries today.
    expect(measured === undefined ? [] : valuesOf(measured)).toEqual([
      2_000, 2_000,
    ]);
  });

  /**
   * **A turn stays a barrier however well it was timed.** The second caller turn
   * here has no width, and holding it out of the ordered turns would let the
   * agent's reply answer the *first* one instead — measuring 5000 ms across the
   * caller's own re-speaking, which nobody waited. Missing would have become
   * wrong, so the exclusion lives on the sample and never on the list.
   */
  it("still separates the turns around it, so no wait is measured twice over", async () => {
    const trace = await aLiveKitCall([
      { who: "human", from: 0, to: 1_000 },
      { who: "human", from: 5_000, to: 5_000 },
      { who: "agent", from: 6_000, to: 8_000, spoke: [[6_000, 8_000]] },
    ]);

    const measured = measureIn(trace, "turn_response_latency");
    // One sample, and it is the second turn's: 6000 − 5000. A second number
    // here would be the first turn measured across a wait that never happened.
    expect(measured === undefined ? [] : valuesOf(measured)).toEqual([1_000]);
  });
});
