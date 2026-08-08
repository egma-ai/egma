import {
  appendSpans,
  connectClickHouse,
  disconnectClickHouse,
  type AuthContext,
  type NewSpan,
} from "@egma/db";
import { newId } from "@egma/ids";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

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
 * Everything here runs against a real ClickHouse. Row counts after a repeat,
 * what a `LowCardinality` column does with a long string, and whether an insert
 * of ten thousand rows arrives whole are engine behaviours, and a substitute
 * would confirm only the strings egma sends.
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

  it("files under the project sentinel when the credential names no project", async () => {
    const traceId = "1111111111111111111111111111bbbb";
    await appendSpans(acrossTheOrganization(acme), [
      span({ traceId, spanId: "3333333333333333" }),
    ]);

    const [row] = await store.rows<{ project_id: string }>(
      `select project_id from spans where trace_id = '${traceId}'`,
    );
    expect(row?.project_id).toBe("default");
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
  it("is split by month as well as by size, because an insert may touch a hundred partitions", async () => {
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

    const written = await appendSpans(at(acme), spans);

    expect(written.appended).toBe(months);
    // One block per month: every one of them is inside the engine's limit,
    // which a single block of all of them would not have been.
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

  it("is not an insert at all when there is nothing in it", async () => {
    expect(await appendSpans(at(acme), [])).toEqual({
      appended: 0,
      batches: 0,
    });
  });
});

describe("a field too big for its column", () => {
  /**
   * The cap costs presentation, never data. A transcript long enough to reach
   * one is shortened in the column a page renders and kept whole in the payload
   * beside it — which is the only reason capping is safe at all.
   */
  it("is cut in the column and kept whole in the verbatim payload", async () => {
    const traceId = "4444444444444444444444444444eeee";
    const enormous = "x".repeat(200_000);

    await appendSpans(at(acme), [
      span({
        traceId,
        text: enormous,
        toolArguments: enormous,
        toolResult: enormous,
        name: "n".repeat(5_000),
        payload: JSON.stringify({ text: enormous }),
      }),
    ]);

    const [row] = await store.rows<{
      text_length: number;
      arguments_length: number;
      result_length: number;
      name_length: number;
      payload_length: number;
    }>(
      `select length(text) as text_length, ` +
        `length(tool_arguments) as arguments_length, ` +
        `length(tool_result) as result_length, ` +
        `length(name) as name_length, ` +
        `length(payload) as payload_length ` +
        `from spans where trace_id = '${traceId}'`,
    );

    expect(row?.text_length).toBeLessThan(enormous.length);
    expect(row?.arguments_length).toBeLessThan(enormous.length);
    expect(row?.result_length).toBeLessThan(enormous.length);
    expect(row?.name_length).toBeLessThan(5_000);
    // Nothing happened to the payload, which is where the original still is.
    expect(row?.payload_length).toBeGreaterThan(enormous.length);
  });

  it("is never cut through the middle of a character", async () => {
    const traceId = "5555555555555555555555555555ffff";
    // One byte in front of the emoji, so that the cap cannot land on a
    // character boundary by luck: an emoji is four bytes of UTF-8 and a
    // surrogate pair of UTF-16, and a cut between its halves would store
    // something that is not text in any encoding.
    await appendSpans(at(acme), [
      span({ traceId, text: `a${"🙂".repeat(40_000)}` }),
    ]);

    const [row] = await store.rows<{ text: string; bytes: number }>(
      `select text, length(text) as bytes from spans where trace_id = '${traceId}'`,
    );

    const text = row?.text ?? "";
    expect(text).toMatch(/^a🙂+$/u);
    // A lone high surrogate is what a naive cut leaves behind, and it is
    // exactly what the column must never hold.
    const last = text.charCodeAt(text.length - 1);
    expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
    // The limit is the store's, so it is counted in the store's unit. Kept in
    // UTF-16 code units this string would have been 64 KiB of characters and
    // 256 KiB of column.
    expect(row?.bytes).toBeLessThanOrEqual(65_536);
    expect(row?.bytes).toBeGreaterThan(65_000);
  });
});

describe("sending the same batch twice", () => {
  /**
   * The producer owes non-duplication and an exporter's retry is byte-identical
   * by design, so this is the backstop under a path egma does not own. It only
   * works because the rows are a pure function of the arguments: nothing here
   * stamps a clock or a random token on the way past.
   */
  it("leaves the row count where it was", async () => {
    const traceId = "6666666666666666666666666666aaaa";
    const batch = Array.from({ length: 20 }, (_, index) =>
      span({ traceId, spanId: index.toString(16).padStart(16, "0") }),
    );

    await appendSpans(at(acme), batch);
    const after = await countOf(
      `select count() as n from spans where trace_id = '${traceId}'`,
    );
    expect(after).toBe(batch.length);

    await appendSpans(at(acme), batch);
    await appendSpans(at(acme), batch);

    expect(
      await countOf(
        `select count() as n from spans where trace_id = '${traceId}'`,
      ),
    ).toBe(batch.length);
    expect(
      await countOf(
        `select count() as n from turns where trace_id = '${traceId}'`,
      ),
    ).toBe(batch.length);
  });

  it("stores a differing batch as the different thing it is", async () => {
    const traceId = "7777777777777777777777777777bbbb";
    await appendSpans(at(acme), [span({ traceId, spanId: "0000000000000001" })]);
    await appendSpans(at(acme), [span({ traceId, spanId: "0000000000000002" })]);

    expect(
      await countOf(
        `select count() as n from spans where trace_id = '${traceId}'`,
      ),
    ).toBe(2);
  });

  /**
   * The stronger half of the guarantee, and the reason the writer sends an
   * explicit dedup token rather than leaning on ClickHouse's content hash
   * alone: identity is the writer-minted ids, not the bytes. A resend that was
   * re-serialised on the way — different field, same ids — is the same spans
   * saying the same thing twice, and it lands once.
   */
  it("lands a resend once even when its bytes changed, because the ids say it is the same batch", async () => {
    const traceId = "aaaa2222aaaa2222aaaa2222aaaa2222";
    const batch = Array.from({ length: 5 }, (_, index) =>
      span({ traceId, spanId: index.toString(16).padStart(16, "0") }),
    );

    await appendSpans(at(acme), batch);
    await appendSpans(
      at(acme),
      batch.map((one) => ({ ...one, text: "re-serialised on the way" })),
    );

    expect(
      await countOf(
        `select count() as n from spans where trace_id = '${traceId}'`,
      ),
    ).toBe(batch.length);
    // What landed is the first telling, which is the one that was acknowledged.
    expect(
      await countOf(
        `select count() as n from spans where trace_id = '${traceId}' ` +
          `and text = 're-serialised on the way'`,
      ),
    ).toBe(0);
    // A dropped block feeds the turn view nothing either: the human is not
    // heard saying the same thing twice because a resend changed its spelling.
    expect(
      await countOf(
        `select count() as n from turns where trace_id = '${traceId}'`,
      ),
    ).toBe(batch.length);
  });

  /**
   * The token says whose spans these are as well as which. Two customers can
   * mint colliding ids — nothing coordinates them — and the second customer's
   * telemetry must never be dropped as a duplicate of the first's.
   */
  it("never mistakes two customers' identical ids for one batch", async () => {
    const traceId = "bbbb3333bbbb3333bbbb3333bbbb3333";
    const batch = [span({ traceId, spanId: "abcdefabcdefabcd" })];

    await appendSpans(at(acme), batch);
    await appendSpans(at(globex), batch);

    expect(
      await countOf(
        `select count() as n from spans where trace_id = '${traceId}'`,
      ),
    ).toBe(2);
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
