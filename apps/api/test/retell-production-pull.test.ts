import {
  claimDueMonitoringPull,
  claimProductionTrace,
  connectClickHouse,
  createAgent,
  disablePullProductionCalls,
  disconnectClickHouse,
  enablePullProductionCalls,
  finishProductionTrace,
  listMonitoringFailures,
  listTraces,
  readTrace,
  recordPulledCallReceived,
  sweepStaleProductionClaims,
  type AgentPlatform,
  type AuthContext,
} from "@egma/db";
import { newId } from "@egma/ids";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  replayRetellIngestionFailure,
  runRetellProductionIngestion,
  type RetellProductionIngestionLog,
  type RetellProductionIngestionResult,
  type RetellProductionWriter,
} from "../src/retell-production-ingestion.ts";
import type { RetellCall } from "../src/retell/normalise.ts";
import {
  replayProductionClaim,
  writeRetellCall,
  type RetellProductionWriteStore,
} from "../src/retell/write.ts";
import {
  createConnectedDatabase,
  type MigratedDatabase,
} from "../../../packages/db/test/support/database.ts";
import { createMigratedTraceStore } from "../../../packages/db/test/support/clickhouse.ts";
import {
  seedOrganization,
  seedUser,
} from "../../../packages/db/test/support/tenancy.ts";

/**
 * The poller against the real notebook.
 *
 * The other production-ingestion file drives the loop over a fake store, which
 * is the right shape for asking what the loop decides. This file asks the
 * question that fake cannot answer: whether the decisions survive Postgres —
 * the lease under a real race, the cursor across a killed turn, the retry clock
 * on five separate rows, the poison-call record, and the claim ledger absorbing
 * a re-offered boundary.
 *
 * So the store is real and the provider is not: Retell answers over a fake
 * `fetch`, through egma's own adapter, so the request bodies and the paging
 * contract are the product's. The trace store is the one thing stubbed — the
 * span block belongs to ClickHouse and none of the claims here are about it,
 * while every claim here is about a Postgres row.
 */

let database: MigratedDatabase;

const acme = { organization: newId("org"), project: newId("prj") };
const ada = newId("usr");

const RETELL_URL = "http://retell.test";
const RETELL_KEY = "key_live_retell_pull_proof_ABCD";
const NOW = new Date("2026-08-21T09:00:00.000Z");
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const THIRTY_DAYS = 30 * DAY;
const FIVE_MINUTES = 5 * MINUTE;

function at(role: "admin" | "member" = "admin"): AuthContext {
  return {
    userId: ada,
    organizationId: acme.organization,
    projectId: acme.project,
    role,
    via: "session",
  };
}

function later(milliseconds: number): Date {
  return new Date(NOW.getTime() + milliseconds);
}

/** One agent bound to its platform, with its own sealed key and its switch on. */
async function pulling(
  name: string,
  platformAgentId: string,
  options: {
    readonly now?: Date | undefined;
    readonly agentPlatform?: AgentPlatform | undefined;
  } = {},
): Promise<string> {
  const created = await createAgent(at(), { name });
  await enablePullProductionCalls(at(), {
    agentId: created.id,
    agentPlatform: options.agentPlatform ?? "retell",
    platformAgentId,
    apiKey: RETELL_KEY,
    now: options.now ?? NOW,
  });
  return created.id;
}

function retellCall(
  callId: string,
  platformAgentId: string,
  endedAt: Date,
): RetellCall {
  return {
    call_id: callId,
    agent_id: platformAgentId,
    agent_name: "Front desk",
    call_status: "ended",
    call_type: "phone_call",
    start_timestamp: endedAt.getTime() - 30_000,
    end_timestamp: endedAt.getTime(),
    // With word timings, because a transcript's order has to be a reported
    // fact here rather than a tie-break: two turns Retell timed identically are
    // indistinguishable to a trace read, and the one case that reads spans back
    // asks for them in order.
    transcript_with_tool_calls: [
      {
        role: "agent",
        content: "Hello",
        words: [{ word: "Hello", start: 0.1, end: 0.6 }],
      },
      {
        role: "user",
        content: "I need help",
        words: [{ word: "I need help", start: 1.2, end: 2.4 }],
      },
    ],
  };
}

/** A v3 list row carries no transcript. Only the full document does. */
function listRow(call: RetellCall): Record<string, unknown> {
  const row: Record<string, unknown> = { ...call };
  delete row["transcript_with_tool_calls"];
  return row;
}

type ListRequest = {
  readonly platformAgentId: string;
  readonly from: number;
  readonly to: number;
  readonly paginationKey: string | undefined;
};

type ListBody = {
  readonly filter_criteria?: {
    readonly agent?: readonly { readonly agent_id?: string }[];
    readonly end_timestamp?: { readonly value?: readonly number[] };
  };
  readonly pagination_key?: string;
};

/**
 * Retell, answering over `fetch`.
 *
 * The cursor it hands out is the index of the next unread row, which is opaque
 * to egma exactly as Retell's own is: the poller may only follow it or refuse
 * it. Pages come back oldest-first with an inclusive lower bound, because that
 * is what the real v3 list does and what makes the overlap re-offer happen.
 */
function retellDouble() {
  const state = {
    listRequests: [] as ListRequest[],
    getRequests: [] as string[],
    /** Every terminal call the account holds, by platform agent id. */
    account: new Map<string, RetellCall[]>(),
    /** A forced HTTP status for one agent's list page. */
    listRefuses: new Map<string, number>(),
    /** The `Retry-After` header that refusal carries, verbatim. */
    listRetryAfter: new Map<string, string>(),
    /** Claims another page and names no cursor: a broken paging contract. */
    breaksPaging: false,
    /** A forced HTTP status for one call's full document. */
    getRefuses: new Map<string, number>(),
    pageSize: 100,
  };

  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const path = new URL(String(input)).pathname;

    if (path === "/v3/list-calls") {
      const body = JSON.parse(String(init?.body ?? "{}")) as ListBody;
      const platformAgentId =
        body.filter_criteria?.agent?.[0]?.agent_id ?? "";
      const window = body.filter_criteria?.end_timestamp?.value ?? [0, 0];
      const from = window[0] ?? 0;
      const to = window[1] ?? 0;
      state.listRequests.push({
        platformAgentId,
        from,
        to,
        paginationKey: body.pagination_key,
      });
      const refused = state.listRefuses.get(platformAgentId);
      if (refused !== undefined) {
        const retryAfter = state.listRetryAfter.get(platformAgentId);
        return new Response("refused", {
          status: refused,
          ...(retryAfter === undefined
            ? {}
            : { headers: { "retry-after": retryAfter } }),
        });
      }
      if (state.breaksPaging) {
        return new Response(JSON.stringify({ items: [], has_more: true }), {
          status: 200,
        });
      }
      const inWindow = (state.account.get(platformAgentId) ?? [])
        .filter((call) => {
          const endedAt = Number(call["end_timestamp"]);
          return endedAt >= from && endedAt <= to;
        })
        .sort(
          (left, right) =>
            Number(left["end_timestamp"]) - Number(right["end_timestamp"]),
        );
      const start = Number(body.pagination_key ?? "0");
      const page = inWindow.slice(start, start + state.pageSize);
      const hasMore = start + page.length < inWindow.length;
      return new Response(
        JSON.stringify({
          items: page.map(listRow),
          has_more: hasMore,
          ...(hasMore ? { pagination_key: String(start + page.length) } : {}),
        }),
        { status: 200 },
      );
    }

    if (path.startsWith("/v2/get-call/")) {
      const callId = decodeURIComponent(path.slice("/v2/get-call/".length));
      state.getRequests.push(callId);
      const refused = state.getRefuses.get(callId);
      if (refused !== undefined) {
        return new Response("refused", { status: refused });
      }
      for (const calls of state.account.values()) {
        const found = calls.find((call) => call["call_id"] === callId);
        if (found !== undefined) {
          return new Response(JSON.stringify(found), { status: 200 });
        }
      }
      return new Response("not found", { status: 404 });
    }

    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  return Object.assign(state, { fetchImpl });
}

type RetellDouble = ReturnType<typeof retellDouble>;

function holds(double: RetellDouble, ...calls: readonly RetellCall[]): void {
  for (const call of calls) {
    const platformAgentId = String(call["agent_id"]);
    const held = double.account.get(platformAgentId) ?? [];
    double.account.set(platformAgentId, [...held, call]);
  }
}

function collectingLog(): {
  readonly log: RetellProductionIngestionLog;
  readonly events: Record<string, unknown>[];
} {
  const events: Record<string, unknown>[] = [];
  return {
    events,
    log: {
      info: (event) => events.push(event),
      warn: (event) => events.push(event),
      error: (event) => events.push(event),
    },
  };
}

/**
 * The real write protocol with only ClickHouse stubbed.
 *
 * `claimProductionTrace` and `finishProductionTrace` are the receipt book, and
 * they are the whole point of this file's duplicate claims — so they are the
 * real ones, against the real table.
 */
function realLedgerWriter(spans: unknown[]): RetellProductionWriter {
  const stores: RetellProductionWriteStore = {
    claimProductionTrace,
    finishProductionTrace,
    recordPulledCallReceived,
    async appendSpans(_auth, written) {
      spans.push(...written);
      return { appended: written.length, batches: 1 };
    },
    async recordProductionTraces() {
      // ClickHouse's grading queue. Nothing here is a claim about it.
    },
  };
  return {
    writeRetellCall: (target, call, receivedAt) =>
      writeRetellCall(target, call, receivedAt, stores),
    replayProductionClaim: (claim) => replayProductionClaim(claim, stores),
  };
}

type PollOptions = {
  readonly now?: Date | undefined;
  readonly maxPagesPerTurn?: number | undefined;
  readonly log?: RetellProductionIngestionLog | undefined;
};

async function poll(
  double: RetellDouble,
  options: PollOptions = {},
): Promise<RetellProductionIngestionResult> {
  return runRetellProductionIngestion({
    log: options.log ?? collectingLog().log,
    reach: { url: RETELL_URL, fetchImpl: double.fetchImpl },
    writer: realLedgerWriter([]),
    clock: () => options.now ?? NOW,
    ...(options.maxPagesPerTurn === undefined
      ? {}
      : { maxPagesPerTurn: options.maxPagesPerTurn }),
  });
}

/** Every due agent, exactly as one standing tick drains them. */
async function drain(
  double: RetellDouble,
  options: PollOptions = {},
): Promise<RetellProductionIngestionResult[]> {
  const turns: RetellProductionIngestionResult[] = [];
  let turn: RetellProductionIngestionResult;
  do {
    turn = await poll(double, options);
    turns.push(turn);
  } while (turn.targetClaimed);
  return turns;
}

type NotebookRow = {
  scan_kind: string | null;
  scan_from: Date | null;
  scan_through: Date | null;
  pagination_key: string | null;
  completed_through: Date | null;
  next_poll_at: Date;
  next_regular_poll_at: Date;
  reconciliation_from: Date | null;
  reconciliation_through: Date | null;
  reconciliation_pagination_key: string | null;
  reconciliation_needs_regular: boolean;
  lease_owner: string | null;
  consecutive_failures: number;
  last_received_at: Date | null;
  agent_id: string;
};

async function notebooks(): Promise<NotebookRow[]> {
  const { rows } = await database.sql<NotebookRow>(
    "select * from monitoring_state order by agent_id",
  );
  return rows;
}

async function notebook(): Promise<NotebookRow> {
  const [row] = await notebooks();
  if (row === undefined) throw new Error("no notebook was opened");
  return row;
}

async function ledger(): Promise<
  { provider_call_id: string; status: string }[]
> {
  const { rows } = await database.sql<{
    provider_call_id: string;
    status: string;
  }>(
    "select provider_call_id, status from production_trace_claim " +
      "order by provider_call_id",
  );
  return rows;
}

beforeAll(async () => {
  database = await createConnectedDatabase("retell_production_pull");
  await seedOrganization(database, acme.organization, [
    { id: acme.project, slug: "default" },
  ]);
  await seedUser(database, ada, "ada@acme.example");
});

beforeEach(async () => {
  await database.sql(
    "truncate monitoring_failure, production_trace_claim, " +
      "monitoring_state, connection, agent cascade",
  );
});

afterAll(async () => {
  await database.drop();
});

describe("the first switch-on", () => {
  it("walks the thirty days behind it and stamps what it covered", async () => {
    const double = retellDouble();
    await pulling("Front desk", "agent_voice_1");
    holds(
      double,
      retellCall("call_ten_days_ago", "agent_voice_1", later(-10 * DAY)),
      retellCall("call_one_minute_ago", "agent_voice_1", later(-MINUTE)),
      retellCall("call_forty_days_ago", "agent_voice_1", later(-40 * DAY)),
    );

    const turn = await poll(double);

    expect(turn).toMatchObject({ targetClaimed: true, written: 2, already: 0 });
    expect(double.listRequests).toEqual([
      {
        platformAgentId: "agent_voice_1",
        from: NOW.getTime() - THIRTY_DAYS,
        to: NOW.getTime(),
        paginationKey: undefined,
      },
    ]);
    expect((await ledger()).map((row) => row.provider_call_id)).toEqual([
      "call_one_minute_ago",
      "call_ten_days_ago",
    ]);
    expect((await ledger()).every((row) => row.status === "written")).toBe(true);

    const row = await notebook();
    expect(row.scan_kind).toBeNull();
    expect(row.lease_owner).toBeNull();
    expect(row.consecutive_failures).toBe(0);
    expect(row.completed_through?.toISOString()).toBe(NOW.toISOString());
    expect(row.last_received_at).not.toBeNull();
  });

  it("re-offers the five-minute boundary, and the ledger absorbs it", async () => {
    const double = retellDouble();
    await pulling("Front desk", "agent_voice_1");
    holds(
      double,
      retellCall("call_one_minute_ago", "agent_voice_1", later(-MINUTE)),
    );
    await poll(double);

    const nextTurn = later(60_000);
    const turn = await poll(double, { now: nextTurn });

    // The regular window deliberately starts before the last completed scan
    // ended, so a conversation that landed on the boundary is asked for twice.
    expect(double.listRequests[1]).toEqual({
      platformAgentId: "agent_voice_1",
      from: NOW.getTime() - FIVE_MINUTES,
      to: nextTurn.getTime(),
      paginationKey: undefined,
    });
    expect(turn).toMatchObject({ written: 0, already: 1 });
    // The receipt book owned it the first time, so the second offer costs no
    // provider request at all and writes no second row.
    expect(double.getRequests).toEqual(["call_one_minute_ago"]);
    expect(await ledger()).toEqual([
      { provider_call_id: "call_one_minute_ago", status: "written" },
    ]);
  });

  it("keeps the daily re-walk waiting while regular work runs", async () => {
    const double = retellDouble();
    const agentId = await pulling("Front desk", "agent_voice_1");
    holds(
      double,
      retellCall("call_a", "agent_voice_1", later(-20 * DAY)),
      retellCall("call_b", "agent_voice_1", later(-10 * DAY)),
    );
    await poll(double);

    // A day passes and the re-walk falls due.
    double.pageSize = 1;
    // Regular polling wins whenever it is due, so a re-walk can only start in
    // the gap between two regular turns. That is the whole yielding rule.
    await database.sql(
      `update monitoring_state set next_reconciliation_at = $1, ` +
        `next_poll_at = $1, next_regular_poll_at = $2 where agent_id = $3`,
      [
        later(DAY).toISOString(),
        later(DAY + 20_000).toISOString(),
        agentId,
      ],
    );
    const dueAt = later(DAY);

    const walk = await poll(double, { now: dueAt, maxPagesPerTurn: 1 });
    expect(walk.stoppedBecause).toBe("bounded_turn");
    expect(double.listRequests[1]).toMatchObject({
      from: dueAt.getTime() - THIRTY_DAYS,
      to: dueAt.getTime(),
    });

    // Its fixed window is parked whole, and the clock hands the turn back to
    // regular polling rather than to the re-walk's own next slice.
    const paused = await notebook();
    expect(paused.scan_kind).toBeNull();
    expect(paused.reconciliation_needs_regular).toBe(true);
    expect(paused.reconciliation_from?.getTime()).toBe(
      dueAt.getTime() - THIRTY_DAYS,
    );
    expect(paused.reconciliation_pagination_key).toBe("1");
    expect(paused.next_poll_at.toISOString()).toBe(
      paused.next_regular_poll_at.toISOString(),
    );

    const regular = await poll(double, { now: later(DAY + MINUTE) });
    expect(regular.stoppedBecause).toBeUndefined();
    expect(double.listRequests[2]).toMatchObject({
      from: NOW.getTime() - FIVE_MINUTES,
      to: later(DAY + MINUTE).getTime(),
    });

    // Regular work is done, so the parked re-walk is due again at once and
    // resumes on the exact window and cursor it was holding.
    const resumable = await notebook();
    expect(resumable.reconciliation_needs_regular).toBe(false);
    expect(resumable.next_poll_at.toISOString()).toBe(
      later(DAY + MINUTE).toISOString(),
    );

    await poll(double, { now: later(DAY + 61_000), maxPagesPerTurn: 1 });
    expect(double.listRequests[3]).toMatchObject({
      from: dueAt.getTime() - THIRTY_DAYS,
      to: dueAt.getTime(),
      paginationKey: "1",
    });
    expect(await ledger()).toHaveLength(2);
  });
});

describe("two API replicas", () => {
  it("never poll one agent at the same time", async () => {
    const double = retellDouble();
    await pulling("Front desk", "agent_voice_1");
    holds(double, retellCall("call_1", "agent_voice_1", later(-MINUTE)));

    const [left, right] = await Promise.all([poll(double), poll(double)]);

    expect([left.targetClaimed, right.targetClaimed].filter(Boolean)).toEqual([
      true,
    ]);
    expect(double.listRequests).toHaveLength(1);
    expect(await ledger()).toHaveLength(1);
  });

  it("cannot both hold the lease, whichever wins the race", async () => {
    await pulling("Front desk", "agent_voice_1");

    const claimed = await Promise.all([
      claimDueMonitoringPull({ now: NOW }),
      claimDueMonitoringPull({ now: NOW }),
      claimDueMonitoringPull({ now: NOW }),
    ]);

    expect(claimed.filter((one) => one !== undefined)).toHaveLength(1);
    const row = await notebook();
    expect(row.lease_owner).not.toBeNull();
  });
});

describe("a killed turn", () => {
  it("resumes from the cursor it reached, with no gaps and no duplicates", async () => {
    const double = retellDouble();
    double.pageSize = 1;
    await pulling("Front desk", "agent_voice_1");
    holds(
      double,
      retellCall("call_1", "agent_voice_1", later(-3 * MINUTE)),
      retellCall("call_2", "agent_voice_1", later(-2 * MINUTE)),
      retellCall("call_3", "agent_voice_1", later(-MINUTE)),
    );

    const first = await poll(double, { maxPagesPerTurn: 1 });
    expect(first).toMatchObject({ written: 1, stoppedBecause: "bounded_turn" });

    // The process dies holding a lease: nothing is released, nothing is
    // finished, and the next replica has to wait the lease out.
    const dying = await claimDueMonitoringPull({
      now: later(60_000),
      leaseMilliseconds: 1,
    });
    expect(dying).toMatchObject({
      scanKind: "historical_import",
      paginationKey: "1",
      scanFrom: new Date(NOW.getTime() - THIRTY_DAYS),
      scanThrough: NOW,
    });
    expect(
      await claimDueMonitoringPull({ now: later(60_000) }),
    ).toBeUndefined();

    const second = await poll(double, { now: later(120_000) });
    expect(second).toMatchObject({ written: 2, already: 0 });
    // The window it finished is the one it started, not the one the clock has
    // moved to. That is what stops the resume from stepping over a call.
    const row = await notebook();
    expect(row.completed_through?.toISOString()).toBe(NOW.toISOString());
    expect((await ledger()).map((one) => one.provider_call_id)).toEqual([
      "call_1",
      "call_2",
      "call_3",
    ]);

    const regular = await poll(double, { now: later(180_000) });
    expect(regular).toMatchObject({ written: 0 });
    expect(double.listRequests.at(-1)).toMatchObject({
      from: NOW.getTime() - FIVE_MINUTES,
    });
    expect(await ledger()).toHaveLength(3);
  });
});

describe("a refused key", () => {
  it("backs five agents off separately, and makes no storm", async () => {
    const double = retellDouble();
    const dead = ["agent_1", "agent_2", "agent_3", "agent_4", "agent_5"];
    for (const [index, platformAgentId] of dead.entries()) {
      await pulling(`Agent ${String(index)}`, platformAgentId);
      double.listRefuses.set(platformAgentId, 401);
    }
    const collected = collectingLog();

    const turns = await drain(double, { log: collected.log });

    expect(turns.filter((turn) => turn.targetClaimed)).toHaveLength(5);
    expect(double.listRequests).toHaveLength(5);
    const first = await notebooks();
    expect(first.map((row) => row.consecutive_failures)).toEqual([
      1, 1, 1, 1, 1,
    ]);
    for (const row of first) {
      const waited = row.next_poll_at.getTime() - NOW.getTime();
      expect(waited).toBeGreaterThanOrEqual(4_000);
      expect(waited).toBeLessThanOrEqual(6_000);
    }
    // Five sealed copies of one key are unrecognizable as the same key, so
    // five agents discover the refusal separately — and then wait separately.
    expect(new Set(first.map((row) => row.next_poll_at.getTime())).size)
      .toBeGreaterThan(1);
    expect(JSON.stringify(collected.events)).not.toContain(RETELL_KEY);

    // Nothing is due while they wait, so the dead key costs no second request.
    await drain(double, { now: later(1_000) });
    expect(double.listRequests).toHaveLength(5);

    // The ladder is exponential and per agent: the second wait is the double
    // of the first, on each agent's own row.
    const secondTurn = later(6_000);
    await drain(double, { now: secondTurn });
    expect(double.listRequests).toHaveLength(10);
    const second = await notebooks();
    expect(second.map((row) => row.consecutive_failures)).toEqual([
      2, 2, 2, 2, 2,
    ]);
    for (const row of second) {
      const waited = row.next_poll_at.getTime() - secondTurn.getTime();
      expect(waited).toBeGreaterThanOrEqual(8_000);
      expect(waited).toBeLessThanOrEqual(12_000);
    }

    // One customer fixes one key. That agent recovers; the other four do not.
    double.listRefuses.delete("agent_3");
    const thirdTurn = later(30_000);
    await drain(double, { now: thirdTurn });
    const third = await notebooks();
    const recovered = third.filter((row) => row.consecutive_failures === 0);
    expect(recovered).toHaveLength(1);
    expect(third.filter((row) => row.consecutive_failures === 3)).toHaveLength(
      4,
    );
  });

  it("waits longer than a passing outage, and still only waits", async () => {
    const double = retellDouble();
    const agentId = await pulling("Front desk", "agent_voice_1");
    double.listRefuses.set("agent_voice_1", 401);
    await database.sql(
      "update monitoring_state set consecutive_failures = 30 where agent_id = $1",
      [agentId],
    );

    await poll(double);

    const refused = await notebook();
    const waited = refused.next_poll_at.getTime() - NOW.getTime();
    expect(waited).toBeGreaterThan(5 * MINUTE);
    expect(waited).toBeLessThanOrEqual(60 * MINUTE);

    // A provider that is merely down keeps the five-minute ceiling.
    double.listRefuses.set("agent_voice_1", 503);
    await database.sql(
      "update monitoring_state set consecutive_failures = 30, " +
        "next_poll_at = $1 where agent_id = $2",
      [later(2 * 60 * MINUTE).toISOString(), agentId],
    );
    const outageTurn = later(2 * 60 * MINUTE);
    await poll(double, { now: outageTurn });

    const down = await notebook();
    const outageWait = down.next_poll_at.getTime() - outageTurn.getTime();
    expect(outageWait).toBeGreaterThan(0);
    expect(outageWait).toBeLessThanOrEqual(5 * MINUTE);
  });
});

describe("a poison call", () => {
  it("is recorded after bounded retries, and the cursor moves past it", async () => {
    const double = retellDouble();
    const agentId = await pulling("Front desk", "agent_voice_1");
    holds(
      double,
      retellCall("call_broken", "agent_voice_1", later(-2 * MINUTE)),
      retellCall("call_good", "agent_voice_1", later(-MINUTE)),
    );
    double.getRefuses.set("call_broken", 404);

    const turn = await poll(double);

    expect(turn).toMatchObject({ written: 1, permanentFailures: 1 });
    expect(
      double.getRequests.filter((one) => one === "call_broken"),
    ).toHaveLength(3);
    const [failure] = await listMonitoringFailures(at(), agentId);
    expect(failure).toMatchObject({
      providerCallId: "call_broken",
      errorKind: "provider_call_not_found",
      attempts: 1,
      status: "open",
    });
    // The scan finished rather than stalling on the broken document, and the
    // good call behind it is in the receipt book.
    const row = await notebook();
    expect(row.scan_kind).toBeNull();
    expect(row.completed_through?.toISOString()).toBe(NOW.toISOString());
    expect((await ledger()).map((one) => one.provider_call_id)).toEqual([
      "call_good",
    ]);
  });

  it("is imported by an explicit replay once the provider can answer", async () => {
    const double = retellDouble();
    const agentId = await pulling("Front desk", "agent_voice_1");
    holds(
      double,
      retellCall("call_broken", "agent_voice_1", later(-2 * MINUTE)),
    );
    double.getRefuses.set("call_broken", 404);
    await poll(double);
    const [failure] = await listMonitoringFailures(at(), agentId);
    expect(failure).toBeDefined();

    double.getRefuses.delete("call_broken");
    const replayed = await replayRetellIngestionFailure({
      auth: at(),
      failureId: failure?.id ?? "",
      log: collectingLog().log,
      reach: { url: RETELL_URL, fetchImpl: double.fetchImpl },
      writer: realLedgerWriter([]),
      clock: () => later(MINUTE),
    });

    expect(replayed).toMatchObject({
      kind: "resolved",
      write: "written",
      agentRecovered: true,
    });
    expect(await listMonitoringFailures(at(), agentId)).toHaveLength(0);
    expect(await ledger()).toEqual([
      { provider_call_id: "call_broken", status: "written" },
    ]);
  });

  it("refuses an explicit replay while that agent is backing off", async () => {
    const double = retellDouble();
    const agentId = await pulling("Front desk", "agent_voice_1");
    holds(
      double,
      retellCall("call_broken", "agent_voice_1", later(-2 * MINUTE)),
    );
    double.getRefuses.set("call_broken", 404);
    await poll(double);
    const [failure] = await listMonitoringFailures(at(), agentId);

    // What a refused provider turn leaves behind on this agent alone.
    double.listRefuses.set("agent_voice_1", 401);
    await database.sql(
      "update monitoring_state set next_poll_at = $1 where agent_id = $2",
      [later(MINUTE).toISOString(), agentId],
    );
    await poll(double, { now: later(MINUTE) });

    const refused = await replayRetellIngestionFailure({
      auth: at(),
      failureId: failure?.id ?? "",
      log: collectingLog().log,
      reach: { url: RETELL_URL, fetchImpl: double.fetchImpl },
      writer: realLedgerWriter([]),
      clock: () => later(MINUTE + 1_000),
    });

    expect(refused).toMatchObject({ kind: "busy", reason: "backing_off" });
    expect(await listMonitoringFailures(at(), agentId)).toHaveLength(1);
  });
});

describe("a stale claim's stamp", () => {
  it("lands on the agent that pulled the call, not on its replacement", async () => {
    const double = retellDouble();
    const pulled = await pulling("Front desk", "agent_voice_1");
    holds(double, retellCall("call_live", "agent_voice_1", later(-MINUTE)));

    // The turn dies between Postgres and ClickHouse. The claim is owned and
    // never marked written, which is the whole reason the sweep exists.
    const crashing: RetellProductionWriteStore = {
      claimProductionTrace,
      finishProductionTrace,
      recordPulledCallReceived,
      async appendSpans() {
        throw new Error("the trace store went away mid-write");
      },
      async recordProductionTraces() {
        // Never reached: the span block is what failed.
      },
    };
    await expect(
      runRetellProductionIngestion({
        log: collectingLog().log,
        reach: { url: RETELL_URL, fetchImpl: double.fetchImpl },
        writer: {
          writeRetellCall: (target, call, receivedAt) =>
            writeRetellCall(target, call, receivedAt, crashing),
          replayProductionClaim: (claim) =>
            replayProductionClaim(claim, crashing),
        },
        clock: () => NOW,
      }),
    ).rejects.toThrow("the trace store went away mid-write");

    // The customer moves the platform agent onto a fresh egma agent. The
    // switched-off original keeps its notebook, and the partial unique index
    // allows the replacement to name the same platform agent.
    await disablePullProductionCalls(at(), pulled);
    const replacement = await pulling("Front desk, again", "agent_voice_1");

    // Crash recovery, on the real clock the claim was written against.
    const stale = await sweepStaleProductionClaims({
      now: new Date(Date.now() + 5 * MINUTE),
    });
    expect(stale).toHaveLength(1);
    for (const claim of stale) {
      await replayProductionClaim(claim, {
        claimProductionTrace,
        finishProductionTrace,
        recordPulledCallReceived,
        async appendSpans(_auth, written) {
          return { appended: written.length, batches: 1 };
        },
        async recordProductionTraces() {
          // ClickHouse's grading queue. Not what this case is about.
        },
      });
    }

    const stamped = new Map(
      (await notebooks()).map((row) => [row.agent_id, row.last_received_at]),
    );
    expect(stamped.get(pulled)).not.toBeNull();
    expect(stamped.get(replacement)).toBeNull();
    expect(await ledger()).toEqual([
      { provider_call_id: "call_live", status: "written" },
    ]);
  });
});

describe("a broken page contract", () => {
  it("does not close the explicit-replay gate, however often it repeats", async () => {
    const double = retellDouble();
    const agentId = await pulling("Front desk", "agent_voice_1");
    holds(
      double,
      retellCall("call_broken", "agent_voice_1", later(-2 * MINUTE)),
    );
    double.getRefuses.set("call_broken", 404);
    await poll(double);
    const [failure] = await listMonitoringFailures(at(), agentId);
    expect(failure).toBeDefined();

    // Retell claims another page and names no cursor. That is a broken
    // contract, not a refusal: it says nothing about whether this agent's key
    // still works, so it must not climb the retry clock.
    double.breaksPaging = true;
    await poll(double, { now: later(60_000) });
    expect((await notebook()).consecutive_failures).toBe(0);

    const asked = await replayRetellIngestionFailure({
      auth: at(),
      failureId: failure?.id ?? "",
      log: collectingLog().log,
      reach: { url: RETELL_URL, fetchImpl: double.fetchImpl },
      writer: realLedgerWriter([]),
      clock: () => later(61_000),
    });
    expect(asked.kind).toBe("still_failed");

    // It keeps breaking. Only a finished scan clears the streak, so a streak
    // taken here would hold the gate shut for as long as the breach lasts.
    await poll(double, { now: later(120_000) });
    await poll(double, { now: later(180_000) });
    expect((await notebook()).consecutive_failures).toBe(0);

    double.getRefuses.delete("call_broken");
    const resolved = await replayRetellIngestionFailure({
      auth: at(),
      failureId: failure?.id ?? "",
      log: collectingLog().log,
      reach: { url: RETELL_URL, fetchImpl: double.fetchImpl },
      writer: realLedgerWriter([]),
      clock: () => later(181_000),
    });
    expect(resolved).toMatchObject({ kind: "resolved", write: "written" });
    expect(await listMonitoringFailures(at(), agentId)).toHaveLength(0);
  });
});

describe("a rate limit", () => {
  it("is honoured as asked, and held to the same ceiling when absurd", async () => {
    const double = retellDouble();
    const agentId = await pulling("Front desk", "agent_voice_1");
    double.listRefuses.set("agent_voice_1", 429);
    double.listRetryAfter.set("agent_voice_1", "12");

    await poll(double);
    expect((await notebook()).next_poll_at.toISOString()).toBe(
      later(12_000).toISOString(),
    );

    // A hundred years, in seconds. Hostile or a units mistake, it must not be
    // able to retire the agent or hold its replay gate shut for the same span.
    double.listRetryAfter.set("agent_voice_1", "3153600000");
    await database.sql(
      "update monitoring_state set next_poll_at = $1 where agent_id = $2",
      [later(MINUTE).toISOString(), agentId],
    );
    const absurdTurn = later(MINUTE);
    await poll(double, { now: absurdTurn });

    const waited =
      (await notebook()).next_poll_at.getTime() - absurdTurn.getTime();
    expect(waited).toBeGreaterThan(0);
    expect(waited).toBeLessThanOrEqual(60 * MINUTE);
  });
});

describe("a pulled call", () => {
  it("is readable through the trace reads", async () => {
    // The one case that runs the whole way into ClickHouse. Everything else in
    // this file is a claim about a Postgres row, and stubs the span block; this
    // is the claim that a Retell call that ended after the switch went on can
    // actually be read back as a trace.
    const traces = await createMigratedTraceStore("retell_production_pull");
    connectClickHouse({ clickhouseUrl: traces.url, maxOpenConnections: 4 });
    try {
      const double = retellDouble();
      await pulling("Front desk", "agent_voice_1");
      holds(double, retellCall("call_live", "agent_voice_1", later(-MINUTE)));

      // No writer seam at all: the real one, all the way through.
      const turn = await runRetellProductionIngestion({
        log: collectingLog().log,
        reach: { url: RETELL_URL, fetchImpl: double.fetchImpl },
        clock: () => NOW,
      });
      expect(turn).toMatchObject({ written: 1 });

      const window = {
        from: BigInt(NOW.getTime() - DAY) * 1_000n,
        to: BigInt(NOW.getTime() + DAY) * 1_000n,
      };
      const listed = await listTraces(at(), { window });
      const [summary] = listed.traces;
      expect(summary).toMatchObject({
        providerCallId: "call_live",
        platformAgentId: "agent_voice_1",
        platformAgentName: "Front desk",
        agentPlatform: "retell",
        environment: "production",
      });

      const detail = await readTrace(at(), summary?.traceId ?? "", { window });
      expect(detail?.turns.map((turnRow) => turnRow.text)).toEqual([
        "Hello",
        "I need help",
      ]);
    } finally {
      await disconnectClickHouse();
      await traces.drop();
    }
  });
});
