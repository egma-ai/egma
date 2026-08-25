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

/**
 * A stock LiveKit agent's real conversation, measured from its own spans.
 *
 * **The proof that the derivations are worth believing.** The captured trace
 * goes in at the real door, byte for byte as the exporter sent it, lands in real
 * ClickHouse, and comes back through the same v1 read a grader and the
 * transcript page read — and the numbers it carries are compared against
 * figures **hand-computed from the capture's own raw timestamps** and written
 * down below.
 *
 * That last part is the whole design of this file. Expectations produced by
 * running the derivation would grade the derivation against itself and pass for
 * any rule at all, including a wrong one. Every number here was worked out once
 * from the fixture's nanosecond start and end times, with the spans it came from
 * named beside it, so this file disagrees with the code the day the code
 * changes what it means.
 *
 * The unit cases — ordering, the fallback, an interruption, an unrecognised
 * emitter, precedence — are in `packages/db/test/measures-from-spans.test.ts`.
 * What is proved here is that a real conversation, through the real path,
 * arrives measured.
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
 * The numbers, hand-computed from the capture's raw span timestamps.
 *
 * Starts are held to the microsecond and durations to the nanosecond, which is
 * what the store keeps, so every latency below is the difference of two
 * microsecond-truncated instants. Each line names the spans it came from by
 * their own ids.
 *
 * The conversation, in the order its turns began: an agent turn that greets,
 * then five human turns, each with one or two agent turns after it — thirteen
 * turns in all, five of them the caller's.
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
   * One sample per human turn, in order. Three of the five run backwards — the
   * agent began answering before the caller stopped — and a latency that runs
   * backwards is dropped rather than kept as a negative number.
   *
   * 1. human 1e6796c0e195e424 ends 1785693901696743226; the next agent turn
   *    9ac4333458575745 has no speech and starts 1785693899185629103. Backwards
   *    by 2511 ms — the agent talked over the caller. Dropped.
   * 2. human baac22a26a96fa9b starts 1785693902082961920 → 1785693902082961 µs,
   *    runs 297806362 ns, so it ends at 1785693902380767362. The next agent
   *    turn 00820fa943b873e6 has no speech and starts 1785693902382202784 →
   *    1785693902382202 µs. 1785693902382202000 − 1785693902380767362 =
   *    1434638 ns = 1.434638 ms.
   * 3. human c35b92a87f8121a1 ends 1785693923116446625; agent 674743df7fe60024
   *    starts 1785693922817568419. Backwards by 299 ms. Dropped.
   * 4. human f88cf2a243a38318 ends 1785693942127284137; agent cfbcc2e51885f0fa
   *    starts 1785693941270896447. Backwards by 856 ms. Dropped.
   * 5. human 9839f5ef664bc919 starts 1785693942114222080 → 1785693942114222 µs,
   *    runs 1980473194 ns, so it ends at 1785693944094695194. The next agent
   *    turn fe4af349db1e440f spoke in `agent_speaking` 11a1eaca219437a9, which
   *    began at 1785693946089613312 ns → 1785693946089613 µs.
   *    1785693946089613000 − 1785693944094695194 = 1994917806 ns =
   *    1994.917806 ms.
   */
  turn_response_latency: [1.434638, 1994.917806],

  /**
   * One sample per agent turn that spoke, and four of the eight did. Each has a
   * single `agent_speaking` child, so the sum is that child's own duration —
   * nanoseconds exactly, since a duration is stored to the nanosecond.
   *
   * - turn 0701cc09e5f3d203, speech 71ac2d247c9b060d:
   *   1785693894451407651 − 1785693889887763200 = 4563644451 ns
   * - turn b2444815bd74fb3b, speech 1b8cc4d1064a766d:
   *   1785693913955073014 − 1785693904727004928 = 9228068086 ns
   * - turn 2c8883b32dbc323c, speech 42b9d5797f17aa9d:
   *   1785693934154724323 − 1785693924924691968 = 9230032355 ns
   * - turn fe4af349db1e440f, speech 11a1eaca219437a9:
   *   1785693950543834480 − 1785693946089613312 = 4454221168 ns
   */
  agent_speech_duration: [
    4563.644451, 9228.068086, 9230.032355, 4454.221168,
  ],

  /**
   * The platform's stage latencies, per agent turn in start order: the sum of
   * each turn's own `llm_node` children (nothing else of the model family is a
   * direct child of a turn in this capture, so nothing double-counts), read
   * straight off the capture's raw span durations in nanoseconds and stated
   * here in milliseconds. Every one of the eight agent turns carried exactly
   * one model step.
   *
   * 7371512989, 727291266, 729825817, 639814725, 593974430, 645735577,
   * 989172921, 486650077 ns.
   */
  llm_latency: [
    7371.512989, 727.291266, 729.825817, 639.814725, 593.97443, 645.735577,
    989.172921, 486.650077,
  ],

  /**
   * The same for the `tts_node` children. Two turns — the two that answered
   * with a tool call and never spoke — carried no synthesis step and
   * contribute no sample: absence, not zero.
   *
   * 2623645092, 393177146, 3121186037, 2590796413, 1724987892, 2051012582 ns.
   */
  tts_latency: [
    2623.645092, 393.177146, 3121.186037, 2590.796413, 1724.987892,
    2051.012582,
  ],
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
    // The agent turn that answered without speaking, then the speech that
    // answered the last thing the caller said.
    expect(measured?.spanIds).toEqual([
      "00820fa943b873e6",
      "11a1eaca219437a9",
    ]);
    // The mean is the number the pages lead with, rounded once in the module
    // — the average of the two waits above, to the nearest millisecond.
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
    // One sample per agent turn, citing the turn — the sum is the turn's and
    // no single child holds it.
    expect(measured?.spanIds).toEqual([
      "0701cc09e5f3d203",
      "9ac4333458575745",
      "00820fa943b873e6",
      "b2444815bd74fb3b",
      "674743df7fe60024",
      "2c8883b32dbc323c",
      "cfbcc2e51885f0fa",
      "fe4af349db1e440f",
    ]);
  });

  it("sums each speaking turn's synthesis steps, and gives the tool-only turns no sample", async () => {
    const measured = measure(await measuresOfTheCapture(), "tts_latency");

    expect(measured?.samples).toEqual(HAND_COMPUTED.tts_latency);
    // The two tool-answering turns carried no synthesis step and are absent —
    // a zero would measure something that never happened.
    expect(measured?.spanIds).toEqual([
      "0701cc09e5f3d203",
      "9ac4333458575745",
      "b2444815bd74fb3b",
      "2c8883b32dbc323c",
      "cfbcc2e51885f0fa",
      "fe4af349db1e440f",
    ]);
  });

  /**
   * The two the spec leaves out deliberately. `time_to_first_word` is defined
   * out of audio egma does not hold for production traffic, and
   * `persona_speech_duration` is about egma's synthetic caller, who is not in a
   * production conversation at all. A grader naming either is honestly
   * `skipped`, which is better than a number that means something else.
   */
  it("derives neither of the two measures the catalog excludes", async () => {
    const measures = await measuresOfTheCapture();

    expect(measure(measures, "time_to_first_word")).toBeUndefined();
    expect(measure(measures, "persona_speech_duration")).toBeUndefined();
  });
});
