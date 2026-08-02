import {
  appendSpans,
  connectClickHouse,
  disconnectClickHouse,
  listTraces,
  MAXIMUM_WINDOW_MILLISECONDS,
  permits,
  readTrace,
  ROLES,
  UnreadableTraceQueryError,
  type AuthContext,
  type NewSpan,
  type Role,
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

const OUTBOUND = newId("prj");
const SUPPORT = newId("prj");

/** The minute everything in this file happened in, and a window around it. */
const WHEN = new Date("2026-05-04T12:00:00Z");
const WINDOW = {
  from: new Date("2026-05-04T00:00:00Z"),
  to: new Date("2026-05-05T00:00:00Z"),
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
    connectionType: "livekit",
    audioSampleRateHz: 0,
    audioEncoding: "",
    runId: "",
    agentId: "",
    agentVersionId: "",
    testVersionId: "",
    digitalHumanVersionId: "",
    payload: "{}",
    ...overrides,
  };
}

/** A root, one human turn under it, and one step under the turn. */
function aConversation(traceId: string): NewSpan[] {
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

  await appendSpans(at(acme, SUPPORT), aConversation(ACME_TRACE));
  await appendSpans(at(acme, OUTBOUND), aConversation(OUTBOUND_TRACE));
  await appendSpans(at(globex, SUPPORT), aConversation(GLOBEX_TRACE));
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

describe("the project on a read", () => {
  it("is the whole customer when the credential names none", async () => {
    const list = await listTraces(at(acme, undefined), { window: WINDOW });
    expect(list.traces.map((trace) => trace.traceId).sort()).toEqual(
      [ACME_TRACE, OUTBOUND_TRACE].sort(),
    );
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
      from: new Date(WHEN.getTime() - MAXIMUM_WINDOW_MILLISECONDS - 1),
      to: new Date(WHEN.getTime()),
    };
    await expect(
      listTraces(at(acme, SUPPORT), { window: tooWide }),
    ).rejects.toThrow(UnreadableTraceQueryError);
    await expect(
      readTrace(at(acme, SUPPORT), ACME_TRACE, { window: tooWide }),
    ).rejects.toThrow(UnreadableTraceQueryError);
  });

  it("is refused when it ends before it starts, or is not a time at all", async () => {
    await expect(
      listTraces(at(acme, SUPPORT), {
        window: { from: WINDOW.to, to: WINDOW.from },
      }),
    ).rejects.toThrow(UnreadableTraceQueryError);

    await expect(
      listTraces(at(acme, SUPPORT), {
        window: { from: new Date("not a time"), to: WINDOW.to },
      }),
    ).rejects.toThrow(UnreadableTraceQueryError);
  });

  /** A trace outside the window is not there, which is the same as not existing. */
  it("decides whether a trace is there at all", async () => {
    const elsewhere = {
      from: new Date("2026-05-06T00:00:00Z"),
      to: new Date("2026-05-07T00:00:00Z"),
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
