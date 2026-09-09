import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApi, type TestApi } from "./support/api.ts";
import { startObjectStorage, type ObjectStorage } from "./support/object-storage.ts";
import {
  mintKey,
  readTraceOverHttp,
  replayFixture,
  signUp,
  type Customer,
} from "./support/traces.ts";
import { FIXTURE_TRACE } from "./support/fixture.ts";

/**
 * Replay captured LiveKit evidence through ingestion and compare API measures
 * with values hand-computed from fixture timestamps. Do not derive expected
 * values with the implementation under test. Focused derivation cases live in
 * packages/db/test/measures-from-spans.test.ts.
 */

const storage: ObjectStorage = await startObjectStorage("otlp-measures");

if (!storage.available) {
  process.stderr.write(
    `\nskipping the derived-measures suite — ${storage.why}\n\n`,
  );
}

let api: TestApi;
let acme: Customer;

/**
 * The one trace the capture is, as its spans name themselves — written down
 * rather than discovered, because every number below was hand-computed from
 * *this* trace's spans and would mean nothing beside another one.
 */
const FIXTURE_TRACE_ID = "b37987604bb2c7aa1c1fd44183afab8b";

/** A window comfortably containing the capture, which happened inside a minute. */
const WINDOW = {
  from: "2026-08-02T18:00:00Z",
  to: "2026-08-02T19:00:00Z",
} as const;

/**
 * Expected values from the fixture, with span starts truncated to microseconds
 * and durations retained in nanoseconds. The capture contains five human turns
 * and four spoken agent turns. Four additional native agent records have no
 * response text. They stay in the raw trace but do not become transcript turns
 * or timing samples.
 */
const HAND_COMPUTED = {
  /**
   * The root `agent_session` d949924e2d5e678d began at 1785693880281989804 ns,
   * truncated to 1785693880281989 µs. The first agent turn 0701cc09e5f3d203
   * spoke first in `agent_speaking` 71ac2d247c9b060d, which began at
   * 1785693889887763200 ns → 1785693889887763 µs.
   *
   * 1785693889887763000 − 1785693880281989000 = 9605774000 ns = 9605.774 ms.
   */
  first_response_latency: [9605.774],

  /**
   * Measure from the final user_speaking end to agent speech, skipping interrupted
   * false starts and silent tool work. Start timestamps use stored microsecond
   * precision; durations remain exact. Hand-computed differences in ns:
   *   human baac22a26a96fa9b to speech 1b8cc4d1064a766d:
   *     1785693904727004000 - 1785693902380767362 = 2346236638
   *   human c35b92a87f8121a1, speech b30dd00e322f2443 to 42b9d5797f17aa9d:
   *     1785693924924691000 - 1785693922024241600 = 2900449400
   *   human 9839f5ef664bc919, speech 45e924b089cd919f to 11a1eaca219437a9:
   *     1785693946089613000 - 1785693943023019440 = 3066593560
   * Human f88cf2a243a38318 is unanswered and contributes no sample.
   */
  turn_response_latency: [2346.236638, 2900.4494, 3066.59356],

  /**
   * Each speaking agent turn has one agent_speaking child. Raw end minus start:
   *   71ac2d247c9b060d: 1785693894451407651 - 1785693889887763200 = 4563644451 ns
   *   1b8cc4d1064a766d: 1785693913955073014 - 1785693904727004928 = 9228068086 ns
   *   42b9d5797f17aa9d: 1785693934154724323 - 1785693924924691968 = 9230032355 ns
   *   11a1eaca219437a9: 1785693950543834480 - 1785693946089613312 = 4454221168 ns
   */
  agent_speech_duration: [
    4563.644451, 9228.068086, 9230.032355, 4454.221168,
  ],

  /**
   * Sum direct llm_node child durations per spoken agent turn, converted from
   * ns to ms. Model work under the unspoken native records remains in the raw
   * trace and does not become a transcript timing sample.
   */
  llm_latency: [7371.512989, 639.814725, 645.735577, 486.650077],

  /**
   * The same for the `tts_node` children of spoken turns. Synthesis work under
   * unspoken native records remains in the raw trace and contributes no turn
   * sample: absence, not zero.
   *
   * 2623645092, 3121186037, 2590796413, 2051012582 ns.
   */
  tts_latency: [2623.645092, 3121.186037, 2590.796413, 2051.012582],
} as const;

type ReadMeasure = {
  readonly measure: string;
  readonly unit: string;
  readonly derived: boolean;
  readonly samples: readonly number[];
  readonly spanIds: readonly string[];
  readonly mean: number;
};

async function measuresOfTheCapture(): Promise<readonly ReadMeasure[]> {
  const read = await readTraceOverHttp(
    api.app,
    acme.secret,
    FIXTURE_TRACE_ID,
    WINDOW,
  );
  expect(read.statusCode).toBe(200);
  return (read.json() as { metrics?: readonly ReadMeasure[] }).metrics ?? [];
}

function measure(
  measures: readonly ReadMeasure[],
  named: string,
): ReadMeasure | undefined {
  return measures.find((one) => one.measure === named);
}

beforeAll(async () => {
  if (!storage.available) return;
  api = await createApi("otlp_derived_measures", {
    traceStore: true,
    ingestStore: storage.ingestStore,
  });
  acme = await signUp(api.app, "ada@acme.example", "Acme");
  // The fourteen flushes, byte for byte as the exporter sent them.
  const telemetrySecret = await mintKey(
    api.app,
    acme.cookie,
    "Acme production telemetry",
    acme.projectId,
  );
  await replayFixture(api, telemetrySecret);
  // The door stops at object-store durability, so the evidence is carried the
  // rest of the way here — the measures are read out of rows.
  await api.drainEvidence();
});

afterAll(async () => {
  await api?.close();
  if (storage.available) storage.stop();
});

describe.skipIf(!storage.available)("the captured LiveKit conversation, read back through the door", () => {
  it("carries exactly the five derived measures, and says they were derived", async () => {
    const measures = await measuresOfTheCapture();

    // In the catalog's own order, which is what a page lists them in.
    expect(measures.map((one) => one.measure)).toEqual([
      "first_response_latency",
      "turn_response_latency",
      "agent_speech_duration",
      "llm_latency",
      "tts_latency",
    ]);
    // Every one of them worked out from the framework's spans: this agent
    // emitted no timing span of egma's own, which is the whole reason its
    // conversations were `skipped` before.
    expect(measures.map((one) => one.derived)).toEqual([true, true, true, true, true]);
    expect(new Set(measures.map((one) => one.unit))).toEqual(
      new Set(["milliseconds"]),
    );
  });

  it("measures the first answer at the hand-computed number", async () => {
    const measured = measure(
      await measuresOfTheCapture(),
      "first_response_latency",
    );

    expect(measured?.samples).toEqual(HAND_COMPUTED.first_response_latency);
    // Citing the `agent_speaking` span the first word came out of.
    expect(measured?.spanIds).toEqual(["71ac2d247c9b060d"]);
  });

  it("measures each answered turn's wait at the hand-computed numbers", async () => {
    const measured = measure(
      await measuresOfTheCapture(),
      "turn_response_latency",
    );

    expect(measured?.samples).toEqual(HAND_COMPUTED.turn_response_latency);
    // The three speech spans that began the three spoken answers.
    expect(measured?.spanIds).toEqual([
      "1b8cc4d1064a766d",
      "42b9d5797f17aa9d",
      "11a1eaca219437a9",
    ]);
    // The mean is the number the pages lead with, rounded once in the module
    // — the average of the three waits above, to the nearest millisecond.
    expect(measured?.mean).toBe(
      Math.round(
        HAND_COMPUTED.turn_response_latency.reduce((sum, one) => sum + one, 0) /
          HAND_COMPUTED.turn_response_latency.length,
      ),
    );
  });

  it("measures each speaking turn's speech at the hand-computed numbers", async () => {
    const measured = measure(
      await measuresOfTheCapture(),
      "agent_speech_duration",
    );

    expect(measured?.samples).toEqual(HAND_COMPUTED.agent_speech_duration);
    // One sample per agent turn that spoke, citing the turn rather than the
    // speech inside it — the number is the turn's.
    expect(measured?.spanIds).toEqual([
      "0701cc09e5f3d203",
      "b2444815bd74fb3b",
      "2c8883b32dbc323c",
      "fe4af349db1e440f",
    ]);
  });

  it("sums each turn's model steps at the hand-computed numbers", async () => {
    const measured = measure(await measuresOfTheCapture(), "llm_latency");

    expect(measured?.samples).toEqual(HAND_COMPUTED.llm_latency);
    // One sample per spoken agent turn, citing the turn — the sum is the turn's
    // and no single child holds it.
    expect(measured?.spanIds).toEqual([
      "0701cc09e5f3d203",
      "b2444815bd74fb3b",
      "2c8883b32dbc323c",
      "fe4af349db1e440f",
    ]);
  });

  it("sums each speaking turn's synthesis steps, and gives the tool-only turns no sample", async () => {
    const measured = measure(await measuresOfTheCapture(), "tts_latency");

    expect(measured?.samples).toEqual(HAND_COMPUTED.tts_latency);
    // Unspoken native records are absent. A zero would measure a transcript
    // turn that never happened.
    expect(measured?.spanIds).toEqual([
      "0701cc09e5f3d203",
      "b2444815bd74fb3b",
      "2c8883b32dbc323c",
      "fe4af349db1e440f",
    ]);
  });

  it("retains every raw span while measuring only spoken turns", async () => {
    const read = await readTraceOverHttp(
      api.app,
      acme.secret,
      FIXTURE_TRACE_ID,
      WINDOW,
    );
    expect(read.statusCode).toBe(200);
    const body = read.json() as { trace?: { spanCount?: number } };

    expect(body.trace?.spanCount).toBe(FIXTURE_TRACE.spans);
  });

  /**
   * The two catalog version 8 dropped. `time_to_first_word` was defined out of
   * audio egma does not hold outside a simulation, and `persona_speech_duration`
   * measured egma's own synthetic caller rather than anything the agent did.
   * They are not measures any more, so no conversation carries either.
   */
  it("carries neither of the two measures version 8 dropped", async () => {
    const measures = await measuresOfTheCapture();

    expect(measure(measures, "time_to_first_word")).toBeUndefined();
    expect(measure(measures, "persona_speech_duration")).toBeUndefined();
  });

  /**
   * **One POV, said out loud.** Nobody conducted this conversation — it is a
   * real caller talking to a stock LiveKit agent — so the agent's own spans are
   * the only account of it there is, and there is no second series beside the
   * headline for a reader to mistake for one.
   */
  it("says every number is the agent's own POV, with no second POV beside it", async () => {
    const measures = (await measuresOfTheCapture()) as readonly (ReadMeasure & {
      readonly pov?: string;
      readonly otherPov?: unknown;
    })[];

    expect(measures.map((one) => one.pov)).toEqual([
      "agent",
      "agent",
      "agent",
      "agent",
      "agent",
    ]);
    for (const one of measures) expect(one.otherPov).toBeUndefined();
  });
});
