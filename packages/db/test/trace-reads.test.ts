import {
  appendSpans,
  connectClickHouse,
  disconnectClickHouse,
  listTraces,
  MAXIMUM_SPANS_PER_TRACE,
  MAXIMUM_WINDOW_MILLISECONDS,
  permits,
  readTrace,
  ROLES,
  UnreadableTraceQueryError,
  type AuthContext,
  type NewSpan,
  type Role,
  type TraceDetail,
  type TraceSpan,
} from "@egma/db";
import { newId } from "@egma/ids";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createMigratedTraceStore,
  type MigratedTraceStore,
} from "./support/clickhouse.ts";

/**
 * The two read functions, asked the questions a route cannot ask them.
 *
 * The endpoints are tested over HTTP, where they belong, and three things are
 * only reachable here: what a `viewer` may read, since every account the product
 * makes is an admin; what a context can be talked into by an argument, since a
 * route only ever hands it what a URL said; and what the tree does with a span
 * whose parent never arrived, which the captured trace has no example of because
 * a real exporter does not produce one.
 *
 * Real ClickHouse throughout, on the pattern the rest of the module's tests use.
 */

let store: MigratedTraceStore;

const acme = { organizationId: newId("org"), userId: newId("usr") };
const globex = { organizationId: newId("org"), userId: newId("usr") };
const identityProof = { organizationId: newId("org"), userId: newId("usr") };

const OUTBOUND = newId("prj");
const SUPPORT = newId("prj");

/** An instant as the microseconds since the epoch a window is counted in. */
function microseconds(instant: string): bigint {
  return BigInt(Date.parse(instant)) * 1000n;
}

/** The minute everything in this file happened in, and a window around it. */
const WHEN = new Date("2026-05-04T12:00:00Z");
const WINDOW = {
  from: microseconds("2026-05-04T00:00:00Z"),
  to: microseconds("2026-05-05T00:00:00Z"),
};

function at(
  customer: typeof acme,
  projectId: string | undefined,
  role: Role = "admin",
): AuthContext {
  return {
    userId: customer.userId,
    organizationId: customer.organizationId,
    projectId,
    role,
    via: "api_key",
  };
}

let nextSpanId = 0;
function spanId(): string {
  nextSpanId += 1;
  return nextSpanId.toString(16).padStart(16, "0");
}

function span(overrides: Partial<NewSpan> = {}): NewSpan {
  return {
    traceId: "11111111111111111111111111111111",
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

/**
 * Every span a transcript holds — inside a turn, under the root, or beside
 * both — which is what "the response holds every span exactly once" is asked
 * with.
 */
function everySpanOf(detail: TraceDetail | undefined): TraceSpan[] {
  const walk = (spans: readonly TraceSpan[]): TraceSpan[] =>
    spans.flatMap((each) => [each, ...walk(each.spans)]);
  return detail === undefined
    ? []
    : [...walk(detail.turns), ...walk(detail.spans)];
}

/** A root, one human turn under it, and one step under the turn. */
function aTrace(traceId: string): NewSpan[] {
  const root = spanId();
  const turn = spanId();
  return [
    span({ traceId, spanId: root }),
    span({
      traceId,
      spanId: turn,
      parentSpanId: root,
      name: "user_turn",
      kind: "turn:human",
      text: "Hello there.",
      startedAtMicroseconds: BigInt(WHEN.getTime() + 1000) * 1000n,
    }),
    span({
      traceId,
      spanId: spanId(),
      parentSpanId: turn,
      name: "eou_detection",
      kind: "end-of-turn",
      startedAtMicroseconds: BigInt(WHEN.getTime() + 1500) * 1000n,
    }),
  ];
}

const ACME_TRACE = "aaaa1111111111111111111111111111";
const GLOBEX_TRACE = "bbbb1111111111111111111111111111";
const OUTBOUND_TRACE = "cccc1111111111111111111111111111";

beforeAll(async () => {
  store = await createMigratedTraceStore("trace_reads");
  connectClickHouse({ clickhouseUrl: store.url, maxOpenConnections: 4 });

  await appendSpans(at(acme, SUPPORT), aTrace(ACME_TRACE));
  await appendSpans(at(acme, OUTBOUND), aTrace(OUTBOUND_TRACE));
  await appendSpans(at(globex, SUPPORT), aTrace(GLOBEX_TRACE));
});

afterAll(async () => {
  await disconnectClickHouse();
  await store.drop();
});

describe("who may read a trace", () => {
  /**
   * Every role, `viewer` included, and this is not an oversight to tighten
   * later. Reading what an agent did *is* the product — a read-only QA lead is
   * a use case egma's own positioning names as first-class — and a role that
   * could not do it would be a login with nothing behind it. The permission
   * table's `read` row has said so since the first commit; these two functions
   * ask for that row and no other.
   */
  it("is every one of the three roles, and it is the viewer that matters", async () => {
    for (const role of ROLES) {
      const anybody = at(acme, SUPPORT, role);

      const list = await listTraces(anybody, { window: WINDOW });
      expect(list.traces.map((trace) => trace.traceId), role).toEqual([
        ACME_TRACE,
      ]);

      const detail = await readTrace(anybody, ACME_TRACE, { window: WINDOW });
      expect(detail?.turns, role).toHaveLength(1);
    }
  });

  /**
   * There is no refusal to test on the other side of this row, and that is the
   * finding rather than a gap. `read` names all three roles, so no role is
   * refused; and the scope these ask about is built from the context itself, so
   * there is no call that names another organization to be refused *for*. What
   * keeps another customer's rows out is the predicate, which is the next
   * describe block, and it is a stronger guarantee than a permission check
   * because it is not a decision anybody can get wrong.
   */
  it("is answered by the permission table and not by these functions", () => {
    const where = { organizationId: acme.organizationId, projectId: SUPPORT };
    for (const role of ROLES) {
      expect(permits(at(acme, SUPPORT, role), "read", where), role).toBe(true);
    }
  });
});

describe("another customer's trace", () => {
  it("is not in their list, and is not theirs to read by id", async () => {
    const globexList = await listTraces(at(globex, SUPPORT), { window: WINDOW });
    expect(globexList.traces.map((trace) => trace.traceId)).toEqual([
      GLOBEX_TRACE,
    ]);

    // The id is exactly right, the window is exactly right, and the project is
    // exactly right. The organization is not, and that is the whole answer.
    expect(
      await readTrace(at(globex, SUPPORT), ACME_TRACE, { window: WINDOW }),
    ).toBeUndefined();
  });
});

/**
 * Some exporters send the root after one or more children. The platform agent
 * reference may exist only on that root. A trace read must therefore prefer a
 * non-empty root fact over an empty child rather than use whichever row an
 * aggregate happens to see first.
 */
describe("platform agent reference carried only by a late root", () => {
  const ROOT_ONLY = "abab2222222222222222222222222222";

  beforeAll(async () => {
    const root = spanId();

    // The child lands first, in its own insert, with none of the platform agent
    // reference fields. This is the ordering that exposed `any()` as unsafe.
    await appendSpans(at(identityProof, SUPPORT), [
      span({
        traceId: ROOT_ONLY,
        spanId: spanId(),
        parentSpanId: root,
        name: "user_turn",
        kind: "turn:human",
        text: "The child arrived first.",
        providerCallId: "",
        agentPlatform: "",
        platformAgentId: "",
        platformAgentName: "",
        platformAgentVersion: "",
        startedAtMicroseconds: BigInt(WHEN.getTime() + 1000) * 1000n,
      }),
    ]);

    await appendSpans(at(identityProof, SUPPORT), [
      span({
        traceId: ROOT_ONLY,
        spanId: root,
        providerCallId: "room-root-only",
        agentPlatform: "livekit_agents",
        platformAgentId: "cloud-agent-7",
        platformAgentName: "Front desk",
        platformAgentVersion: "2026-08-20",
      }),
    ]);
  });

  it("returns the same platform agent reference in the list and detail", async () => {
    const expected = {
      providerCallId: "room-root-only",
      agentPlatform: "livekit_agents",
      platformAgentId: "cloud-agent-7",
      platformAgentName: "Front desk",
      platformAgentVersion: "2026-08-20",
    };
    const listed = (
      await listTraces(at(identityProof, SUPPORT), {
        window: WINDOW,
        limit: 200,
      })
    ).traces.find((trace) => trace.traceId === ROOT_ONLY);
    const detail = await readTrace(at(identityProof, SUPPORT), ROOT_ONLY, {
      window: WINDOW,
    });

    expect(listed).toMatchObject(expected);
    expect(detail).toMatchObject(expected);
  });
});

describe("the project on a read", () => {
  it("is the whole customer when the credential names none", async () => {
    const list = await listTraces(at(acme, undefined), { window: WINDOW });
    expect(list.traces.map((trace) => trace.traceId).sort()).toEqual(
      [ACME_TRACE, OUTBOUND_TRACE].sort(),
    );
  });

  /**
   * `?project_id=` is what a form submits for a field left blank, and `??` does
   * not catch it. Read as a name it would put `project_id = ''` in the
   * predicate — which no row has ever been written under — and the customer
   * would be handed an empty list they could not tell from having no traces.
   */
  it("is the whole customer when the parameter arrived empty", async () => {
    const list = await listTraces(at(acme, undefined), {
      window: WINDOW,
      projectId: "",
    });
    expect(list.traces.map((trace) => trace.traceId).sort()).toEqual(
      [ACME_TRACE, OUTBOUND_TRACE].sort(),
    );

    const detail = await readTrace(at(acme, undefined), ACME_TRACE, {
      window: WINDOW,
      projectId: "",
    });
    expect(detail?.traceId).toBe(ACME_TRACE);
  });

  it("narrows when a caller asks it to", async () => {
    const list = await listTraces(at(acme, undefined), {
      window: WINDOW,
      projectId: OUTBOUND,
    });
    expect(list.traces.map((trace) => trace.traceId)).toEqual([OUTBOUND_TRACE]);
  });

  /**
   * The argument narrows and can never widen. A key minted for one product area
   * reads that product area, and a caller naming a different one does not get
   * it — not a wider answer, and not a mixed one.
   */
  it("cannot be widened past a credential that already names one", async () => {
    const list = await listTraces(at(acme, SUPPORT), {
      window: WINDOW,
      projectId: OUTBOUND,
    });
    expect(list.traces.map((trace) => trace.traceId)).toEqual([ACME_TRACE]);

    expect(
      await readTrace(at(acme, SUPPORT), OUTBOUND_TRACE, {
        window: WINDOW,
        projectId: OUTBOUND,
      }),
    ).toBeUndefined();
  });
});

describe("the window a read is bounded by", () => {
  it("is refused here too, not only at the route that parsed it", async () => {
    const tooWide = {
      from: BigInt(WHEN.getTime() - MAXIMUM_WINDOW_MILLISECONDS - 1) * 1000n,
      to: BigInt(WHEN.getTime()) * 1000n,
    };
    await expect(
      listTraces(at(acme, SUPPORT), { window: tooWide }),
    ).rejects.toThrow(UnreadableTraceQueryError);
    await expect(
      readTrace(at(acme, SUPPORT), ACME_TRACE, { window: tooWide }),
    ).rejects.toThrow(UnreadableTraceQueryError);
  });

  it("is refused when it ends before it starts", async () => {
    await expect(
      listTraces(at(acme, SUPPORT), {
        window: { from: WINDOW.to, to: WINDOW.from },
      }),
    ).rejects.toThrow(UnreadableTraceQueryError);
  });

  /**
   * An instant a `DateTime64` cannot hold is refused here rather than written
   * into a statement, and the reason is that the literal built from one is not a
   * timestamp: `toISOString` writes a year outside 0000–9999 with a sign and six
   * digits, and the store answers a mangled literal with a parse error the
   * customer would read as a fault of egma's rather than as a window they
   * cannot have.
   */
  it("is refused when it names an instant the store cannot hold", async () => {
    const beyond = [
      // A year the store has no room for at either end, and both bounds moved
      // together so that the width is not what refuses them.
      { from: microseconds("+275760-09-11T00:00:00Z"), to: microseconds("+275760-09-12T00:00:00Z") },
      { from: microseconds("-000001-01-01T00:00:00Z"), to: microseconds("-000001-01-02T00:00:00Z") },
      // And the far edge itself, which is where a nanosecond count since the
      // epoch stops fitting in sixty-four signed bits.
      { from: microseconds("2262-04-11T00:00:00Z"), to: microseconds("2262-04-12T00:00:00Z") },
    ];

    for (const window of beyond) {
      await expect(
        listTraces(at(acme, SUPPORT), { window }),
        String(window.from),
      ).rejects.toThrow(UnreadableTraceQueryError);
      await expect(
        readTrace(at(acme, SUPPORT), ACME_TRACE, { window }),
        String(window.from),
      ).rejects.toThrow(UnreadableTraceQueryError);
    }
  });

  /** A trace outside the window is not there, which is the same as not existing. */
  it("decides whether a trace is there at all", async () => {
    const elsewhere = {
      from: microseconds("2026-05-06T00:00:00Z"),
      to: microseconds("2026-05-07T00:00:00Z"),
    };
    expect(
      (await listTraces(at(acme, SUPPORT), { window: elsewhere })).traces,
    ).toEqual([]);
    expect(
      await readTrace(at(acme, SUPPORT), ACME_TRACE, { window: elsewhere }),
    ).toBeUndefined();
  });
});

/**
 * A span whose parent is not in the trace.
 *
 * The door normalises a malformed parent id to `''` and keeps the original in
 * the payload, and a parent that simply never arrived is the same case from the
 * reader's side. Ticket 03 settled what to do with both: treat the span as
 * top-level rather than letting it vanish down a chain that goes nowhere. The
 * captured trace has no example — a real exporter does not produce one — so it
 * is written here.
 */
describe("a span whose parent never arrived", () => {
  const ORPHANED = "dddd1111111111111111111111111111";

  beforeAll(async () => {
    const root = spanId();
    await appendSpans(at(acme, SUPPORT), [
      span({ traceId: ORPHANED, spanId: root }),
      span({
        traceId: ORPHANED,
        spanId: spanId(),
        // A parent id that is not in this trace at all.
        parentSpanId: "cccccccccccccccc",
        name: "llm_request",
        kind: "model",
        startedAtMicroseconds: BigInt(WHEN.getTime() + 2000) * 1000n,
      }),
      span({
        traceId: ORPHANED,
        spanId: spanId(),
        // And one that names itself, which is a cycle of one.
        parentSpanId: "dddddddddddddddd",
        name: "tts_request",
        kind: "tts",
        startedAtMicroseconds: BigInt(WHEN.getTime() + 3000) * 1000n,
      }),
    ]);
  });

  it("is read as top-level rather than lost, and the trace still holds every span", async () => {
    const detail = await readTrace(at(acme, SUPPORT), ORPHANED, {
      window: WINDOW,
    });

    expect(detail?.spanCount).toBe(3);
    expect(detail?.spans.map((each) => each.name)).toEqual([
      "agent_session",
      "llm_request",
      "tts_request",
    ]);
    // The parent it named is still on the row, exactly as it arrived — the
    // reader treats it as top-level without rewriting what was sent.
    expect(detail?.spans[1]?.parentSpanId).toBe("cccccccccccccccc");
  });
});

/**
 * A span replayed, which is the only way one identity ever arrives twice on a
 * path that is working.
 *
 * This suite used to assert the opposite: that a second, different account of a
 * span id was stored beside the first and that a reader handed back both. That
 * was a reader faithfully reporting an integrity defect as if it were a
 * transcript — a person reading it would see the human speak twice and have no
 * way to learn that only one of those things was ever said. Two accounts of one
 * immutable span are refused before the second is written now, so what a read
 * has to prove is the case that remains: a replay is one span, however many
 * physical copies of it the store is holding at this instant.
 */
describe("a replayed span in a trace somebody opens", () => {
  const REPLAYED = "abab1111111111111111111111111111";
  const root = "dadadadadadadada";
  const turn = "dbdbdbdbdbdbdbdb";
  const child = "dcdcdcdcdcdcdcdc";

  const trace = (): NewSpan[] => [
    span({
      traceId: REPLAYED,
      spanId: root,
      name: "agent_session",
      payload: '{"revision":1}',
    }),
    span({
      traceId: REPLAYED,
      spanId: turn,
      parentSpanId: root,
      name: "user_turn",
      kind: "turn:human",
      text: "the only thing said",
    }),
    span({
      traceId: REPLAYED,
      spanId: child,
      parentSpanId: root,
      name: "shared-child",
      kind: "model",
    }),
  ];

  beforeAll(async () => {
    await appendSpans(at(acme, SUPPORT), trace());
    // Delivered again, regrouped so that neither block-level shield can absorb
    // it and the identity is the only thing left holding the line.
    for (const one of trace()) await appendSpans(at(acme, SUPPORT), [one]);
  });

  it("is one span in the tree, one turn in the transcript, and one in the count", async () => {
    const detail = await readTrace(at(acme, SUPPORT), REPLAYED, {
      window: WINDOW,
    });

    expect(detail?.spanCount).toBe(3);
    expect(everySpanOf(detail)).toHaveLength(3);
    expect(detail?.turns.map((each) => each.text)).toEqual([
      "the only thing said",
    ]);
    expect(detail?.spans.map((each) => each.name)).toEqual(["agent_session"]);
    expect(detail?.spans[0]?.spans.map((each) => each.name)).toEqual([
      "shared-child",
    ]);
  });

  it("reads the same both times, before and after the parts are merged", async () => {
    const before = await readTrace(at(acme, SUPPORT), REPLAYED, {
      window: WINDOW,
    });
    // What a background merge would do, made to happen now. A read must not
    // depend on whether it already has.
    await store.command("optimize table spans final");
    const after = await readTrace(at(acme, SUPPORT), REPLAYED, {
      window: WINDOW,
    });

    expect(after).toEqual(before);
  });

  it("counts the trace once in the list", async () => {
    const page = await listTraces(at(acme, SUPPORT), { window: WINDOW });
    const listed = page.traces.filter((each) => each.traceId === REPLAYED);

    expect(listed).toHaveLength(1);
    expect(listed[0]?.spanCount).toBe(3);
    expect(listed[0]?.preview).toBe("the only thing said");
  });
});

/**
 * Spans that point at each other, which is what a truncated exporter buffer and
 * a hand-written client both eventually produce.
 *
 * Nobody sends this on purpose, and that is exactly why it is written down: the
 * walk down from the top never arrives at a span whose parent is present, is not
 * a turn, and is not under the root — so a cycle of two would leave the store
 * counting spans the transcript did not show. A response that disagrees with the
 * number printed beside it reads as egma having lost something.
 */
describe("a parent cycle longer than one span", () => {
  const CYCLED = "eeee1111111111111111111111111111";
  const DESCENDED = "ffff1111111111111111111111111111";
  const REUSED_IN_CYCLE = "eded1111111111111111111111111111";

  beforeAll(async () => {
    // Two spans, each naming the other as its parent.
    const first = spanId();
    const second = spanId();
    await appendSpans(at(acme, SUPPORT), [
      span({
        traceId: CYCLED,
        spanId: first,
        parentSpanId: second,
        name: "llm_node",
        kind: "model",
      }),
      span({
        traceId: CYCLED,
        spanId: second,
        parentSpanId: first,
        name: "llm_request",
        kind: "model",
        startedAtMicroseconds: BigInt(WHEN.getTime() + 500) * 1000n,
      }),
    ]);

    // And a root whose parent is one of its own descendants, which is the same
    // knot with a longer loop and a turn hanging off it.
    const root = spanId();
    const turn = spanId();
    const leaf = spanId();
    await appendSpans(at(acme, SUPPORT), [
      span({ traceId: DESCENDED, spanId: root, parentSpanId: leaf }),
      span({
        traceId: DESCENDED,
        spanId: turn,
        parentSpanId: root,
        name: "user_turn",
        kind: "turn:human",
        text: "Anybody there?",
        startedAtMicroseconds: BigInt(WHEN.getTime() + 1000) * 1000n,
      }),
      span({
        traceId: DESCENDED,
        spanId: leaf,
        parentSpanId: root,
        name: "tts_request",
        kind: "tts",
        startedAtMicroseconds: BigInt(WHEN.getTime() + 2000) * 1000n,
      }),
    ]);

    // A later row reuses the root id inside one branch — one batch offering two
    // accounts of one span, which a producer can still send even though nothing
    // downstream will show both. Reaching that row also reaches the root's
    // second child, so a walk that filters all root children before it descends
    // would append that second child twice.
    const repeatedRoot = spanId();
    const firstChild = spanId();
    const secondChild = spanId();
    await appendSpans(at(acme, SUPPORT), [
      span({
        traceId: REUSED_IN_CYCLE,
        spanId: repeatedRoot,
        name: "root-original",
      }),
      span({
        traceId: REUSED_IN_CYCLE,
        spanId: firstChild,
        parentSpanId: repeatedRoot,
        name: "first-child",
        startedAtMicroseconds: BigInt(WHEN.getTime() + 1000) * 1000n,
      }),
      span({
        traceId: REUSED_IN_CYCLE,
        spanId: secondChild,
        parentSpanId: repeatedRoot,
        name: "second-child",
        startedAtMicroseconds: BigInt(WHEN.getTime() + 2000) * 1000n,
      }),
      span({
        traceId: REUSED_IN_CYCLE,
        spanId: repeatedRoot,
        parentSpanId: firstChild,
        name: "root-id-reused-in-cycle",
        startedAtMicroseconds: BigInt(WHEN.getTime() + 3000) * 1000n,
      }),
    ]);
  });

  it("is read back whole rather than vanishing out of the transcript", async () => {
    const detail = await readTrace(at(acme, SUPPORT), CYCLED, {
      window: WINDOW,
    });

    expect(detail?.spanCount).toBe(2);
    expect(everySpanOf(detail).map((each) => each.name).sort()).toEqual([
      "llm_node",
      "llm_request",
    ]);
    // Once each, and not twice: the span reached first is the top of the loop
    // and the other hangs beneath it.
    expect(everySpanOf(detail)).toHaveLength(2);
  });

  it("is read back whole when the loop runs through a descendant too", async () => {
    const detail = await readTrace(at(acme, SUPPORT), DESCENDED, {
      window: WINDOW,
    });

    expect(detail?.spanCount).toBe(3);
    expect(detail?.turns.map((turn) => turn.name)).toEqual(["user_turn"]);
    expect(everySpanOf(detail)).toHaveLength(3);
    expect(everySpanOf(detail).map((each) => each.name).sort()).toEqual([
      "agent_session",
      "tts_request",
      "user_turn",
    ]);
  });

  /**
   * Four rows in, three spans out, and the third is one span rather than two.
   *
   * The two rows sharing an id are two accounts of one immutable span, and the
   * store collapses them onto the identity they both claim — which is why this
   * asserts that the surviving account appears once and deliberately does not
   * assert *which* one survived. Choosing between them is not a read's job and
   * never becomes one: a second, different account is refused before it is
   * written, so a working path never produces this at all.
   *
   * What the walk still owes is the property this case was built for: the
   * second child, reachable both directly and through the knot, appears once.
   */
  it("returns each span once when a cycle also reuses an id", async () => {
    const detail = await readTrace(at(acme, SUPPORT), REUSED_IN_CYCLE, {
      window: WINDOW,
    });

    expect(detail?.spanCount).toBe(3);
    expect(everySpanOf(detail)).toHaveLength(3);

    const names = everySpanOf(detail).map((each) => each.name);
    expect(names.filter((name) => name === "first-child")).toHaveLength(1);
    expect(names.filter((name) => name === "second-child")).toHaveLength(1);
    expect(
      names.filter(
        (name) => name === "root-original" || name === "root-id-reused-in-cycle",
      ),
    ).toHaveLength(1);
  });
});

/**
 * A trace larger than one read returns, which is where the counts and the tree
 * stop being the same thing.
 *
 * The door caps one export at 10,000 spans, so this cannot be reached through
 * it — but a trace is however many exports an agent sent, and nothing stops
 * fifteen of them sharing a trace id. The promise is that the transcript says so
 * and that its numbers stay the trace's own: `spans_truncated` means the tree is
 * a prefix, and `span_count` is still every span the window holds.
 */
describe("a trace with more spans than one read returns", () => {
  const ENORMOUS = "9999111111111111111111111111aaaa";
  const TOTAL = MAXIMUM_SPANS_PER_TRACE + 1;

  beforeAll(async () => {
    const half = Math.ceil(TOTAL / 2);
    const minimal = (index: number): NewSpan =>
      span({
        traceId: ENORMOUS,
        spanId: (0x100000 + index).toString(16).padStart(16, "0"),
        name: "tts_request",
        kind: "tts",
        // Spread across the minute, so time order is a real order.
        startedAtMicroseconds: BigInt(WHEN.getTime() + index) * 1000n,
      });

    const all = Array.from({ length: TOTAL }, (_, index) => minimal(index));
    await appendSpans(at(acme, SUPPORT), all.slice(0, half));
    await appendSpans(at(acme, SUPPORT), all.slice(half));
  });

  it("says the transcript is a prefix, and counts the whole trace anyway", async () => {
    const detail = await readTrace(at(acme, SUPPORT), ENORMOUS, {
      window: WINDOW,
    });

    expect(detail?.truncated).toBe(true);
    // The tree stops at the cap.
    expect(everySpanOf(detail)).toHaveLength(MAXIMUM_SPANS_PER_TRACE);
    // And the counts do not: they are the trace, which is what makes the flag
    // worth reading rather than a warning with nothing behind it.
    expect(detail?.spanCount).toBe(TOTAL);
    // Down to the last span, whose start is what the trace's extent is measured
    // to — and it is past the cap, so a count taken from the rows that fitted
    // would have been short by a second.
    expect(detail?.endedAt).toBe(
      new Date(WHEN.getTime() + TOTAL - 1 + 1000).toISOString().replace("Z", "000Z"),
    );
  });

  it("is the same trace in the list, counted the same way", async () => {
    const list = await listTraces(at(acme, SUPPORT), {
      window: WINDOW,
      limit: 200,
    });
    const listed = list.traces.find((trace) => trace.traceId === ENORMOUS);

    const detail = await readTrace(at(acme, SUPPORT), ENORMOUS, {
      window: WINDOW,
    });
    expect(listed?.spanCount).toBe(detail?.spanCount);
    expect(listed?.startedAt).toBe(detail?.startedAt);
    expect(listed?.endedAt).toBe(detail?.endedAt);
    expect(listed?.durationNanoseconds).toBe(detail?.durationNanoseconds);
  });
});

/**
 * A stored duration larger than the signed arithmetic that reads it.
 *
 * `duration_ns` is a `UInt64` and the aggregate that works out when a trace
 * ended is signed, so a count near 2^64 comes back through `toInt64` negative
 * and the trace ends before it began. The door clamps what it writes at Int64's
 * ceiling; this is the floor under the rows that were written before it did,
 * which is why the row goes in past the door — the door will not produce one any
 * more, and the rows that already exist do not go back through it.
 */
describe("a duration that the reading arithmetic cannot hold", () => {
  const WRAPPED = "7777111111111111111111111111bbbb";
  const LATER = {
    from: microseconds("2026-05-08T00:00:00Z"),
    to: microseconds("2026-05-09T00:00:00Z"),
  };

  beforeAll(async () => {
    await store.append("spans", [
      {
        trace_id: WRAPPED,
        span_id: "00000000000000ff",
        parent_span_id: "",
        organization_id: acme.organizationId,
        project_id: SUPPORT,
        source: "production",
        emitter: "agent",
        environment: "default",
        started_at: "2026-05-08 12:00:00.000000",
        // Everything a UInt64 holds, which is what a wrapped clock writes.
        duration_ns: "18446744073709551615",
        name: "agent_session",
        kind: "root",
        status: "unset",
      },
    ]);
  });

  it("never reads back as a trace that ended before it started", async () => {
    const [trace] = (await listTraces(at(acme, SUPPORT), { window: LATER }))
      .traces;

    expect(trace?.traceId).toBe(WRAPPED);
    expect(BigInt(trace?.durationNanoseconds ?? "-1")).toBeGreaterThanOrEqual(
      0n,
    );
    expect(trace?.endedAt).toBe(trace?.startedAt);
  });
});

/**
 * The reported-measurements block, which is the one thing a read takes off a
 * payload.
 *
 * Everything else about the payload is deliberately not returned — it is the
 * largest column on the row and nothing renders it — so what is asked here is
 * that the exception stays the size it was argued to be: one root row, one
 * egma-owned key, and an answer of `undefined` for every shape that is not a
 * block. Never a throw, because a vendor's bad write must not cost a customer
 * their transcript.
 */
describe("the block a platform reported on the root span", () => {
  const REPORTED = "0a0a1111111111111111111111111111";
  const UNREPORTED = "0b0b1111111111111111111111111111";
  const MALFORMED = "0c0c1111111111111111111111111111";

  /** A root the way a platform normalizer files one: parentless, and carrying
   * the egma-owned corner of an otherwise vendor-owned payload. */
  function aReportedRoot(traceId: string, normalised: unknown): NewSpan {
    return span({
      traceId,
      spanId: spanId(),
      parentSpanId: "",
      name: "retell_call",
      kind: "conversation",
      payload: JSON.stringify({
        call_id: "call_c0ffee",
        recording_url: "https://example.invalid/one.wav",
        egma_normalised: normalised,
      }),
    });
  }

  beforeAll(async () => {
    await appendSpans(at(acme, SUPPORT), [
      aReportedRoot(REPORTED, {
        degraded: false,
        reported_measurements: {
          version: 1,
          reported_by: "retell",
          measurements: [
            {
              measure: "turn_response_latency",
              unit: "milliseconds",
              values: [517, 2145],
            },
          ],
        },
      }),
      // The same payload corner without a block in it, which is every trace
      // filed before a platform reported anything.
      aReportedRoot(UNREPORTED, { degraded: false }),
      // And a block of a version this code has never seen, which is the shape a
      // reader has to be able to tell from a block it simply predates.
      aReportedRoot(MALFORMED, {
        reported_measurements: { version: 99, reported_by: "", measurements: 7 },
      }),
    ]);
  });

  it("is read back with the root span it rode in on", async () => {
    const detail = await readTrace(at(acme, SUPPORT), REPORTED, {
      window: WINDOW,
    });

    expect(detail?.reported).toEqual({
      spanId: detail?.spans[0]?.spanId,
      reportedBy: "retell",
      measurements: [
        {
          measure: "turn_response_latency",
          unit: "milliseconds",
          values: [517, 2145],
        },
      ],
    });
  });

  it("is absent on a root that carries no block, and the trace reads as ever", async () => {
    const detail = await readTrace(at(acme, SUPPORT), UNREPORTED, {
      window: WINDOW,
    });

    expect(detail?.spanCount).toBe(1);
    expect(detail?.reported).toBeUndefined();
  });

  it("is absent rather than fatal when the block is one nothing can read", async () => {
    const detail = await readTrace(at(acme, SUPPORT), MALFORMED, {
      window: WINDOW,
    });

    // The transcript is unharmed, which is the half that was never in doubt.
    expect(detail?.spanCount).toBe(1);
    expect(detail?.reported).toBeUndefined();
  });

  /**
   * The payload itself is still not returned. One key of one row is the whole
   * exception, and a span in the transcript carries no payload at all — which
   * is what keeps a trace read from shipping megabytes of a vendor's own
   * document to a page that renders none of it.
   */
  it("does not put the payload on a span, block or no block", async () => {
    const detail = await readTrace(at(acme, SUPPORT), REPORTED, {
      window: WINDOW,
    });

    for (const each of everySpanOf(detail)) {
      expect(Object.keys(each)).not.toContain("payload");
      expect(JSON.stringify(each)).not.toContain("recording_url");
    }
  });
});

describe("a page token", () => {
  it("survives a round trip and resumes exactly where the page stopped", async () => {
    const context = at(acme, undefined);

    const first = await listTraces(context, { window: WINDOW, limit: 1 });
    expect(first.traces).toHaveLength(1);
    expect(first.nextCursor).toBeDefined();

    const second = await listTraces(context, {
      window: WINDOW,
      limit: 10,
      cursor: first.nextCursor,
    });

    const walked = [
      ...first.traces.map((trace) => trace.traceId),
      ...second.traces.map((trace) => trace.traceId),
    ];
    expect(new Set(walked).size).toBe(walked.length);

    const whole = await listTraces(context, { window: WINDOW, limit: 100 });
    expect(walked).toEqual(whole.traces.map((trace) => trace.traceId));
    expect(second.nextCursor).toBeUndefined();
  });

  it("is refused when it is not one this list issued", async () => {
    await expect(
      listTraces(at(acme, SUPPORT), { window: WINDOW, cursor: "nonsense" }),
    ).rejects.toThrow(UnreadableTraceQueryError);
  });
});
