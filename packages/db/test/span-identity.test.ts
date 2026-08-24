import {
  appendSpans,
  committedSpans,
  committedTraces,
  connectClickHouse,
  disconnectClickHouse,
  spanContentHash,
  UnreadableTraceQueryError,
  type AuthContext,
  type NewSpan,
  type SpanIdentity,
} from "@egma/db";
import { newId } from "@egma/ids";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createMigratedTraceStore,
  type MigratedTraceStore,
} from "./support/clickhouse.ts";

/**
 * The two identity probes: what the store already holds, asked about a batch at
 * a time and answered without reading any evidence.
 *
 * They exist for one guarantee that nothing else in the package can make. A
 * span is immutable, so a second arrival under one identity is either the same
 * evidence — a replay, and a no-op — or different evidence, which is a defect
 * and must never overwrite what is already there. The engine cannot tell those
 * apart: it collapses both onto the identity and, having no version column,
 * keeps whichever row it read last. So the decision is made **before** the
 * write, by comparing fingerprints, and this file proves that comparison
 * answers correctly and that a writer holding to it leaves the original
 * visible.
 *
 * Real ClickHouse throughout, on the pattern the rest of the module's tests use:
 * what `FINAL` does over unmerged parts, and whether a batched lookup finds
 * every identity it was handed, are engine behaviours.
 */

let store: MigratedTraceStore;

const acme = { organizationId: newId("org"), userId: newId("usr") };
const globex = { organizationId: newId("org"), userId: newId("usr") };

const SUPPORT = newId("prj");
const OUTBOUND = newId("prj");

const WHEN = new Date("2026-05-04T12:00:00Z");
const WINDOW = {
  from: BigInt(Date.parse("2026-05-04T00:00:00Z")) * 1000n,
  to: BigInt(Date.parse("2026-05-05T00:00:00Z")) * 1000n,
};

function at(customer: typeof acme, projectId: string = SUPPORT): AuthContext {
  return {
    userId: customer.userId,
    organizationId: customer.organizationId,
    projectId,
    role: "admin",
    via: "api_key",
  };
}

/** A key minted for the whole customer, which is what naming no project means. */
function acrossTheOrganization(customer: typeof acme): AuthContext {
  return { ...at(customer), projectId: undefined };
}

function span(overrides: Partial<NewSpan> = {}): NewSpan {
  return {
    traceId: "11111111111111111111111111111111",
    spanId: "1111111111111111",
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
    connectionType: "",
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

function identityOf(one: NewSpan): SpanIdentity {
  return { traceId: one.traceId, spanId: one.spanId };
}

beforeAll(async () => {
  store = await createMigratedTraceStore("span_identity");
  connectClickHouse({ clickhouseUrl: store.url, maxOpenConnections: 4 });
});

afterAll(async () => {
  await disconnectClickHouse();
  await store.drop();
});

describe("asking which spans are already committed", () => {
  const TRACE = "aaaa0000aaaa0000aaaa0000aaaa0000";

  const written = Array.from({ length: 3 }, (_, index) =>
    span({
      traceId: TRACE,
      spanId: `2222${index.toString(16).padStart(12, "0")}`,
      text: `said ${index}`,
    }),
  );

  beforeAll(async () => {
    await appendSpans(at(acme), written);
  });

  it("answers with the fingerprint the writer computed", async () => {
    const found = await committedSpans(
      at(acme),
      written.map(identityOf),
      { window: WINDOW },
    );

    expect(found).toHaveLength(written.length);
    for (const one of written) {
      expect(found).toContainEqual({
        traceId: one.traceId,
        spanId: one.spanId,
        contentHash: spanContentHash(one),
        traceStartedAtMicroseconds: one.startedAtMicroseconds,
      });
    }
  });

  it("returns the whole visible trace's start when asked only about its later span", async () => {
    const traceId = "aaaa1111aaaa1111aaaa1111aaaa1111";
    const earlier = span({
      traceId,
      spanId: "2222111111111111",
      startedAtMicroseconds:
        BigInt(WHEN.getTime() - 30 * 60_000) * 1_000n,
    });
    const later = span({
      traceId,
      spanId: "2222222222222222",
      startedAtMicroseconds:
        BigInt(WHEN.getTime() + 30 * 60_000) * 1_000n,
    });
    await appendSpans(at(acme), [earlier, later]);

    expect(
      await committedSpans(at(acme), [identityOf(later)], { window: WINDOW }),
    ).toEqual([
      {
        traceId,
        spanId: later.spanId,
        contentHash: spanContentHash(later),
        traceStartedAtMicroseconds: earlier.startedAtMicroseconds,
      },
    ]);
  });

  it("says nothing at all about an identity it does not hold", async () => {
    const found = await committedSpans(
      at(acme),
      [
        identityOf(written[0] as NewSpan),
        { traceId: TRACE, spanId: "9999999999999999" },
      ],
      { window: WINDOW },
    );

    expect(found.map((one) => one.spanId)).toEqual([written[0]?.spanId]);
  });

  it("asks about nothing without asking the store anything", async () => {
    expect(await committedSpans(at(acme), [], { window: WINDOW })).toEqual([]);
    expect(await committedTraces(at(acme), [], { window: WINDOW })).toEqual(
      new Set(),
    );
  });

  /**
   * A segment is five thousand spans at its largest and the probe is one
   * statement per five hundred, so the batching is not an optimisation — an
   * unbatched list would be a request URL an HTTP intermediary refuses before
   * ClickHouse ever sees it. What must not change with the batching is the
   * answer.
   */
  it("finds every identity across more than one statement", async () => {
    const many = Array.from({ length: 1_200 }, (_, index) =>
      span({
        traceId: "bbbb0000bbbb0000bbbb0000bbbb0000",
        spanId: `3333${index.toString(16).padStart(12, "0")}`,
      }),
    );
    await appendSpans(at(acme), many);

    const found = await committedSpans(at(acme), many.map(identityOf), {
      window: WINDOW,
    });

    expect(found).toHaveLength(many.length);
    expect(new Set(found.map((one) => one.spanId)).size).toBe(many.length);
  });

  /**
   * A replay lands in the partition its first arrival landed in — the recorded
   * start time is the writer's and is never re-derived — so an identity stays
   * findable however long the replay took to arrive.
   */
  it("finds a replayed identity as the one span it is", async () => {
    const one = written[0] as NewSpan;
    await appendSpans(at(acme), [one]);
    await appendSpans(at(acme), [one]);

    const found = await committedSpans(at(acme), [identityOf(one)], {
      window: WINDOW,
    });

    expect(found).toEqual([
      {
        traceId: one.traceId,
        spanId: one.spanId,
        contentHash: spanContentHash(one),
        traceStartedAtMicroseconds: one.startedAtMicroseconds,
      },
    ]);
  });
});

/**
 * The guarantee the probe exists for, made the way a caller makes it.
 *
 * This is the whole pre-write integrity check in miniature: read what is
 * committed, compare fingerprints, and write nothing when they disagree. The
 * complete version belongs to the drainer, which also keeps the conflicting
 * object rather than deleting it; what has to be true here is that the
 * comparison is possible, that it is right, and that the evidence already
 * stored is what a reader still sees afterwards.
 */
describe("a second, different account of one span", () => {
  const TRACE = "cccc0000cccc0000cccc0000cccc0000";
  const original = span({
    traceId: TRACE,
    spanId: "4444444444444444",
    text: "what was actually said",
  });
  const conflicting = { ...original, text: "what was not" };

  beforeAll(async () => {
    await appendSpans(at(acme), [original]);
  });

  it("is refused before it is written, and the original stays visible", async () => {
    const committed = new Map(
      (
        await committedSpans(at(acme), [identityOf(conflicting)], {
          window: WINDOW,
        })
      ).map((one) => [`${one.traceId}:${one.spanId}`, one.contentHash]),
    );

    const standing = committed.get(`${TRACE}:${conflicting.spanId}`);
    expect(standing).toBe(spanContentHash(original));
    expect(standing).not.toBe(spanContentHash(conflicting));

    // So the writer does not write. Nothing about the store made this
    // decision — it is the comparison above, made while both meanings existed.
    const [visible] = await store.rows<{ text: string }>(
      `select text from spans final where trace_id = '${TRACE}'`,
    );
    expect(visible?.text).toBe("what was actually said");
  });

  it("is an exact replay when the fingerprints agree, and changes nothing", async () => {
    const [standing] = await committedSpans(at(acme), [identityOf(original)], {
      window: WINDOW,
    });
    expect(standing?.contentHash).toBe(spanContentHash(original));

    await appendSpans(at(acme), [original]);

    const rows = await store.rows<{ text: string }>(
      `select text from spans final where trace_id = '${TRACE}'`,
    );
    expect(rows).toEqual([{ text: "what was actually said" }]);
  });
});

describe("asking which traces are already committed", () => {
  const HELD = "dddd0000dddd0000dddd0000dddd0000";
  const ALSO_HELD = "dddd1111dddd1111dddd1111dddd1111";
  const NEVER_SENT = "eeee0000eeee0000eeee0000eeee0000";

  beforeAll(async () => {
    await appendSpans(at(acme), [
      span({ traceId: HELD, spanId: "5555555555555555" }),
      span({ traceId: HELD, spanId: "5555555555555556" }),
      span({ traceId: ALSO_HELD, spanId: "5555555555555557" }),
    ]);
  });

  it("answers only for the ids it was asked about", async () => {
    const found = await committedTraces(
      at(acme),
      [HELD, ALSO_HELD, NEVER_SENT],
      { window: WINDOW },
    );

    expect([...found].sort()).toEqual([ALSO_HELD, HELD].sort());
  });

  /**
   * One span is enough. The question is whether egma has already done this work,
   * which is deliberately not the question of whether the conversation ended —
   * that is a fact its platform states, and no count of rows may stand in for
   * it.
   */
  it("answers for a trace that holds one span as readily as for one that holds many", async () => {
    const found = await committedTraces(at(acme), [ALSO_HELD], {
      window: WINDOW,
    });
    expect(found.has(ALSO_HELD)).toBe(true);
  });
});

describe("what a probe can be asked about", () => {
  const MINE = "ffff0000ffff0000ffff0000ffff0000";

  beforeAll(async () => {
    await appendSpans(at(acme), [
      span({ traceId: MINE, spanId: "6666666666666666" }),
    ]);
  });

  /**
   * The identity a probe is handed came from somewhere, and a caller holding
   * another customer's trace id must learn nothing from asking. Tenancy is
   * stamped from the context and from nothing passed in, so the answer is that
   * the store holds no such thing.
   */
  it("is nothing another customer holds, however exactly they name it", async () => {
    expect(
      await committedSpans(
        at(globex),
        [{ traceId: MINE, spanId: "6666666666666666" }],
        { window: WINDOW },
      ),
    ).toEqual([]);
    expect(await committedTraces(at(globex), [MINE], { window: WINDOW })).toEqual(
      new Set(),
    );
  });

  /**
   * And not another project of the same customer, because a credential minted
   * for one product area answers for that product area. The argument can only
   * narrow an organization-wide context; it can never widen a narrowed one.
   */
  it("is nothing outside the project the credential names", async () => {
    expect(
      await committedTraces(at(acme, OUTBOUND), [MINE], { window: WINDOW }),
    ).toEqual(new Set());

    // The same key with no project named reaches both, and narrowing by
    // argument reaches the one named.
    expect(
      await committedTraces(acrossTheOrganization(acme), [MINE], {
        window: WINDOW,
      }),
    ).toEqual(new Set([MINE]));
    expect(
      await committedTraces(acrossTheOrganization(acme), [MINE], {
        window: WINDOW,
        projectId: OUTBOUND,
      }),
    ).toEqual(new Set());
  });

  /**
   * The window comes from the caller's own bounds — a scan's fixed ends, the
   * span times inside a segment — and never from the clock. A probe that could
   * be asked without one would be a full scan of every month the customer ever
   * had, because the partition key is the month a span started in.
   */
  it("is only what the window holds", async () => {
    const elsewhere = {
      from: BigInt(Date.parse("2026-06-01T00:00:00Z")) * 1000n,
      to: BigInt(Date.parse("2026-06-02T00:00:00Z")) * 1000n,
    };

    expect(
      await committedSpans(
        at(acme),
        [{ traceId: MINE, spanId: "6666666666666666" }],
        { window: elsewhere },
      ),
    ).toEqual([]);
    expect(await committedTraces(at(acme), [MINE], { window: elsewhere })).toEqual(
      new Set(),
    );
  });

  it("is refused when the window ends before it starts", async () => {
    await expect(
      committedTraces(at(acme), [MINE], {
        window: { from: WINDOW.to, to: WINDOW.from },
      }),
    ).rejects.toThrow(UnreadableTraceQueryError);
  });

  /**
   * A window wider than a product read may name is legitimate here. A thirty-day
   * import that ran long is one bounded question about a set of ids the caller
   * is already holding, and refusing it would leave a poller unable to ask about
   * its own scan.
   */
  it("is not held to the ceiling a page of traces is", async () => {
    const wide = {
      from: BigInt(Date.parse("2026-01-01T00:00:00Z")) * 1000n,
      to: BigInt(Date.parse("2026-12-01T00:00:00Z")) * 1000n,
    };

    expect(await committedTraces(at(acme), [MINE], { window: wide })).toEqual(
      new Set([MINE]),
    );
  });
});
