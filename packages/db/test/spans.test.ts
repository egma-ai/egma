import {
  appendSpans,
  connectClickHouse,
  disconnectClickHouse,
  OversizeRecordError,
  refuseOversizeRecord,
  spanContentHash,
  type AuthContext,
  type NewSpan,
} from "@egma/db";
import { newId } from "@egma/ids";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { planSpanInserts } from "../src/access/spans.ts";

import {
  createMigratedTraceStore,
  type MigratedTraceStore,
} from "./support/clickhouse.ts";

/**
 * The one way anything writes a span.
 *
 * What the ingest door's own tests cannot show is what this function does when
 * the batch is enormous or a single field is: those are storage decisions, they
 * belong to the module that owns the table, and they are the two Langfuse named
 * as real requirements rather than refinements. A transcript will reach them.
 *
 * Every storage assertion here runs against a real ClickHouse. What a repeated
 * span does to the visible row count, what a named insert does to a retry that
 * regrouped its bytes, and whether an insert of ten thousand rows arrives whole
 * are engine behaviours, and a substitute would confirm only the strings egma
 * sends. The two pure assertions — the 130-month plan and the fingerprint —
 * reach nothing and are proved as the arithmetic they are.
 */

let store: MigratedTraceStore;

const acme = {
  organizationId: newId("org"),
  projectId: newId("prj"),
  userId: newId("usr"),
};
const globex = {
  organizationId: newId("org"),
  projectId: newId("prj"),
  userId: newId("usr"),
};

function at(customer: typeof acme): AuthContext {
  return {
    userId: customer.userId,
    organizationId: customer.organizationId,
    projectId: customer.projectId,
    role: "admin",
    via: "api_key",
  };
}

/** A key minted for the whole customer, which is what naming no project means. */
function acrossTheOrganization(customer: typeof acme): AuthContext {
  return { ...at(customer), projectId: undefined };
}

/** A span with every field stated, which is what the type requires. */
function span(overrides: Partial<NewSpan> = {}): NewSpan {
  return {
    traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    spanId: "bbbbbbbbbbbbbbbb",
    parentSpanId: "",
    source: "production",
    emitter: "agent",
    environment: "default",
    startedAtMicroseconds: 1_785_693_880_281_989n,
    durationNanoseconds: 1_000_000_000n,
    name: "agent_turn",
    kind: "turn:agent",
    status: "unset",
    text: "Hello there.",
    audioUrl: "",
    toolName: "",
    toolArguments: "",
    toolResult: "",
    providerCallId: "room-1",
    agentPlatform: "livekit",
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

async function countOf(query: string): Promise<number> {
  const [row] = await store.rows<{ n: number }>(query);
  return row?.n ?? -1;
}

beforeAll(async () => {
  store = await createMigratedTraceStore("spans");
  connectClickHouse({ clickhouseUrl: store.url, maxOpenConnections: 4 });
});

afterAll(async () => {
  await disconnectClickHouse();
  await store.drop();
});

describe("the customer a span belongs to", () => {
  it("comes from the context and cannot be passed in, because there is nowhere to pass it", async () => {
    const traceId = "1111111111111111111111111111aaaa";
    await appendSpans(at(acme), [span({ traceId, spanId: "1111111111111111" })]);
    await appendSpans(at(globex), [span({ traceId, spanId: "2222222222222222" })]);

    const rows = await store.rows<{
      organization_id: string;
      project_id: string;
      span_id: string;
    }>(
      `select organization_id, project_id, span_id from spans ` +
        `where trace_id = '${traceId}' order by span_id`,
    );

    expect(rows).toEqual([
      {
        organization_id: acme.organizationId,
        project_id: acme.projectId,
        span_id: "1111111111111111",
      },
      {
        organization_id: globex.organizationId,
        project_id: globex.projectId,
        span_id: "2222222222222222",
      },
    ]);
  });

  it("refuses a span when the credential names no project", async () => {
    const traceId = "1111111111111111111111111111bbbb";
    await expect(
      appendSpans(acrossTheOrganization(acme), [
        span({ traceId, spanId: "3333333333333333" }),
      ]),
    ).rejects.toThrow("project-scoped authorization context");

    expect(
      await countOf(`select count() as n from spans where trace_id = '${traceId}'`),
    ).toBe(0);
  });
});

describe("a batch too big for one insert", () => {
  /**
   * Split, never trimmed and never refused. An exporter that flushes a hundred
   * thousand spans at once is not doing anything wrong, and a door that
   * answered "too large" would lose a trace to a limit nobody told it
   * about.
   */
  it("is written in several, with every row landing", async () => {
    const traceId = "2222222222222222222222222222cccc";
    const spans = Array.from({ length: 12_001 }, (_, index) =>
      span({
        traceId,
        spanId: index.toString(16).padStart(16, "0"),
        startedAtMicroseconds: 1_785_693_880_281_989n + BigInt(index),
      }),
    );

    const written = await appendSpans(at(acme), spans);

    expect(written.appended).toBe(spans.length);
    expect(written.batches).toBeGreaterThan(1);
    expect(
      await countOf(
        `select count() as n from spans where trace_id = '${traceId}'`,
      ),
    ).toBe(spans.length);
  });

  /**
   * The partition key is `toYYYYMM(started_at)` and `started_at` came off the
   * wire, so how many partitions an insert touches is a client's decision:
   * `max_partitions_per_insert_block` is a hundred, and a batch over it is
   * refused whole by the engine rather than trimmed. An agent backfilling a
   * year of history, or one with a broken clock, is not a client egma may lose
   * a trace over.
   */
  it("plans one insert per month without asking ClickHouse to execute every insert", () => {
    const traceId = "aaaa1111222233334444555566667777";
    const months = 130;
    const spans = Array.from({ length: months }, (_, index) =>
      span({
        traceId,
        spanId: index.toString(16).padStart(16, "0"),
        startedAtMicroseconds:
          BigInt(Date.UTC(2015 + Math.floor(index / 12), index % 12, 1)) *
          1000n,
      }),
    );

    expect(planSpanInserts(at(acme), spans)).toMatchObject({
      spans: months,
      batches: months,
    });
  });

  it("writes a small multi-month batch with every row landing", async () => {
    const traceId = "bbbb1111222233334444555566667777";
    const months = 2;
    const spans = Array.from({ length: months }, (_, index) =>
      span({
        traceId,
        spanId: index.toString(16).padStart(16, "0"),
        startedAtMicroseconds:
          BigInt(Date.UTC(2025, index, 1)) * 1000n,
      }),
    );

    const written = await appendSpans(at(acme), spans);

    expect(written.appended).toBe(months);
    expect(written.batches).toBe(months);
    expect(
      await countOf(
        `select count() as n from spans where trace_id = '${traceId}'`,
      ),
    ).toBe(months);
    expect(
      await countOf(
        `select uniqExact(toYYYYMM(started_at)) as n from spans ` +
          `where trace_id = '${traceId}'`,
      ),
    ).toBe(months);
  });

  it("is written in one when it fits, so ordinary traffic pays nothing", async () => {
    const written = await appendSpans(at(acme), [
      span({ traceId: "3333333333333333333333333333dddd" }),
    ]);
    expect(written.batches).toBe(1);
  });

  it("splits before the serialized rows pass the byte limit", () => {
    const traceId = "cccccccccccccccccccccccccccccccc";
    const payload = "x".repeat(9 * 1024 * 1024);

    expect(
      planSpanInserts(at(acme), [
        span({ traceId, spanId: "0000000000000001", payload }),
        span({ traceId, spanId: "0000000000000002", payload }),
      ]),
    ).toEqual({ spans: 2, batches: 2 });
  });

  it("is not an insert at all when there is nothing in it", async () => {
    expect(await appendSpans(at(acme), [])).toEqual({
      appended: 0,
      batches: 0,
    });
  });
});

describe("a field too big for its column", () => {
  /**
   * **Refused, never shortened.** A transcript cut to fit is stored looking
   * exactly like a whole one: no column says a cut happened, no reader can tell,
   * and the customer whose evidence egma edited is the last person who could
   * ever find out. So the record does not go in at all, and whoever sent it is
   * told which field, what the bound is, and what arrived.
   */
  it("is refused by name, with the bound and the size it arrived at", async () => {
    const traceId = "4444444444444444444444444444eeee";
    const enormous = "x".repeat(200_000);

    const refused = appendSpans(at(acme), [span({ traceId, text: enormous })]);

    await expect(refused).rejects.toThrow(OversizeRecordError);
    await expect(refused).rejects.toMatchObject({
      field: "text",
      bound: 65_536,
      bytes: 200_000,
    });
  });

  it("takes nothing of the batch with it", async () => {
    const traceId = "4444444444444444444444444444dddd";
    const enormous = "x".repeat(200_000);

    await expect(
      appendSpans(at(acme), [
        span({ traceId, spanId: "0000000000000001" }),
        span({ traceId, spanId: "0000000000000002", toolResult: enormous }),
      ]),
    ).rejects.toThrow(OversizeRecordError);

    // Not the good record either. The whole batch is checked before the first
    // block is sent, so a refusal leaves nothing half-written to reconcile.
    expect(
      await countOf(
        `select count() as n from spans where trace_id = '${traceId}'`,
      ),
    ).toBe(0);
  });

  /**
   * The decision is a pure function of the record and is exported as one,
   * because the acceptance path has to make it before anything is staged — a
   * record egma will not store must never enter the log or ride a segment.
   */
  it("is the same answer before the write as at it", () => {
    expect(() => refuseOversizeRecord(span({ text: "x".repeat(65_536) })))
      .not.toThrow();
    expect(() =>
      refuseOversizeRecord(span({ text: "x".repeat(65_537) })),
    ).toThrow(OversizeRecordError);
  });

  /**
   * The bound is the store's, so it is counted in the store's unit: ClickHouse
   * measures a `String` in bytes of UTF-8 and JavaScript measures a string in
   * UTF-16 code units, and an emoji is four of the first and two of the second.
   * A budget kept in the wrong unit would refuse a legitimate transcript at a
   * quarter of the documented size.
   */
  it("is measured in bytes of UTF-8 rather than in characters", async () => {
    const traceId = "5555555555555555555555555555ffff";
    // 16384 emoji is 65_536 bytes exactly, and 32_768 UTF-16 code units.
    const atTheBound = "🙂".repeat(16_384);
    expect(atTheBound.length).toBeLessThan(65_536);

    await appendSpans(at(acme), [span({ traceId, text: atTheBound })]);

    const [row] = await store.rows<{ text: string; bytes: number }>(
      `select text, length(text) as bytes from spans final ` +
        `where trace_id = '${traceId}'`,
    );
    expect(row?.bytes).toBe(65_536);
    // Byte for byte, and no character split in half by anything on the way.
    expect(row?.text).toBe(atTheBound);

    await expect(
      appendSpans(at(acme), [
        span({ traceId, spanId: "0000000000000009", text: `${atTheBound}a` }),
      ]),
    ).rejects.toThrow(OversizeRecordError);
  });

  /**
   * The provider's own document has no bound and never had one. It is the copy
   * no later migration can reconstruct, and the batch splitter is what keeps a
   * large one writable.
   */
  it("does not apply to the verbatim payload", async () => {
    const traceId = "5555555555555555555555555555eeee";
    const enormous = JSON.stringify({ text: "x".repeat(200_000) });

    await appendSpans(at(acme), [span({ traceId, payload: enormous })]);

    const [row] = await store.rows<{ payload: string }>(
      `select payload from spans final where trace_id = '${traceId}'`,
    );
    expect(row?.payload).toBe(enormous);
  });
});

describe("what a span says, as one comparable value", () => {
  /**
   * Stored beside the row rather than recomputed from it. A hash taken from the
   * stored columns could not survive `LowCardinality`, `DateTime64` rounding or
   * the payload faithfully, so the fingerprint is taken from the record while
   * the record is still whole.
   */
  it("is written on the row, and is the fingerprint of the record", async () => {
    const traceId = "5656565656565656565656565656aaaa";
    const one = span({ traceId, spanId: "0000000000000001" });

    await appendSpans(at(acme), [one]);

    const [row] = await store.rows<{ content_hash: string }>(
      `select content_hash from spans final where trace_id = '${traceId}'`,
    );
    expect(row?.content_hash).toBe(spanContentHash(one));
    expect(row?.content_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("does not move when the same evidence is built twice", () => {
    expect(spanContentHash(span())).toBe(spanContentHash(span()));
  });

  /**
   * **The fingerprint of one fixed span, written down.**
   *
   * The stored `content_hash` is taken over key names, so renaming one — the
   * frozen `connection_kind`, say, which no longer matches its TypeScript
   * field — moves the fingerprint of every span already stored, and the
   * drainer then reads each replay as a second account of one immutable
   * identity and refuses the segment. Adding a field to `NewSpan` does the
   * same. Neither is forbidden; both need somebody to decide it, and this is
   * the line that makes them ask.
   */
  it("is the same fingerprint yesterday's Egma wrote", () => {
    expect(spanContentHash(span())).toBe(
      "ba722d17aefacf8e4533c8abbacf6355a26a1fe7aa63fd38411d87f04af4decb",
    );
  });

  it("moves when any part of the evidence does", () => {
    const original = span();
    for (const changed of [
      span({ text: "something else" }),
      span({ payload: '{"revision":2}' }),
      span({ startedAtMicroseconds: original.startedAtMicroseconds + 1n }),
      span({ durationNanoseconds: original.durationNanoseconds + 1n }),
      span({ endsTrace: true }),
    ]) {
      expect(spanContentHash(changed)).not.toBe(spanContentHash(original));
    }
  });

  /**
   * The platform's explicit end fact is part of the evidence, and an absent one
   * means `false` rather than something else. A writer that has learned to state
   * it and one that has not must agree about a span neither of them ends.
   */
  it("reads an unstated end fact as the `false` it means", () => {
    expect(spanContentHash(span({ endsTrace: false }))).toBe(
      spanContentHash(span()),
    );
  });
});

describe("sending the same batch twice", () => {
  /**
   * A replay of one span is the same span, and the identity is what says so:
   * organization, project, trace, span. It holds however long the replay took
   * and however the bytes were regrouped on the way, which is what the two
   * finite shields in front of it cannot promise.
   */
  it("leaves the visible row count where it was", async () => {
    const traceId = "6666666666666666666666666666aaaa";
    const batch = Array.from({ length: 20 }, (_, index) =>
      span({ traceId, spanId: index.toString(16).padStart(16, "0") }),
    );

    await appendSpans(at(acme), batch);
    const after = await countOf(
      `select count() as n from spans final where trace_id = '${traceId}'`,
    );
    expect(after).toBe(batch.length);

    await appendSpans(at(acme), batch);
    await appendSpans(at(acme), batch);

    expect(
      await countOf(
        `select count() as n from spans final where trace_id = '${traceId}'`,
      ),
    ).toBe(batch.length);
    expect(
      await countOf(
        `select count() as n from turns final where trace_id = '${traceId}'`,
      ),
    ).toBe(batch.length);
  });

  it("stores a differing batch as the different thing it is", async () => {
    const traceId = "7777777777777777777777777777bbbb";
    await appendSpans(at(acme), [span({ traceId, spanId: "0000000000000001" })]);
    await appendSpans(at(acme), [span({ traceId, spanId: "0000000000000002" })]);

    expect(
      await countOf(
        `select count() as n from spans final where trace_id = '${traceId}'`,
      ),
    ).toBe(2);
  });

  /**
   * **One identity is one visible span, whatever arrives claiming it.** This
   * used to assert the opposite — that changed evidence under a reused span id
   * was stored beside the original as the different thing it was — and that is
   * exactly the state the identity exists to make impossible: two accounts of
   * one immutable span, both visible, with nothing to say which one happened.
   *
   * Which of the two ends up visible is deliberately not asserted, because the
   * engine's answer is not the product's. A second, different account of one
   * identity is an integrity defect, and it is refused before it is written —
   * by the caller, against `committedSpans`, which is where that guarantee is
   * proved. What this function owes is that no reader is ever handed both.
   */
  it("never leaves two accounts of one span visible", async () => {
    const traceId = "aaaa2222aaaa2222aaaa2222aaaa2222";
    const batch = Array.from({ length: 5 }, (_, index) =>
      span({ traceId, spanId: index.toString(16).padStart(16, "0") }),
    );

    await appendSpans(at(acme), batch);
    await appendSpans(
      at(acme),
      batch.map((one) => ({ ...one, text: "a second account" })),
    );

    expect(
      await countOf(
        `select count() as n from spans final where trace_id = '${traceId}'`,
      ),
    ).toBe(batch.length);
    // The turn grain collapses on the same identity, and separately: the view
    // runs on the block that arrived, before the table has decided anything.
    expect(
      await countOf(
        `select count() as n from turns final where trace_id = '${traceId}'`,
      ),
    ).toBe(batch.length);
  });

  /** Tenant stamps lead the identity. Two customers may mint the same trace and
   * span ids, and those are still two different spans. */
  it("never mistakes two customers' identical ids for one span", async () => {
    const traceId = "bbbb3333bbbb3333bbbb3333bbbb3333";
    const batch = [span({ traceId, spanId: "abcdefabcdefabcd" })];

    await appendSpans(at(acme), batch);
    await appendSpans(at(globex), batch);

    expect(
      await countOf(
        `select count() as n from spans final where trace_id = '${traceId}'`,
      ),
    ).toBe(2);
  });
});

describe("a segment written twice", () => {
  /**
   * The shield the block-level one cannot be: a retry that re-serialised,
   * regrouped or re-split the same drained segment is different bytes and the
   * same output, so the block hash no longer matches and only a name given by
   * the writer can recognise it. The name is the segment's own identity, chosen
   * and persisted before the first upload, so every retry offers the same one.
   */
  it("is recognised by the name the writer gave it, not by its bytes", async () => {
    const traceId = "cccc4444cccc4444cccc4444cccc4444";
    const segmentId = "sgm_01JQZ0000000000000000000AA";
    const one = span({ traceId, spanId: "0000000000000001" });

    await appendSpans(at(acme), [one], { segmentId });
    await appendSpans(at(acme), [{ ...one, payload: '{"re":"serialised"}' }], {
      segmentId,
    });

    // Not one visible row out of two stored — one row, because the second
    // insert never reached the table at all.
    expect(
      await countOf(
        `select count() as n from spans where trace_id = '${traceId}'`,
      ),
    ).toBe(1);
    const [row] = await store.rows<{ payload: string }>(
      `select payload from spans where trace_id = '${traceId}'`,
    );
    expect(row?.payload).toBe("{}");
  });

  /**
   * And the name is per block, because a segment large enough to split writes
   * several. One name across all of them would suppress every block after the
   * first and lose most of the segment to its own shield.
   */
  it("names each of its blocks, so a split segment lands whole", async () => {
    const traceId = "dddd5555dddd5555dddd5555dddd5555";
    const months = 3;
    const spans = Array.from({ length: months }, (_, index) =>
      span({
        traceId,
        spanId: index.toString(16).padStart(16, "0"),
        startedAtMicroseconds: BigInt(Date.UTC(2025, index, 1)) * 1000n,
      }),
    );

    const written = await appendSpans(at(acme), spans, {
      segmentId: "sgm_01JQZ0000000000000000000BB",
    });

    expect(written.batches).toBe(months);
    expect(
      await countOf(
        `select count() as n from spans final where trace_id = '${traceId}'`,
      ),
    ).toBe(months);
  });
});

describe("the recorded start time", () => {
  it("is stored to the microsecond it was stamped, and never re-derived", async () => {
    const traceId = "8888888888888888888888888888cccc";
    await appendSpans(at(acme), [
      span({
        traceId,
        startedAtMicroseconds: 1_785_693_880_281_989n,
        durationNanoseconds: 73_494_876_403n,
      }),
    ]);

    const [row] = await store.rows<{ started_at: string; duration_ns: number }>(
      `select started_at, duration_ns from spans where trace_id = '${traceId}'`,
    );
    expect(row?.started_at).toBe("2026-08-02 18:04:40.281989");
    expect(row?.duration_ns).toBe(73_494_876_403);
  });

  it("survives a duration no JavaScript number could hold exactly", async () => {
    const traceId = "9999999999999999999999999999dddd";
    await appendSpans(at(acme), [
      span({ traceId, durationNanoseconds: 9_007_199_254_740_993n }),
    ]);

    const [row] = await store.rows<{ duration_ns: string }>(
      `select toString(duration_ns) as duration_ns from spans ` +
        `where trace_id = '${traceId}'`,
    );
    expect(row?.duration_ns).toBe("9007199254740993");
  });
});
