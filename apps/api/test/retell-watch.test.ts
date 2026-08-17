import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import {
  appendSpans,
  claimGradingJobs,
  claimProductionTrace,
  getGradingJobForTrace,
  recordProductionTraces,
  resolveRetellWatch,
  type RetellWatchTarget,
} from "@egma/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  DELIVERY_FRESH_MILLISECONDS,
  pollConnection,
  pollsThisTick,
  runProductionSweep,
  SAFETY_NET_INTERVAL_MILLISECONDS,
} from "../src/production-sweep.ts";
import { PAGE_SIZE } from "../src/retell/api.ts";
import { normaliseRetellCall, type RetellCall } from "../src/retell/normalise.ts";
import {
  publicWebhookAddress,
  reconcileRetellWebhook,
} from "../src/retell/registration.ts";
import { signRetellBody } from "../src/retell/signature.ts";
import { writeRetellCall } from "../src/retell/write.ts";
import { RETELL_WEBHOOK_PATH } from "../src/routes/retell-webhook.ts";
import { createApi, type TestApi } from "./support/api.ts";
import { contextFor, request, signUp, type Customer } from "./support/traces.ts";

/**
 * Watching a Retell agent, end to end and adversarially, against the real
 * stores and through the real receiving endpoint.
 *
 * **No Retell key exists here and none is needed.** A Retell-shaped server on
 * loopback answers the two addresses egma asks — the call listing and the
 * agent update — from payloads shaped as their documentation shapes them. What
 * is proved is egma's half: the switch, the ledger, the cursor discipline and
 * the door.
 *
 * Everything is proved through the v1 read endpoints and the module's own
 * exports. **No monitoring page is touched**, deliberately: the surface those
 * conversations land on is another effort's, and this one has to be provable
 * without it.
 */

let api: TestApi;
let acme: Customer;
let globex: Customer;
let initech: Customer;
let retell: RetellStub;

/** Comfortably around everything this file writes. */
const BASE = Date.now();
const WINDOW = {
  from: new Date(BASE - 3_600_000).toISOString(),
  to: new Date(BASE + 3_600_000).toISOString(),
} as const;

/** The conversations are minted a minute ahead, so a fresh cursor is behind them. */
const AHEAD = 60_000;

const ACME_KEY = "retell-secret-acme-A1B2C3D4WXYZ";
const GLOBEX_KEY = "retell-secret-globex-E5F6G7H8QRST";
const INITECH_KEY = "retell-secret-initech-J9K0L1M2NPQR";
const SHARED_AGENT = "agent_shared_between_projects";
const INITECH_AGENT = "agent_with_a_long_backlog";
const REENABLE_AGENT = "agent_watched_then_not";

/* ------------------------------------------------------------------- *
 * A Retell-shaped server on loopback.
 * ------------------------------------------------------------------- */

type RetellStub = {
  /** Set once the loopback listener has a port. */
  url: string;
  /** What the account holds, by agent id, in whatever order it was put in. */
  readonly calls: Map<string, RetellCall[]>;
  /** What `update-agent` was last told, by agent id. */
  readonly webhooks: Map<string, string | null>;
  /** How many of the next listings answer 5xx, for proving a sweep stops. */
  failures: number;
  /** How many listings were asked for, for proving a cadence. */
  listings: number;
  close(): Promise<void>;
};

async function startRetellStub(): Promise<RetellStub> {
  const stub: RetellStub = {
    url: "",
    calls: new Map(),
    webhooks: new Map(),
    failures: 0,
    listings: 0,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };

  const server: Server = createServer((incoming, answer) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const url = incoming.url ?? "";

      if (url.startsWith("/v2/list-calls")) {
        stub.listings += 1;
        if (stub.failures > 0) {
          stub.failures -= 1;
          answer.writeHead(503, { "content-type": "application/json" });
          answer.end(JSON.stringify({ error_message: "Retell is unwell" }));
          return;
        }

        const asked = JSON.parse(body) as {
          filter_criteria?: {
            agent_id?: string[];
            end_timestamp?: { lower_threshold?: number };
          };
          limit?: number;
          pagination_key?: string;
        };
        const agentId = asked.filter_criteria?.agent_id?.[0] ?? "";
        const since = asked.filter_criteria?.end_timestamp?.lower_threshold ?? 0;
        const limit = asked.limit ?? 100;

        const matching = (stub.calls.get(agentId) ?? [])
          .filter((call) => {
            // A provider cannot filter on a field the record does not carry, so
            // a call reporting no end is in every window. That is the shape
            // that makes a stand-in end reachable through the poller at all.
            const ended = call["end_timestamp"];
            return typeof ended !== "number" || ended >= since;
          })
          .sort(
            (a, b) =>
              Number(a["end_timestamp"] ?? 0) - Number(b["end_timestamp"] ?? 0),
          );

        // Retell resumes after the call whose id it was handed.
        const resumeAfter =
          asked.pagination_key === undefined
            ? -1
            : matching.findIndex(
                (call) => call["call_id"] === asked.pagination_key,
              );
        const held = matching.slice(resumeAfter + 1, resumeAfter + 1 + limit);

        answer.writeHead(200, { "content-type": "application/json" });
        answer.end(JSON.stringify(held));
        return;
      }

      if (url.startsWith("/update-agent/")) {
        const agentId = decodeURIComponent(url.slice("/update-agent/".length));
        const asked = JSON.parse(body) as { webhook_url?: string | null };
        stub.webhooks.set(agentId, asked.webhook_url ?? null);
        answer.writeHead(200, { "content-type": "application/json" });
        answer.end(JSON.stringify({ agent_id: agentId }));
        return;
      }

      answer.writeHead(404).end("{}");
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  // The object the handler closed over, and never a copy of it: a copy would
  // make every `failures` and `listings` the tests set invisible to the server
  // and every assertion about them vacuously true.
  stub.url = `http://127.0.0.1:${address.port}`;
  return stub;
}

/* ------------------------------------------------------------------- *
 * Fixtures and helpers.
 * ------------------------------------------------------------------- */

/** A Retell call object as their documentation shapes one. */
function callFixture(
  callId: string,
  at: number,
  overrides: Partial<RetellCall> = {},
): RetellCall {
  return {
    call_id: callId,
    agent_id: SHARED_AGENT,
    call_status: "ended",
    start_timestamp: at - 30_000,
    end_timestamp: at,
    disconnection_reason: "user_hangup",
    recording_url: `https://recordings.retellai.com/${callId}.wav`,
    transcript_object: [
      { role: "agent", content: "Front desk, how can I help?" },
      { role: "user", content: "I would like to reschedule." },
    ],
    latency: { e2e: { p50: 700, p90: 1200 } },
    ...overrides,
  };
}

type Wired = {
  readonly customer: Customer;
  readonly agentId: string;
  readonly connectionId: string;
};

/** An agent with a Retell connection, watching switched off, as any team's is. */
async function wire(
  customer: Customer,
  name: string,
  apiKey: string,
  retellAgentId: string = SHARED_AGENT,
): Promise<Wired> {
  const registered = await request(api.app, "POST", "/api/agents", customer.secret, {
    name,
    connection: {
      type: "retell",
      modality: "chat",
      environment: "production",
      config: { retellAgentId },
      credentials: { apiKey },
    },
  });
  expect(registered.statusCode, JSON.stringify(registered.body)).toBe(201);

  const agent = registered.body.agent as Record<string, unknown>;
  const connection = registered.body.connection as Record<string, unknown>;
  return {
    customer,
    agentId: String(agent.id),
    connectionId: String(connection.id),
  };
}

async function setWatching(
  wired: Wired,
  watching: boolean,
): Promise<Record<string, unknown>> {
  const answer = await request(
    api.app,
    "PATCH",
    `/api/agents/${wired.agentId}/connections/${wired.connectionId}`,
    wired.customer.secret,
    { watch_production: watching },
  );
  expect(answer.statusCode, JSON.stringify(answer.body)).toBe(200);
  return answer.body.connection as Record<string, unknown>;
}

async function targetFor(wired: Wired): Promise<RetellWatchTarget> {
  const [target] = await resolveRetellWatch({ connectionId: wired.connectionId });
  if (target === undefined) throw new Error("the connection resolved to nothing");
  return target;
}

/** One tick of the real sweep, against the stub. */
async function sweep(): Promise<{
  readonly replayed: number;
  readonly replayFailed: number;
}> {
  return runProductionSweep({ url: retell.url }, new Map<string, number>(), {
    info: () => undefined,
    error: () => undefined,
  });
}

async function deliver(
  body: unknown,
  signWith: string | undefined,
): Promise<{ readonly statusCode: number; readonly stored: boolean }> {
  const payload = JSON.stringify(body);
  const response = await api.app.inject({
    method: "POST",
    url: RETELL_WEBHOOK_PATH,
    headers: {
      "content-type": "application/json",
      ...(signWith === undefined
        ? {}
        : { "x-retell-signature": signRetellBody(payload, signWith) }),
    },
    payload,
  });
  const held = response.json() as { stored?: boolean };
  return { statusCode: response.statusCode, stored: held.stored === true };
}

/** How many spans this customer holds for one trace, read through v1. */
async function spansOf(customer: Customer, traceId: string): Promise<number> {
  const response = await api.app.inject({
    method: "GET",
    url: `/v1/traces/${traceId}?from=${WINDOW.from}&to=${WINDOW.to}`,
    headers: { authorization: `Bearer ${customer.secret}` },
  });
  if (response.statusCode !== 200) return 0;
  const held = response.json() as { trace: { span_count: number } };
  return held.trace.span_count;
}

/** Every trace this customer holds inside the window, read through v1. */
async function tracesOf(
  customer: Customer,
): Promise<readonly Record<string, unknown>[]> {
  const response = await api.app.inject({
    method: "GET",
    url: `/v1/traces?from=${WINDOW.from}&to=${WINDOW.to}&limit=200`,
    headers: { authorization: `Bearer ${customer.secret}` },
  });
  expect(response.statusCode, response.body).toBe(200);
  return (response.json() as { traces: Record<string, unknown>[] }).traces;
}

async function claimRows(): Promise<
  readonly { trace_id: string; status: string; degraded: boolean }[]
> {
  const { rows } = await api.database.sql<{
    trace_id: string;
    status: string;
    degraded: boolean;
  }>("select trace_id, status, degraded from production_trace_claim");
  return rows;
}

async function refusalCounts(): Promise<Record<string, number>> {
  const { rows } = await api.database.sql<{ reason: string; how_many: string }>(
    "select reason, how_many from retell_webhook_refusal",
  );
  return Object.fromEntries(rows.map((row) => [row.reason, Number(row.how_many)]));
}

async function cursorOf(connectionId: string): Promise<Date | null> {
  const { rows } = await api.database.sql<{ production_cursor: Date | null }>(
    "select production_cursor from connection where id = $1",
    [connectionId],
  );
  return rows[0]?.production_cursor ?? null;
}

async function backdateClaims(): Promise<void> {
  await api.database.sql(
    "update production_trace_claim set claimed_at = now() - interval '10 minutes' where status = 'claimed'",
  );
}

/* ------------------------------------------------------------------- *
 * The world.
 * ------------------------------------------------------------------- */

let acmeWired: Wired;
let globexWired: Wired;
let initechWired: Wired;

beforeAll(async () => {
  retell = await startRetellStub();
  api = await createApi("retell_watch", {
    traceStore: true,
    retellReach: { url: retell.url },
  });
  acme = await signUp(api.app, "ada@acme.example", "Acme");
  globex = await signUp(api.app, "grace@globex.example", "Globex");
  initech = await signUp(api.app, "hank@initech.example", "Initech");
  acmeWired = await wire(acme, "Front desk", ACME_KEY);
  globexWired = await wire(globex, "Support line", GLOBEX_KEY);
  // Its own agent, because the paging case files more conversations than one
  // page of the read endpoint answers with and would crowd another customer's.
  initechWired = await wire(
    initech,
    "Order line",
    INITECH_KEY,
    INITECH_AGENT,
  );
});

afterAll(async () => {
  await api?.close();
  await retell?.close();
});

/* ------------------------------------------------------------------- *
 * Consent.
 * ------------------------------------------------------------------- */

describe("a connection nobody switched on", () => {
  it("is off, is never polled, and its deliveries are refused", async () => {
    const read = await request(
      api.app,
      "GET",
      `/api/agents/${acmeWired.agentId}/connections/${acmeWired.connectionId}`,
      acme.secret,
    );
    expect(read.statusCode).toBe(200);
    expect(
      (read.body.connection as Record<string, unknown>).watch_production,
    ).toBe(false);

    retell.calls.set(SHARED_AGENT, [callFixture("call_uninvited", BASE + AHEAD)]);
    const before = retell.listings;
    await sweep();
    // Nothing asked Retell anything, because nothing is being watched.
    expect(retell.listings).toBe(before);
    expect(await tracesOf(acme)).toHaveLength(0);

    const refused = await deliver(
      { event: "call_ended", call: callFixture("call_uninvited", BASE + AHEAD) },
      ACME_KEY,
    );
    expect(refused.statusCode).toBe(200);
    expect(refused.stored).toBe(false);
    expect((await refusalCounts()).switched_off).toBe(1);
    expect(await claimRows()).toHaveLength(0);

    retell.calls.clear();
  });
});

/* ------------------------------------------------------------------- *
 * The two transports, and the one write path.
 * ------------------------------------------------------------------- */

describe("the switch, and the pull floor under it", () => {
  it("starts the cursor at now, so watching means from here on", async () => {
    const connection = await setWatching(acmeWired, true);
    expect(connection.watch_production).toBe(true);
    // No public address here, so nothing was registered — and nothing is
    // wrong: pull is the transport.
    expect(connection.webhook_registered).toBe(false);

    const cursor = await cursorOf(acmeWired.connectionId);
    expect(cursor).not.toBeNull();
    // Everything Retell already holds from before the switch stays where it is.
    expect(cursor!.getTime()).toBeGreaterThan(BASE - 60_000);
  });

  it("stores a conversation that ends after the switch, readable through v1", async () => {
    const call = callFixture("call_first", BASE + AHEAD);
    retell.calls.set(SHARED_AGENT, [call]);
    await sweep();

    const traces = await tracesOf(acme);
    expect(traces).toHaveLength(1);
    expect(traces[0]).toMatchObject({
      source: "production",
      emitter: "agent",
      environment: "production",
      connection_type: "retell",
      provider_call_id: "call_first",
      agent_id: acmeWired.agentId,
      // Two turns from the transcript, and no per-turn span Retell never
      // reported: a root plus its two turns.
      span_count: 3,
      turn_counts: { human: 1, agent: 1 },
    });

    const cursor = await cursorOf(acmeWired.connectionId);
    expect(cursor?.getTime()).toBe(BASE + AHEAD);
  });

  it("absorbs the inclusive re-offer at the boundary on the next tick", async () => {
    await sweep();
    expect(await tracesOf(acme)).toHaveLength(1);
    expect((await claimRows()).filter((row) => row.status === "written")).toHaveLength(1);
  });
});

describe("the same conversation offered twice", () => {
  const call = callFixture("call_raced", BASE + AHEAD + 1_000);

  it("is stored once when the webhook lands before the pull", async () => {
    const delivered = await deliver({ event: "call_ended", call }, ACME_KEY);
    expect(delivered.stored).toBe(true);

    retell.calls.set(SHARED_AGENT, [
      callFixture("call_first", BASE + AHEAD),
      call,
    ]);
    await sweep();

    const traces = await tracesOf(acme);
    expect(traces.filter((one) => one.provider_call_id === "call_raced")).toHaveLength(1);
  });

  it("is stored once when the pull lands before the webhook", async () => {
    const later = callFixture("call_pull_first", BASE + AHEAD + 2_000);
    retell.calls.set(SHARED_AGENT, [later]);
    await sweep();

    const delivered = await deliver({ event: "call_ended", call: later }, ACME_KEY);
    expect(delivered.stored).toBe(false);

    const traces = await tracesOf(acme);
    expect(
      traces.filter((one) => one.provider_call_id === "call_pull_first"),
    ).toHaveLength(1);
  });

  it("is stored once when the same transport delivers it twice", async () => {
    const twice = callFixture("call_twice", BASE + AHEAD + 3_000);
    expect((await deliver({ event: "call_ended", call: twice }, ACME_KEY)).stored).toBe(true);
    expect((await deliver({ event: "call_ended", call: twice }, ACME_KEY)).stored).toBe(false);

    const traces = await tracesOf(acme);
    expect(traces.filter((one) => one.provider_call_id === "call_twice")).toHaveLength(1);
  });

  it("is stored once when both transports offer it at the same moment", async () => {
    const target = await targetFor(acmeWired);
    const concurrent = callFixture("call_concurrent", BASE + AHEAD + 4_000);

    const [byWebhook, byPull] = await Promise.all([
      writeRetellCall(target, concurrent, "webhook"),
      writeRetellCall(target, concurrent, "pull"),
    ]);

    // The constraint settles it, not the timing: exactly one of them wrote.
    const outcomes = [byWebhook.kind, byPull.kind].sort();
    expect(outcomes).toEqual(["already", "written"]);

    const traces = await tracesOf(acme);
    expect(
      traces.filter((one) => one.provider_call_id === "call_concurrent"),
    ).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------- *
 * The two crash windows.
 * ------------------------------------------------------------------- */

describe("a transport that died mid-protocol", () => {
  it("is recovered by the lease sweep after a claim with no append", async () => {
    const target = await targetFor(acmeWired);
    const call = callFixture("call_claim_only", BASE + AHEAD + 5_000);
    const normalised = normaliseRetellCall(
      call,
      {
        connectionId: target.connectionId,
        connectionType: target.connectionType,
        agentId: target.agentId,
        environment: target.environment,
      },
      BASE,
    );

    // Claimed, and then nothing — which is what a process killed between the
    // claim and the append leaves behind.
    const claimed = await claimProductionTrace(target.auth, {
      connectionId: target.connectionId,
      traceId: normalised.traceId,
      providerCallId: normalised.providerCallId,
      transport: "webhook",
      payload: JSON.stringify(call),
      endedAt: normalised.endedAt,
    });
    expect(claimed).toBeDefined();
    expect(await spansOf(acme, normalised.traceId)).toBe(0);

    await backdateClaims();
    retell.calls.clear();
    const swept = await sweep();
    expect(swept.replayed).toBe(1);

    expect(await spansOf(acme, normalised.traceId)).toBe(3);
    const [row] = (await claimRows()).filter(
      (one) => one.trace_id === normalised.traceId,
    );
    expect(row?.status).toBe("written");
  });

  it("is recovered after an append with no mark, and exactly one copy exists", async () => {
    const target = await targetFor(acmeWired);
    const call = callFixture("call_append_only", BASE + AHEAD + 6_000);
    const normalised = normaliseRetellCall(
      call,
      {
        connectionId: target.connectionId,
        connectionType: target.connectionType,
        agentId: target.agentId,
        environment: target.environment,
      },
      BASE,
    );

    await claimProductionTrace(target.auth, {
      connectionId: target.connectionId,
      traceId: normalised.traceId,
      providerCallId: normalised.providerCallId,
      transport: "pull",
      payload: JSON.stringify(call),
      endedAt: normalised.endedAt,
    });
    // Appended, and then killed before anything said so.
    await appendSpans(target.auth, normalised.spans);
    await recordProductionTraces(target.auth, normalised.spans);
    expect(await spansOf(acme, normalised.traceId)).toBe(3);

    await backdateClaims();
    retell.calls.clear();
    const swept = await sweep();
    expect(swept.replayed).toBe(1);

    // The replay's append is byte-identical, so the store drops it as the
    // duplicate block it is. Three spans, not six.
    expect(await spansOf(acme, normalised.traceId)).toBe(3);
    const [row] = (await claimRows()).filter(
      (one) => one.trace_id === normalised.traceId,
    );
    expect(row?.status).toBe("written");
  });
});

/* ------------------------------------------------------------------- *
 * The cursor discipline.
 * ------------------------------------------------------------------- */

describe("a sweep that could not finish", () => {
  it("stops where it stands and resumes at the next tick with no gaps", async () => {
    const held = [
      callFixture("call_resume_a", BASE + AHEAD + 10_000),
      callFixture("call_resume_b", BASE + AHEAD + 11_000),
      callFixture("call_resume_c", BASE + AHEAD + 12_000),
    ];
    retell.calls.set(SHARED_AGENT, held);

    const before = await cursorOf(acmeWired.connectionId);
    retell.failures = 1;
    await sweep();
    // Retell answered 5xx, so this sweep ended where it stood and the cursor
    // is exactly where it was.
    expect((await cursorOf(acmeWired.connectionId))?.getTime()).toBe(
      before?.getTime(),
    );
    expect(
      (await tracesOf(acme)).filter((one) =>
        String(one.provider_call_id).startsWith("call_resume"),
      ),
    ).toHaveLength(0);

    // One of the three arrives out of band while the poller is stopped, which
    // is the ordinary interleaving of two transports.
    expect(
      (await deliver({ event: "call_ended", call: held[1] }, ACME_KEY)).stored,
    ).toBe(true);

    await sweep();

    const stored = (await tracesOf(acme)).filter((one) =>
      String(one.provider_call_id).startsWith("call_resume"),
    );
    // No gaps and no duplicates: the one already written was skipped by the
    // ledger, the other two were written.
    expect(stored.map((one) => one.provider_call_id).sort()).toEqual([
      "call_resume_a",
      "call_resume_b",
      "call_resume_c",
    ]);
    expect((await cursorOf(acmeWired.connectionId))?.getTime()).toBe(
      BASE + AHEAD + 12_000,
    );
  });
});

describe("a burst larger than one page", () => {
  it("drains in one tick, each conversation checkpointed on its own", async () => {
    const burst = Array.from({ length: 105 }, (_, index) =>
      callFixture(`call_burst_${index}`, BASE + AHEAD + 20_000 + index, {
        transcript_object: [],
      }),
    );
    retell.calls.set(SHARED_AGENT, burst);

    await sweep();

    const stored = (await tracesOf(acme)).filter((one) =>
      String(one.provider_call_id).startsWith("call_burst_"),
    );
    expect(stored).toHaveLength(105);
    // The cursor is the last conversation actually written, which is what
    // makes it a statement of fact.
    expect((await cursorOf(acmeWired.connectionId))?.getTime()).toBe(
      BASE + AHEAD + 20_000 + 104,
    );
    // More than one page was asked for, which is what draining means.
    expect(
      (await claimRows()).filter((row) => row.status === "written").length,
    ).toBeGreaterThan(105);
  }, 60_000);
});

describe("a payload the normalizer cannot fully read", () => {
  it("is written degraded, kept verbatim, and the cursor moves past it", async () => {
    const poison = {
      call_id: "call_poison",
      agent_id: SHARED_AGENT,
      call_status: "ended",
      end_timestamp: BASE + AHEAD + 30_000,
      transcript_object: "not a list of turns",
      something_new: { egma: "has no place for this yet" },
    } satisfies RetellCall;
    retell.calls.set(SHARED_AGENT, [poison]);

    await sweep();

    const stored = (await tracesOf(acme)).filter(
      (one) => one.provider_call_id === "call_poison",
    );
    expect(stored).toHaveLength(1);
    // The root landed, and it says so.
    expect(stored[0]?.span_count).toBe(1);
    expect(stored[0]?.errored_span_count).toBe(1);

    const [row] = (await claimRows()).filter(
      (one) => one.trace_id === String(stored[0]?.trace_id),
    );
    expect(row?.degraded).toBe(true);

    // And the cursor moved, so the poller never grinds on it again.
    expect((await cursorOf(acmeWired.connectionId))?.getTime()).toBe(
      BASE + AHEAD + 30_000,
    );

    const { rows } = await api.database.sql<{ payload: string }>(
      "select payload from production_trace_claim where provider_call_id = $1",
      ["call_poison"],
    );
    const held = JSON.parse(rows[0]?.payload ?? "{}") as Record<string, unknown>;
    expect(held["something_new"]).toEqual({
      egma: "has no place for this yet",
    });

    retell.calls.clear();
  });
});

/* ------------------------------------------------------------------- *
 * The door.
 * ------------------------------------------------------------------- */

describe("the receiving endpoint", () => {
  it("refuses an agent no connection names, and counts it", async () => {
    const before = (await refusalCounts()).unknown_agent ?? 0;
    const stranger = callFixture("call_stranger", BASE + AHEAD + 40_000, {
      agent_id: "agent_nobody_registered",
    });
    const answer = await deliver({ event: "call_ended", call: stranger }, ACME_KEY);

    expect(answer.statusCode).toBe(200);
    expect(answer.stored).toBe(false);
    expect((await refusalCounts()).unknown_agent).toBe(before + 1);
  });

  it("resolves only the connections naming the agent, so a delivery unseals no more", async () => {
    // The candidates have to be found before a signature can say which of them
    // this is, so this read is reachable by anybody who can POST. Asking for
    // every connection and filtering afterwards meant unsealing the whole
    // deployment's Retell keys once per request.
    const everything = await resolveRetellWatch({ everyConnection: true });
    const named = await resolveRetellWatch({
      everyConnection: true,
      retellAgentId: SHARED_AGENT,
    });

    expect(named.length).toBeGreaterThan(0);
    expect(named.length).toBeLessThan(everything.length);
    expect(named.every((one) => one.retellAgentId === SHARED_AGENT)).toBe(true);

    // And an agent nobody registered opens nothing at all.
    expect(
      await resolveRetellWatch({
        everyConnection: true,
        retellAgentId: "agent_nobody_registered",
      }),
    ).toEqual([]);
  });

  it("refuses a body nobody's key signed, and counts it", async () => {
    const before = (await refusalCounts()).bad_signature ?? 0;
    const call = callFixture("call_unsigned", BASE + AHEAD + 41_000);

    expect((await deliver({ event: "call_ended", call }, "a-different-key")).stored).toBe(false);
    expect((await deliver({ event: "call_ended", call }, undefined)).stored).toBe(false);
    expect((await refusalCounts()).bad_signature).toBe(before + 2);

    expect(
      (await tracesOf(acme)).filter((one) => one.provider_call_id === "call_unsigned"),
    ).toHaveLength(0);
  });

  it("acknowledges a kind it does not write, drops it, and calls it no refusal", async () => {
    const before = await refusalCounts();
    const call = callFixture("call_started_only", BASE + AHEAD + 42_000);

    const started = await deliver({ event: "call_started", call }, ACME_KEY);
    expect(started.statusCode).toBe(200);
    expect(started.stored).toBe(false);

    const analyzed = await deliver({ event: "call_analyzed", call }, ACME_KEY);
    expect(analyzed.stored).toBe(false);

    // The provider did exactly what it was asked to and Egma declined to write
    // a conversation that has not finished. Counting that beside the three real
    // refusals would bury them under the door working.
    expect(await refusalCounts()).toEqual(before);
    expect(
      (await tracesOf(acme)).filter(
        (one) => one.provider_call_id === "call_started_only",
      ),
    ).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------- *
 * Fan-out and tenancy.
 * ------------------------------------------------------------------- */

describe("one Retell agent watched from two places", () => {
  it("files one copy each, and neither can see the other's", async () => {
    await setWatching(globexWired, true);

    const shared = callFixture("call_fanned_out", BASE + AHEAD + 50_000);
    // One delivery, signed by each account's own key in turn — which is what
    // Retell actually sends, because the two connections are two accounts.
    expect((await deliver({ event: "call_ended", call: shared }, ACME_KEY)).stored).toBe(true);
    expect((await deliver({ event: "call_ended", call: shared }, GLOBEX_KEY)).stored).toBe(true);

    const here = (await tracesOf(acme)).filter(
      (one) => one.provider_call_id === "call_fanned_out",
    );
    const there = (await tracesOf(globex)).filter(
      (one) => one.provider_call_id === "call_fanned_out",
    );

    expect(here).toHaveLength(1);
    expect(there).toHaveLength(1);
    // Two copies, two identities, because the connection is in the identity.
    expect(here[0]?.trace_id).not.toBe(there[0]?.trace_id);

    // And neither is readable from the other side.
    expect(await spansOf(globex, String(here[0]?.trace_id))).toBe(0);
    expect(await spansOf(acme, String(there[0]?.trace_id))).toBe(0);
  });
});

/* ------------------------------------------------------------------- *
 * Grading, which gains no code.
 * ------------------------------------------------------------------- */

describe("a conversation that arrived ended", () => {
  it("becomes claimable grading work with no grading code written for it", async () => {
    const target = await targetFor(acmeWired);
    const call = callFixture("call_to_be_judged", BASE + AHEAD + 60_000);
    const outcome = await writeRetellCall(target, call, "webhook");
    expect(outcome.kind).toBe("written");
    const traceId = outcome.kind === "written" ? outcome.traceId : "";

    // The root span closed in the same breath the spans were appended, so the
    // existing bookkeeping filed the job and stamped it complete.
    const job = await getGradingJobForTrace(target.auth, traceId);
    expect(job).toMatchObject({ source: "production", status: "pending" });
    expect(job?.rootClosedAt).not.toBeNull();
    expect(job?.projectId).toBe(acme.projectId);

    // And the grader service can take it, through the door it already had.
    // Drained rather than claimed once, because this file has already filed a
    // burst of conversations and the queue hands out its oldest work first.
    let taken = false;
    for (let pass = 0; pass < 20 && !taken; pass += 1) {
      const claimed = await claimGradingJobs({
        claimant: "grader-under-test",
        capacity: 50,
      });
      if (claimed.length === 0) break;
      taken = claimed.some((one) => one.traceId === traceId);
    }
    expect(taken).toBe(true);
  });
});

/* ------------------------------------------------------------------- *
 * Registration, and the cadence it decides.
 * ------------------------------------------------------------------- */

describe("automatic registration", () => {
  it("knows an address a provider could reach from one it could not", () => {
    expect(publicWebhookAddress("http://localhost:3101")).toBeUndefined();
    expect(publicWebhookAddress("http://127.0.0.1:3101")).toBeUndefined();
    expect(publicWebhookAddress("http://192.168.1.20:3101")).toBeUndefined();
    expect(publicWebhookAddress("http://egma:3101")).toBeUndefined();
    expect(publicWebhookAddress("https://egma.acme.example")).toBe(
      `https://egma.acme.example${RETELL_WEBHOOK_PATH}`,
    );
  });

  it("registers at switch-on with a public address, and deregisters at switch-off", async () => {
    const auth = contextFor(acme, "admin");
    retell.webhooks.clear();

    const registered = await reconcileRetellWebhook(
      auth,
      acmeWired.connectionId,
      true,
      "https://egma.acme.example",
      { url: retell.url },
    );
    expect(registered).toEqual({
      kind: "registered",
      url: `https://egma.acme.example${RETELL_WEBHOOK_PATH}`,
    });
    expect(retell.webhooks.get(SHARED_AGENT)).toBe(
      `https://egma.acme.example${RETELL_WEBHOOK_PATH}`,
    );
    expect((await targetFor(acmeWired)).webhookRegisteredAt).not.toBeNull();

    const deregistered = await reconcileRetellWebhook(
      auth,
      acmeWired.connectionId,
      false,
      "https://egma.acme.example",
      { url: retell.url },
    );
    expect(deregistered).toEqual({ kind: "deregistered" });
    expect(retell.webhooks.get(SHARED_AGENT)).toBeNull();
  });

  it("completes silently in pull-only mode with no public address", async () => {
    retell.webhooks.clear();
    const outcome = await reconcileRetellWebhook(
      contextFor(acme, "admin"),
      acmeWired.connectionId,
      true,
      "http://localhost:3101",
      { url: retell.url },
    );
    expect(outcome).toEqual({ kind: "pull-only" });
    // Nothing was said to Retell, and nothing is wrong.
    expect(retell.webhooks.size).toBe(0);
  });

  it("clears the registration stamp when the switch goes off", async () => {
    const connection = await setWatching(acmeWired, false);
    expect(connection.watch_production).toBe(false);
    expect(connection.webhook_registered).toBe(false);
    await setWatching(acmeWired, true);
  });
});

describe("the poller's cadence", () => {
  const registeredAt = new Date(BASE);

  it("is full while nothing is being delivered", () => {
    expect(
      pollsThisTick(
        { webhookRegisteredAt: null, webhookDeliveredAt: null },
        BASE - 1_000,
        BASE,
      ),
    ).toBe(true);
    // Registered but silent is not delivering, and full cadence is the answer.
    expect(
      pollsThisTick(
        { webhookRegisteredAt: registeredAt, webhookDeliveredAt: null },
        BASE - 1_000,
        BASE,
      ),
    ).toBe(true);
  });

  it("drops to the safety net while deliveries are arriving, and never to nothing", () => {
    const delivering = {
      webhookRegisteredAt: registeredAt,
      webhookDeliveredAt: new Date(BASE - 1_000),
    };
    // A tick a moment after the last poll is skipped.
    expect(pollsThisTick(delivering, BASE - 1_000, BASE)).toBe(false);
    // And one a safety net later is not: the poller is slower, never off.
    expect(
      pollsThisTick(
        delivering,
        BASE - SAFETY_NET_INTERVAL_MILLISECONDS,
        BASE,
      ),
    ).toBe(true);
  });

  it("comes back to full cadence the moment deliveries stop", () => {
    const stopped = {
      webhookRegisteredAt: registeredAt,
      webhookDeliveredAt: new Date(BASE - DELIVERY_FRESH_MILLISECONDS - 1),
    };
    expect(pollsThisTick(stopped, BASE - 1_000, BASE)).toBe(true);
  });

  it("stamps a delivery, so a live webhook actually moves the cadence", async () => {
    const before = await targetFor(acmeWired);
    expect(
      (
        await deliver(
          {
            event: "call_ended",
            call: callFixture("call_cadence", BASE + AHEAD + 70_000),
          },
          ACME_KEY,
        )
      ).stored,
    ).toBe(true);

    const after = await targetFor(acmeWired);
    expect(after.webhookDeliveredAt).not.toBeNull();
    expect(after.webhookDeliveredAt?.getTime()).toBeGreaterThan(
      before.webhookDeliveredAt?.getTime() ?? 0,
    );
  });
});

/* ------------------------------------------------------------------- *
 * The three findings the passing suite did not reach.
 * ------------------------------------------------------------------- */

describe("a backlog longer than one page that is already stored", () => {
  it("is paged through, so a conversation the webhook missed is still reached", async () => {
    await setWatching(initechWired, true);
    const target = await targetFor(initechWired);

    // Exactly one page of conversations the webhook already stored. A webhook
    // write never moves the cursor — correctly — so every one of these sits
    // past it, and the poller's first page is entirely already-claimed.
    const backlog = Array.from({ length: PAGE_SIZE }, (_, index) =>
      callFixture(`call_paged_${index}`, BASE + AHEAD + 100_000 + index, {
        agent_id: INITECH_AGENT,
        transcript_object: [],
      }),
    );
    for (const call of backlog) {
      const outcome = await writeRetellCall(target, call, "webhook");
      expect(outcome.kind).toBe("written");
    }

    // And one beyond it that the webhook did not deliver.
    const missed = callFixture(
      "call_the_webhook_missed",
      BASE + AHEAD + 100_000 + PAGE_SIZE,
      { agent_id: INITECH_AGENT, transcript_object: [] },
    );
    retell.calls.set(INITECH_AGENT, [...backlog, missed]);

    // One tick. The old loop broke on the first full page because nothing in it
    // moved the cursor, and this conversation was unreachable for good.
    await sweep();

    const stored = (await tracesOf(initech)).filter(
      (one) => one.provider_call_id === "call_the_webhook_missed",
    );
    expect(stored).toHaveLength(1);
    // And it is the poller's own write, so the cursor moved to it.
    expect((await cursorOf(initechWired.connectionId))?.getTime()).toBe(
      BASE + AHEAD + 100_000 + PAGE_SIZE,
    );

    // Nothing was written twice on the way past.
    const paged = (await tracesOf(initech)).filter((one) =>
      String(one.provider_call_id).startsWith("call_paged_"),
    );
    expect(paged).toHaveLength(PAGE_SIZE);

    await setWatching(initechWired, false);
    retell.calls.delete(INITECH_AGENT);
  }, 120_000);
});

describe("a payload whose clock disagrees with itself", () => {
  it("is written degraded with no duration, rather than poisoning every sweep", async () => {
    // End before start. The duration would be negative, the store's column is
    // unsigned, and the append used to throw — leaving the claim unwritten and
    // the replay loop hitting the same refusal on every tick for ever.
    const skewed = callFixture("call_skewed", BASE + AHEAD + 110_000, {
      start_timestamp: BASE + AHEAD + 110_000 + 50_000,
      end_timestamp: BASE + AHEAD + 110_000,
      transcript_object: [],
    });
    const alsoFine = callFixture("call_after_the_skew", BASE + AHEAD + 111_000, {
      transcript_object: [],
    });
    retell.calls.set(SHARED_AGENT, [skewed, alsoFine]);

    await sweep();

    const stored = (await tracesOf(acme)).filter((one) =>
      ["call_skewed", "call_after_the_skew"].includes(
        String(one.provider_call_id),
      ),
    );
    // Both landed: the skewed one did not stop the sweep it was in.
    expect(stored.map((one) => one.provider_call_id).sort()).toEqual([
      "call_after_the_skew",
      "call_skewed",
    ]);

    const [skew] = stored.filter(
      (one) => one.provider_call_id === "call_skewed",
    );
    expect(skew?.duration_ns).toBe("0");
    const [row] = (await claimRows()).filter(
      (one) => one.trace_id === String(skew?.trace_id),
    );
    expect(row?.degraded).toBe(true);
    expect(row?.status).toBe("written");

    retell.calls.clear();
  });
});

describe("a claim that cannot be replayed at all", () => {
  it("is counted and stepped over, and blocks neither other replays nor polling", async () => {
    const target = await targetFor(acmeWired);

    // A timestamp so far out that the store cannot hold it: the append throws
    // where no amount of normalising helps. It stands in here for any claim
    // whose replay fails, which before this had no handler at all — one row
    // aborted every replay behind it and every poll after it, on every tick.
    const unstorable = {
      call_id: "call_unstorable",
      agent_id: SHARED_AGENT,
      call_status: "ended",
      start_timestamp: 1e18,
      end_timestamp: 1e18,
    } satisfies RetellCall;
    const recoverable = callFixture("call_recoverable", BASE + AHEAD + 120_000, {
      transcript_object: [],
    });

    for (const [call, at] of [
      [unstorable, new Date(BASE + AHEAD + 119_000)],
      [recoverable, new Date(BASE + AHEAD + 120_000)],
    ] as const) {
      const claimed = await claimProductionTrace(target.auth, {
        connectionId: target.connectionId,
        traceId: `poison-${String(call["call_id"])}`,
        providerCallId: String(call["call_id"]),
        transport: "pull",
        payload: JSON.stringify(call),
        endedAt: at,
      });
      expect(claimed).toBeDefined();
    }

    // Something for the poll half of the same tick to find, so the test can
    // tell "the replay was stepped over" from "the tick stopped politely".
    const alsoPolled = callFixture("call_polled_past_it", BASE + AHEAD + 121_000, {
      transcript_object: [],
    });
    retell.calls.set(SHARED_AGENT, [alsoPolled]);

    await backdateClaims();
    const swept = await sweep();

    expect(swept.replayFailed).toBe(1);
    expect(swept.replayed).toBe(1);

    const stored = (await tracesOf(acme)).map((one) => one.provider_call_id);
    // The replay behind the poison one ran...
    expect(stored).toContain("call_recoverable");
    // ...and so did the polling after both of them.
    expect(stored).toContain("call_polled_past_it");
    // The unstorable one is still owed a write, and is nobody's emergency.
    const [poison] = (await claimRows()).filter(
      (one) => one.trace_id === "poison-call_unstorable",
    );
    expect(poison?.status).toBe("claimed");

    retell.calls.clear();
  });
});

describe("a conversation that reported no end at all", () => {
  it("is stored, and never carries the cursor to the wall clock", async () => {
    const target = await targetFor(acmeWired);
    const at = (await cursorOf(acmeWired.connectionId))?.getTime() ?? 0;
    expect(at).toBeGreaterThan(0);

    // No timestamps at all, so the normalizer stands in the moment it read it.
    // It sorts first, which is what puts it before the two below in the page.
    const timeless = {
      call_id: "call_no_end",
      agent_id: SHARED_AGENT,
      call_status: "ended",
    } satisfies RetellCall;
    const between = [
      callFixture("call_between_1", at + 1_000, { transcript_object: [] }),
      callFixture("call_between_2", at + 2_000, { transcript_object: [] }),
    ];
    retell.calls.set(SHARED_AGENT, [timeless, ...between]);

    // The sweep writes the timeless one and is then interrupted, which is the
    // whole scenario: if its stand-in end had moved the cursor to now, both
    // conversations below would have been behind the cursor and lost.
    let seen = 0;
    await expect(
      pollConnection(target, { url: retell.url }, {
        write: async (into, call) => {
          seen += 1;
          if (seen > 1) throw new Error("the store went away mid-page");
          return writeRetellCall(into, call, "pull");
        },
      }),
    ).rejects.toThrow("the store went away mid-page");

    const afterTheTimeless = await tracesOf(acme);
    expect(
      afterTheTimeless.filter((one) => one.provider_call_id === "call_no_end"),
    ).toHaveLength(1);
    // The cursor did not believe a stand-in.
    expect((await cursorOf(acmeWired.connectionId))?.getTime()).toBe(at);

    // So the next tick still reaches everything that ended after it.
    await sweep();
    const stored = (await tracesOf(acme)).map((one) => one.provider_call_id);
    expect(stored).toContain("call_between_1");
    expect(stored).toContain("call_between_2");
    expect((await cursorOf(acmeWired.connectionId))?.getTime()).toBe(at + 2_000);

    retell.calls.clear();
  });
});

describe("a sweep killed between two items of one page", () => {
  it("loses nothing: the written one stays, the rest arrive on the next tick", async () => {
    const target = await targetFor(acmeWired);
    const at = (await cursorOf(acmeWired.connectionId))?.getTime() ?? 0;
    const page = [
      callFixture("call_item_1", at + 1_000, { transcript_object: [] }),
      callFixture("call_item_2", at + 2_000, { transcript_object: [] }),
      callFixture("call_item_3", at + 3_000, { transcript_object: [] }),
    ];
    retell.calls.set(SHARED_AGENT, page);

    // The first item is durably written; the second item's **write** fails,
    // which is a kill between two items of one page rather than a page that
    // never arrived.
    let seen = 0;
    await expect(
      pollConnection(target, { url: retell.url }, {
        write: async (into, call) => {
          seen += 1;
          if (seen === 2) throw new Error("the store went away mid-page");
          return writeRetellCall(into, call, "pull");
        },
      }),
    ).rejects.toThrow("the store went away mid-page");

    const afterTheKill = (await tracesOf(acme)).map(
      (one) => one.provider_call_id,
    );
    expect(afterTheKill).toContain("call_item_1");
    expect(afterTheKill).not.toContain("call_item_2");
    expect(afterTheKill).not.toContain("call_item_3");
    // The cursor is exactly the last item durably written, which is what makes
    // the next tick resume rather than restart or skip.
    expect((await cursorOf(acmeWired.connectionId))?.getTime()).toBe(at + 1_000);

    await sweep();

    const resumed = (await tracesOf(acme)).filter((one) =>
      String(one.provider_call_id).startsWith("call_item_"),
    );
    // Three conversations, once each. The first was re-offered by the inclusive
    // window and skipped by the ledger; the other two were written.
    expect(resumed.map((one) => one.provider_call_id).sort()).toEqual([
      "call_item_1",
      "call_item_2",
      "call_item_3",
    ]);
    expect((await cursorOf(acmeWired.connectionId))?.getTime()).toBe(at + 3_000);

    retell.calls.clear();
  });
});

describe("a backlog longer than one tick can page through", () => {
  it("carries the cursor forward on ticks that write nothing, until it reaches what the webhook missed", async () => {
    const target = await targetFor(acmeWired);
    const at = (await cursorOf(acmeWired.connectionId))?.getTime() ?? 0;
    expect(at).toBeGreaterThan(0);

    // Two pages of two, so one tick can look at four conversations. The
    // behaviour under test is the relationship between the page budget and the
    // backlog, not the size of either — at the product's own numbers this same
    // shape is two thousand conversations.
    const BUDGET = { pageSize: 2, mostPages: 2 } as const;
    const PER_TICK = BUDGET.pageSize * BUDGET.mostPages;

    // Eight conversations the webhook already stored. Each is claimed, so the
    // poller writes none of them — and before this, none of them moved the
    // cursor either, so the poller looked at the same first four for ever.
    const backlog = Array.from({ length: 8 }, (_, index) =>
      callFixture(`call_frontier_${index}`, at + 1_000 * (index + 1), {
        transcript_object: [],
      }),
    );
    for (const call of backlog) {
      expect((await writeRetellCall(target, call, "webhook")).kind).toBe(
        "written",
      );
    }

    // And one beyond the backlog that the webhook did not deliver. It sits
    // further out than one tick's whole budget, which is the case the page cap
    // used to make permanently unreachable.
    const missed = callFixture("call_beyond_the_frontier", at + 9_000, {
      transcript_object: [],
    });
    expect(backlog.length + 1).toBeGreaterThan(PER_TICK);
    retell.calls.set(SHARED_AGENT, [...backlog, missed]);

    // Tick one: nothing to write, and the cursor moves anyway — the ledger owns
    // the write duty for every conversation it stepped over.
    const first = await pollConnection(
      await targetFor(acmeWired),
      { url: retell.url },
      BUDGET,
    );
    expect(first.written).toBe(0);
    expect((await cursorOf(acmeWired.connectionId))?.getTime()).toBe(
      at + 1_000 * PER_TICK,
    );

    // Tick two: still nothing written, still catching up.
    const second = await pollConnection(
      await targetFor(acmeWired),
      { url: retell.url },
      BUDGET,
    );
    expect(second.written).toBe(0);
    expect((await cursorOf(acmeWired.connectionId))?.getTime()).toBe(
      at + 1_000 * (PER_TICK + 3),
    );

    // Tick three reaches past the frontier and writes the conversation the
    // webhook missed. The cap bounds how much work one tick does; it no longer
    // bounds what is reachable.
    const third = await pollConnection(
      await targetFor(acmeWired),
      { url: retell.url },
      BUDGET,
    );
    expect(third.written).toBe(1);
    expect((await cursorOf(acmeWired.connectionId))?.getTime()).toBe(at + 9_000);

    const stored = (await tracesOf(acme)).filter(
      (one) => one.provider_call_id === "call_beyond_the_frontier",
    );
    expect(stored).toHaveLength(1);

    // And nothing the webhook had already stored was written a second time on
    // the way past it.
    const frontier = (await tracesOf(acme)).filter((one) =>
      String(one.provider_call_id).startsWith("call_frontier_"),
    );
    expect(frontier).toHaveLength(backlog.length);

    retell.calls.clear();
  });
});

/* ------------------------------------------------------------------- *
 * Switching off.
 * ------------------------------------------------------------------- */

describe("switching watching off", () => {
  it("stops ingestion and keeps everything already stored", async () => {
    const stored = (await tracesOf(acme)).length;
    expect(stored).toBeGreaterThan(0);

    await setWatching(acmeWired, false);
    // The other project is still watching the same Retell agent, and its poll
    // is a listing like any other. Switched off too, so that a listing after
    // this means Egma polled a connection nobody asked it to.
    await setWatching(globexWired, false);

    retell.calls.set(SHARED_AGENT, [
      callFixture("call_after_the_switch", BASE + AHEAD + 80_000),
    ]);
    const before = retell.listings;
    await sweep();
    expect(retell.listings).toBe(before);

    const refused = await deliver(
      {
        event: "call_ended",
        call: callFixture("call_after_the_switch", BASE + AHEAD + 80_000),
      },
      ACME_KEY,
    );
    expect(refused.stored).toBe(false);

    // Nothing new, and nothing lost.
    expect(await tracesOf(acme)).toHaveLength(stored);
  });
});

/* ------------------------------------------------------------------- *
 * Switching back on.
 * ------------------------------------------------------------------- */

describe("watching switched on a second time", () => {
  it("stores nothing from the window it was switched off for", async () => {
    // Its own connection, because this is the one case whose whole subject is
    // the cursor, and it has to start from a switch nobody else has flipped.
    const wired = await wire(acme, "Re-enable desk", ACME_KEY, REENABLE_AGENT);

    await setWatching(wired, true);
    const firstStamp = (await cursorOf(wired.connectionId))?.getTime() ?? 0;
    expect(firstStamp).toBeGreaterThan(0);

    // One conversation while watching is on. It is stored, and the cursor
    // follows it.
    const during = callFixture("call_while_watching", firstStamp + 1, {
      agent_id: REENABLE_AGENT,
      transcript_object: [],
    });
    retell.calls.set(REENABLE_AGENT, [during]);
    await sweep();
    expect((await cursorOf(wired.connectionId))?.getTime()).toBe(firstStamp + 1);

    // Off. What was stored stays stored, and the agent keeps taking calls —
    // which is the ordinary reason somebody switches capture off.
    await setWatching(wired, false);
    const offWindow = [
      callFixture("call_off_window_b", firstStamp + 2, {
        agent_id: REENABLE_AGENT,
        transcript_object: [],
      }),
      callFixture("call_off_window_c", firstStamp + 3, {
        agent_id: REENABLE_AGENT,
        transcript_object: [],
      }),
    ];
    retell.calls.set(REENABLE_AGENT, [during, ...offWindow]);

    const listingsWhileOff = retell.listings;
    await sweep();
    expect(retell.listings).toBe(listingsWhileOff);

    // On again. **Every switch-on means from here on**, so the cursor is
    // stamped afresh rather than kept — otherwise the next window would open
    // where capture stopped and sweep in everything that happened while it was
    // deliberately off.
    await setWatching(wired, true);
    const secondStamp = (await cursorOf(wired.connectionId))?.getTime() ?? 0;
    expect(secondStamp).not.toBe(firstStamp + 1);
    // The off window really is behind the new stamp, or this proves nothing.
    expect(secondStamp).toBeGreaterThan(firstStamp + 3);

    const after = callFixture("call_after_re_enable", secondStamp + 1_000, {
      agent_id: REENABLE_AGENT,
      transcript_object: [],
    });
    retell.calls.set(REENABLE_AGENT, [during, ...offWindow, after]);
    await sweep();

    const stored = (await tracesOf(acme)).map((one) => one.provider_call_id);
    expect(stored).toContain("call_while_watching");
    expect(stored).toContain("call_after_re_enable");
    // The two the customer had switched capture off for. Never asked for,
    // never stored.
    expect(stored).not.toContain("call_off_window_b");
    expect(stored).not.toContain("call_off_window_c");
    expect((await cursorOf(wired.connectionId))?.getTime()).toBe(
      secondStamp + 1_000,
    );

    // And writing `true` over a connection that is already watching is a form
    // submitting what it was already showing, not a switch-on. It must not move
    // the cursor, or it would drop whatever the poller had not yet drained.
    await setWatching(wired, true);
    expect((await cursorOf(wired.connectionId))?.getTime()).toBe(
      secondStamp + 1_000,
    );

    await setWatching(wired, false);
    retell.calls.delete(REENABLE_AGENT);
  });
});
