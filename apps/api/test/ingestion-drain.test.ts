import {
  appendSpans,
  committedSpans,
  configureLiveKitMonitoring,
  connectClickHouse,
  disconnectClickHouse,
  DRAIN_ADVISORY_LOCK,
  listMonitoringSetups,
  openDrainOwnership,
  type AuthContext,
} from "@egma/db";
import { gzipSync } from "node:zlib";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  forgetRetainedDefects,
  retainedDefects,
} from "../src/ingestion/defects.ts";
import { startDrainer, type Drainer } from "../src/ingestion/drainer.ts";
import {
  pendingObjectStore,
  type PendingObject,
  type PendingObjectStore,
} from "../src/ingestion/object-store.ts";
import {
  contentHashOf,
  spanFor,
  type IngestionRecord,
} from "../src/ingestion/record.ts";
import {
  pendingKeyFor,
  sealSegment,
  type SegmentScope,
} from "../src/ingestion/segment.ts";
import { OTLP_TRACES_PATH } from "../src/routes/traces.ts";
import { createApi, type TestApi } from "./support/api.ts";
import { aRecord } from "./support/ingestion.ts";
import {
  startObjectStorage,
  type ObjectStorage,
} from "./support/object-storage.ts";
import { mintKey, signUp, type Customer } from "./support/traces.ts";

/**
 * The segment lifecycle, with the faults that decide whether it is correct.
 *
 * Everything before this point can be proved by a request answering. Draining
 * cannot: it is the half of ingestion where nobody is waiting, where every step
 * can stop between two others, and where the only thing standing between a
 * customer's evidence and a silent loss is that each step is safe to do again.
 * So this is the one deep-module family the design allows, and every case in it
 * is a failure rather than a feature.
 *
 * ## What is faulted, and where each fault comes from
 *
 * The object store is wrapped, so a read, a listing or a deletion can be made
 * to fail exactly once — which is what a store timing out really looks like.
 * ClickHouse is disconnected, which is what a cold start really looks like. The
 * handoffs are stopped with a constraint the upsert violates, which is the one
 * way to make Postgres refuse a specific write without making it refuse every
 * write. Nothing here reaches inside the drainer to count calls: every claim is
 * about what is in the bucket, in the store, and in the tables afterwards.
 *
 * ## The one crash point proved next door
 *
 * A crash after the local append and before the upload is proved at the
 * acceptance seam in `ingestion-accept.test.ts`, because that is where the
 * staged record lives and where the restart that recovers it happens. Repeating
 * it here would be a second stack for one claim.
 */

const storage: ObjectStorage = await startObjectStorage("ingestion-drain");

if (!storage.available) {
  process.stderr.write(`\nskipping the drain suite — ${storage.why}\n\n`);
}

afterAll(() => {
  if (storage.available) storage.stop();
});

/** Faults a suite arms, one at a time, on the way to the real bucket. */
type Faults = {
  /** The next `read` of this key throws instead of answering. */
  failReadOf?: string | undefined;
  /** The next `delete` of this key throws instead of removing it. */
  failDeleteOf?: string | undefined;
  /** Every listing throws. */
  failListing?: boolean | undefined;
};

function faulting(real: PendingObjectStore, faults: Faults): PendingObjectStore {
  return {
    create: (segment) => real.create(segment),
    reachable: () => real.reachable(),
    async read(key) {
      if (faults.failReadOf === key) {
        faults.failReadOf = undefined;
        throw new Error("the ingestion bucket did not answer this read");
      }
      return real.read(key);
    },
    async list() {
      if (faults.failListing === true) {
        throw new Error("the ingestion bucket did not answer this listing");
      }
      return real.list();
    },
    async delete(key) {
      if (faults.failDeleteOf === key) {
        faults.failDeleteOf = undefined;
        throw new Error("the ingestion bucket did not remove this object");
      }
      await real.delete(key);
    },
  };
}

describe.skipIf(!storage.available)("draining an accepted segment", () => {
  const running = storage as Extract<ObjectStorage, { available: true }>;

  let api: TestApi;
  let acme: Customer;
  let scope: SegmentScope;
  let auth: AuthContext;
  let bucket: PendingObjectStore;

  const faults: Faults = {};
  let drainer: Drainer;

  /**
   * One conversation as the LiveKit normalizer would have produced it: two
   * turns inside a session span the platform said ends the trace.
   */
  function aConversation(
    traceId: string,
    overrides: Partial<IngestionRecord> = {},
  ): readonly IngestionRecord[] {
    const at = BigInt(Date.parse("2026-08-20T09:00:00.000Z")) * 1_000n;
    const root = `${traceId.slice(0, 14)}01`;
    return [
      aRecord({
        trace_id: traceId,
        span_id: root,
        parent_span_id: "",
        name: "agent_session",
        kind: "root",
        source: "production",
        agent_platform: "livekit_agents",
        platform_agent_id: "agent-under-test",
        started_at_microseconds: String(at),
        ends_trace: true,
        ...overrides,
      }),
      aRecord({
        trace_id: traceId,
        span_id: `${traceId.slice(0, 14)}02`,
        parent_span_id: root,
        name: "agent_turn",
        kind: "turn:agent",
        source: "production",
        agent_platform: "livekit_agents",
        platform_agent_id: "agent-under-test",
        started_at_microseconds: String(at + 1_000_000n),
        text: "Of course — Tuesday at four works.",
        ...overrides,
      }),
    ];
  }

  /** Put one sealed segment in the bucket and tell nobody, which is the crash. */
  async function accepted(
    records: readonly IngestionRecord[],
    segmentId?: string,
  ): Promise<string> {
    const sealed = sealSegment({
      scope,
      records,
      ...(segmentId === undefined ? {} : { segmentId }),
    });
    await bucket.create(sealed);
    return sealed.key;
  }

  async function pending(): Promise<readonly PendingObject[]> {
    return bucket.list();
  }

  /**
   * Bytes straight into the bucket under a pending key, whatever they are.
   *
   * Nothing in the product can produce a damaged object, which is the point of
   * the cases that need one: they are about what the drainer does with bytes
   * the product would never have written.
   */
  async function put(segmentId: string, body: Uint8Array): Promise<void> {
    await bucket.create({
      segmentId,
      key: pendingKeyFor(segmentId),
      scope,
      header: {
        v: 1,
        segment_id: segmentId,
        organization_id: scope.organizationId,
        project_id: scope.projectId,
        record_count: 0,
        content_sha256: "",
      },
      body,
    });
  }

  async function countOf(query: string): Promise<number> {
    const traceStore = api.traceStore;
    if (traceStore === undefined) throw new Error("this API has no trace store");
    const [row] = await traceStore.rows<{ n: string }>(query);
    return Number(row?.n ?? -1);
  }

  async function gradingJobsFor(traceId: string): Promise<
    readonly { root_closed_at: Date | null; last_seen_at: Date }[]
  > {
    const { rows } = await api.database.sql<{
      root_closed_at: Date | null;
      last_seen_at: Date;
    }>("select root_closed_at, last_seen_at from grading_job where trace_id = $1", [
      traceId,
    ]);
    return rows;
  }

  beforeAll(async () => {
    if (!storage.available) return;
    api = await createApi("ingestion_drain", { traceStore: true });
    acme = await signUp(api.app, "ada@acme.example", "Acme");
    scope = { organizationId: acme.organizationId, projectId: acme.projectId };
    auth = {
      userId: acme.userId,
      organizationId: acme.organizationId,
      projectId: acme.projectId,
      role: "admin",
      via: "session",
    };
    await configureLiveKitMonitoring(auth);

    bucket = pendingObjectStore(running.ingestStore);
    drainer = startDrainer({
      // Two keys a page, so the recovery walk needs several of them without
      // putting a thousand objects in a bucket.
      store: faulting(
        pendingObjectStore(running.ingestStore, { listingPageSize: 2 }),
        faults,
      ),
      log: { warn: () => undefined, error: () => undefined },
      // Long: every pass in this file is asked for, so nothing arrives between
      // an arrangement and its assertion.
      scanIntervalMilliseconds: 60 * 60_000,
    });
  });

  afterAll(async () => {
    await drainer?.stop();
    await api?.close();
  });

  it("finds an object nobody told it about, and finishes every effect before deleting it", async () => {
    const traceId = "aa00000000000000000000000000aa00";
    const key = await accepted(aConversation(traceId));

    // The upload succeeded and the process died before the hand-off. Nothing
    // in memory knows this object exists.
    expect(await drainer.drainNow()).toBe(1);

    expect(
      await countOf(
        `select count() as n from spans final where trace_id = '${traceId}'`,
      ),
    ).toBe(2);
    expect(
      await countOf(
        `select count() as n from turns final where trace_id = '${traceId}'`,
      ),
    ).toBe(1);
    // The platform said the conversation ended, so the handoff says so too.
    expect(await gradingJobsFor(traceId)).toEqual([
      { root_closed_at: expect.any(Date), last_seen_at: expect.any(Date) },
    ]);
    expect(
      (await listMonitoringSetups(auth)).find(
        (setup) => setup.agentPlatform === "livekit_agents",
      )?.lastReceivedAt,
    ).toBeInstanceOf(Date);

    // And only then is the object gone.
    expect((await pending()).map((object) => object.key)).not.toContain(key);
  });

  it("is harmless to rediscover after a deletion that failed", async () => {
    const traceId = "bb00000000000000000000000000bb00";
    const key = await accepted(aConversation(traceId));

    faults.failDeleteOf = key;
    expect(await drainer.drainNow()).toBe(0);
    // Everything that depends on the object has happened; the object is still
    // there, which is exactly the state a delete timeout leaves.
    expect((await pending()).map((object) => object.key)).toContain(key);
    expect(
      await countOf(
        `select count() as n from spans final where trace_id = '${traceId}'`,
      ),
    ).toBe(2);

    // The next pass is the retry, and running the whole object again changes
    // nothing a reader can see.
    expect(await drainer.drainNow()).toBe(1);
    expect((await pending()).map((object) => object.key)).not.toContain(key);
    expect(
      await countOf(
        `select count() as n from spans final where trace_id = '${traceId}'`,
      ),
    ).toBe(2);
    expect(
      await countOf(
        `select count() as n from turns final where trace_id = '${traceId}'`,
      ),
    ).toBe(1);
    expect(await gradingJobsFor(traceId)).toHaveLength(1);
  });

  it("leaves the object pending when the trace store is unavailable, and finishes on the next pass", async () => {
    const traceId = "cc00000000000000000000000000cc00";
    const key = await accepted(aConversation(traceId));

    await disconnectClickHouse();
    try {
      expect(await drainer.drainNow()).toBe(0);
    } finally {
      const traceStore = api.traceStore;
      if (traceStore === undefined) throw new Error("this API has no trace store");
      connectClickHouse({ clickhouseUrl: traceStore.url, maxOpenConnections: 4 });
    }

    // Nothing was written and nothing was deleted: the complete segment is
    // still there to be replayed.
    expect((await pending()).map((object) => object.key)).toContain(key);
    expect(await gradingJobsFor(traceId)).toHaveLength(0);

    expect(await drainer.drainNow()).toBe(1);
    expect(
      await countOf(
        `select count() as n from spans final where trace_id = '${traceId}'`,
      ),
    ).toBe(2);
    expect(await gradingJobsFor(traceId)).toHaveLength(1);
  });

  it("keeps the object when the handoff fails, and replays only the missing effect", async () => {
    const traceId = "dd00000000000000000000000000dd00";
    const key = await accepted(aConversation(traceId));

    // The one way to make Postgres refuse this write and no other. The rows
    // reach ClickHouse; the handoff behind them does not.
    // A literal rather than a bind parameter, because Postgres takes no
    // parameters in DDL. The value is this file's own hex id.
    await api.database.sql(
      "alter table grading_job add constraint refuses_this_trace " +
        `check (trace_id is null or trace_id <> '${traceId}')`,
    );
    try {
      expect(await drainer.drainNow()).toBe(0);

      expect((await pending()).map((object) => object.key)).toContain(key);
      // Query-visible already, which is the point: the evidence is not held
      // hostage to a bookkeeping row.
      expect(
        await countOf(
          `select count() as n from spans final where trace_id = '${traceId}'`,
        ),
      ).toBe(2);
      expect(await gradingJobsFor(traceId)).toHaveLength(0);
    } finally {
      await api.database.sql(
        "alter table grading_job drop constraint refuses_this_trace",
      );
    }

    // The replay repeats the write it already did — a no-op against evidence
    // already visible — and completes the one effect that was missing.
    expect(await drainer.drainNow()).toBe(1);
    expect(
      await countOf(
        `select count() as n from spans final where trace_id = '${traceId}'`,
      ),
    ).toBe(2);
    expect(await gradingJobsFor(traceId)).toEqual([
      { root_closed_at: expect.any(Date), last_seen_at: expect.any(Date) },
    ]);
  });

  it("leaves one visible span and turn when the same evidence is drained under a new identity", async () => {
    const traceId = "ee00000000000000000000000000ee00";
    const records = aConversation(traceId);
    await accepted(records);
    expect(await drainer.drainNow()).toBe(1);

    // A second segment, same evidence, different identity — which is what a
    // re-sealed replay is, and what a drain beyond the store's own recent-block
    // window looks like: a token it has never seen. Identity is the guarantee;
    // the token is only the shield in front of it.
    await accepted(records);
    expect(await drainer.drainNow()).toBe(1);

    expect(
      await countOf(
        `select count() as n from spans final where trace_id = '${traceId}'`,
      ),
    ).toBe(2);
    expect(
      await countOf(
        `select count() as n from turns final where trace_id = '${traceId}'`,
      ),
    ).toBe(1);
    expect(await gradingJobsFor(traceId)).toHaveLength(1);
  });

  it("retains a segment whose evidence disagrees with what is already stored, and changes nothing", async () => {
    const traceId = "ff00000000000000000000000000ff00";
    const original = aConversation(traceId);
    await accepted(original);
    expect(await drainer.drainNow()).toBe(1);

    const changed = original.map((record) =>
      record.kind === "turn:agent"
        ? { ...record, text: "Something else entirely." }
        : record,
    );
    const key = await accepted(changed);

    expect(await drainer.drainNow()).toBe(0);
    // The first account of that moment is still the one a reader gets.
    expect((await pending()).map((object) => object.key)).toContain(key);
    const [stored] = await committedSpans(
      auth,
      [{ traceId, spanId: `${traceId.slice(0, 14)}02` }],
      {
        window: {
          from: BigInt(Date.parse("2026-08-20T00:00:00.000Z")) * 1_000n,
          to: BigInt(Date.parse("2026-08-21T00:00:00.000Z")) * 1_000n,
        },
      },
    );
    expect(stored?.contentHash).toBe(
      contentHashOf(original[1] as IngestionRecord),
    );
    expect(
      await countOf(
        `select count() as n from spans final where trace_id = '${traceId}' ` +
          "and text = 'Something else entirely.'",
      ),
    ).toBe(0);

    // The object is retained for repair rather than deleted, and rediscovering
    // it changes nothing either.
    expect(await drainer.drainNow()).toBe(0);
    expect((await pending()).map((object) => object.key)).toContain(key);
    await bucket.delete(key);
  });

  it("retains a corrupt object without making any of it visible, and counts it by reason alone", async () => {
    forgetRetainedDefects();
    const traceId = "11000000000000000000000000001100";
    const sealed = sealSegment({ scope, records: aConversation(traceId) });

    // Bytes that are not gzip at all, under a key the pending prefix spells.
    const damaged = "sgm_01M0000000000000000000CORRUPT";
    await put(damaged, Buffer.from("not gzip, and never was"));
    // And a segment whose header states a checksum its records do not have.
    const lying = "sgm_01M00000000000000000000LYING";
    await put(
      lying,
      gzipSync(
        Buffer.from(
          `${JSON.stringify({
            ...sealed.header,
            segment_id: lying,
            content_sha256: "0".repeat(64),
          })}\n{"v":1}\n`,
          "utf8",
        ),
      ),
    );

    expect(await drainer.drainNow()).toBe(0);

    // Both are still there, and nothing they carried became visible.
    const keys = (await pending()).map((object) => object.key);
    expect(keys).toContain(pendingKeyFor(damaged));
    expect(keys).toContain(pendingKeyFor(lying));
    expect(
      await countOf(
        `select count() as n from spans final where trace_id = '${traceId}'`,
      ),
    ).toBe(0);

    // Counted for an operator by reason class and by nothing else. A key, an
    // organization or a segment id in a metric label is an unbounded set of
    // values, and the first bucket full of damaged objects would be the one
    // that took the metrics down.
    const counted = retainedDefects();
    expect([...counted.keys()].sort()).toEqual([
      "checksum_mismatch",
      "not_gzip",
    ]);
    expect([...counted.values()]).toEqual([1, 1]);

    // A retained object stays under its key until a person deals with it, so
    // every scan finds it again. It is reported once: a count that grew on
    // every pass would measure how long this process has been up rather than
    // how many objects are stuck.
    expect(await drainer.drainNow()).toBe(0);
    expect([...retainedDefects().values()]).toEqual([1, 1]);
    expect((await pending()).map((object) => object.key)).toContain(
      pendingKeyFor(damaged),
    );

    await bucket.delete(pendingKeyFor(damaged));
    await bucket.delete(pendingKeyFor(lying));
  });

  /**
   * The door refuses a span whose instant the store cannot hold, so one only
   * reaches the drainer if it got into the bucket another way. When it does, the
   * identity probe cannot build a window around it and throws — a cause the
   * drainer must retain and count rather than fall through to a warning and read
   * the object again every scan for the life of the process.
   */
  it("retains a segment whose span begins past the store's readable ceiling, counting it once", async () => {
    forgetRetainedDefects();
    const traceId = "77000000000000000000000000007700";
    const sealed = sealSegment({
      scope,
      records: aConversation(traceId, {
        started_at_microseconds: String(BigInt(Date.UTC(9999, 0, 1)) * 1000n),
      }),
    });
    await bucket.create(sealed);

    expect(await drainer.drainNow()).toBe(0);
    expect((await pending()).map((object) => object.key)).toContain(sealed.key);
    expect(
      await countOf(
        `select count() as n from spans final where trace_id = '${traceId}'`,
      ),
    ).toBe(0);

    const counted = retainedDefects();
    expect([...counted.keys()]).toEqual(["unstorable_instant"]);
    expect(counted.get("unstorable_instant")).toBe(1);

    // Retained, not looped: the next pass skips it and one stuck object stays
    // one rather than becoming a count that measures how long the process is up.
    expect(await drainer.drainNow()).toBe(0);
    expect(retainedDefects().get("unstorable_instant")).toBe(1);

    await bucket.delete(sealed.key);
  });

  /**
   * The Seam 2 fault this proves: an attempt that got one ClickHouse block in
   * and stopped, replayed whole, leaves no second copy. Two records a month
   * apart become two insert blocks, each under its own `<segmentId>:spans:<n>`
   * token, so the block already committed is a no-op the token absorbs and the
   * second completes.
   */
  it("replays a whole segment whose first block already landed, without a second copy", async () => {
    const traceId = "88000000000000000000000000008800";
    const root = `${traceId.slice(0, 14)}01`;
    const later = `${traceId.slice(0, 14)}02`;
    const records: readonly IngestionRecord[] = [
      aRecord({
        trace_id: traceId,
        span_id: root,
        parent_span_id: "",
        name: "agent_session",
        kind: "root",
        source: "production",
        agent_platform: "livekit_agents",
        platform_agent_id: "agent-under-test",
        started_at_microseconds: String(
          BigInt(Date.parse("2026-01-15T09:00:00.000Z")) * 1000n,
        ),
        ends_trace: true,
      }),
      aRecord({
        trace_id: traceId,
        span_id: later,
        parent_span_id: root,
        name: "agent_turn",
        kind: "turn:agent",
        source: "production",
        agent_platform: "livekit_agents",
        platform_agent_id: "agent-under-test",
        started_at_microseconds: String(
          BigInt(Date.parse("2026-02-15T09:00:00.000Z")) * 1000n,
        ),
        text: "A month later.",
      }),
    ];
    const sealed = sealSegment({ scope, records });

    const oneOf = (spanId: string): Promise<number> =>
      countOf(
        `select count() as n from spans final where span_id = '${spanId}'`,
      );

    // The attempt that stopped after its first block: only the first record
    // reached the store, under the segment's own first token.
    await appendSpans(auth, [spanFor(records[0] as IngestionRecord)], {
      segmentId: sealed.segmentId,
    });
    expect(await oneOf(root)).toBe(1);
    expect(await oneOf(later)).toBe(0);

    // The whole object drains under the same tokens: the first block dedups and
    // the second is new, and neither leaves a second visible copy.
    await bucket.create(sealed);
    expect(await drainer.drainNow()).toBe(1);
    expect(await oneOf(root)).toBe(1);
    expect(await oneOf(later)).toBe(1);
    expect((await pending()).map((object) => object.key)).not.toContain(
      sealed.key,
    );
  });

  /**
   * **A tenancy the control database has never agreed to is not a tenancy.**
   *
   * The checksum covers the header, so the organization and project a segment
   * names are the pair it was sealed with and nothing can have edited them.
   * That the pair is a *real* one is a separate question and only Postgres can
   * answer it — so it is asked before a row is written, because a write under a
   * pair nobody owns is one customer's evidence filed under another's name.
   */
  it("retains a segment naming a project outside its own organization", async () => {
    const traceId = "6600000000000000000000000000f600";
    const elsewhere = await signUp(api.app, "grace@globex.example", "Globex");

    const sealed = sealSegment({
      // Acme's organization, Globex's project. Sealed and checksummed as such,
      // so it verifies perfectly and is still a pair that does not exist.
      scope: {
        organizationId: acme.organizationId,
        projectId: elsewhere.projectId,
      },
      records: aConversation(traceId),
    });
    await bucket.create(sealed);

    expect(await drainer.drainNow()).toBe(0);
    expect((await pending()).map((object) => object.key)).toContain(sealed.key);
    expect(
      await countOf(
        `select count() as n from spans final where trace_id = '${traceId}'`,
      ),
    ).toBe(0);

    await bucket.delete(sealed.key);
  });

  it("leaves an object it could not read where it is, and takes it on the next pass", async () => {
    const traceId = "2200000000000000000000000000d200";
    const key = await accepted(aConversation(traceId));

    faults.failReadOf = key;
    expect(await drainer.drainNow()).toBe(0);
    expect((await pending()).map((object) => object.key)).toContain(key);
    expect(
      await countOf(
        `select count() as n from spans final where trace_id = '${traceId}'`,
      ),
    ).toBe(0);

    expect(await drainer.drainNow()).toBe(1);
    expect(
      await countOf(
        `select count() as n from spans final where trace_id = '${traceId}'`,
      ),
    ).toBe(2);
  });

  it("follows every listing page, so a backlog cannot hide behind the first", async () => {
    // Five objects and two keys a page: a drainer that stopped at the first
    // page would report a clean prefix with three segments still in it.
    const traceIds = [
      "3300000000000000000000000000a301",
      "3300000000000000000000000000a302",
      "3300000000000000000000000000a303",
      "3300000000000000000000000000a304",
      "3300000000000000000000000000a305",
    ];
    for (const traceId of traceIds) await accepted(aConversation(traceId));

    expect(await drainer.drainNow()).toBe(traceIds.length);
    expect(await pending()).toHaveLength(0);
    for (const traceId of traceIds) {
      expect(
        await countOf(
          `select count() as n from spans final where trace_id = '${traceId}'`,
        ),
      ).toBe(2);
    }
  });

  it("does nothing at all when the prefix cannot be listed", async () => {
    faults.failListing = true;
    try {
      expect(await drainer.drainNow()).toBe(0);
    } finally {
      faults.failListing = false;
    }
  });

  /**
   * Two `all` instances is the ordinary hosted shape, and only one of them may
   * walk the prefix. Two that did could each probe the trace store, each find
   * one immutable identity absent because the other's write had not landed
   * yet, and each then write a different account of it — which is precisely
   * what the integrity rule exists to refuse and cannot refuse from behind.
   *
   * The one that does not hold the claim is not broken. It keeps its scan
   * loop, drains nothing, and takes over the moment the holder lets go, which
   * is what makes restarting the drainer an operation nobody has to think
   * about.
   */
  /**
   * Cut the session holding the drain claim, the way a Postgres restart, a
   * failover or an idle-socket reaper would. Postgres releases the advisory
   * lock with the session, so what the holder has afterwards is a dead
   * connection and no claim.
   *
   * Scoped to this suite's own database, because an advisory lock is, and
   * because suites share a cluster: an unscoped kill would reach into another
   * suite's deployment and end a claim that is nothing to do with this one.
   */
  async function killTheDrainClaim(): Promise<void> {
    await api.database.sql(
      `select pg_terminate_backend(pid) from pg_locks
        where locktype = 'advisory' and classid = $1 and objid = $2
          and granted and pid <> pg_backend_pid()
          and database = (select oid from pg_database
                           where datname = current_database())`,
      [DRAIN_ADVISORY_LOCK.namespace, DRAIN_ADVISORY_LOCK.id],
    );
  }

  /** Which backend holds the drain claim, or nobody. */
  async function whoHoldsTheDrainClaim(): Promise<number | undefined> {
    const { rows } = await api.database.sql<{ pid: number }>(
      `select pid from pg_locks
        where locktype = 'advisory' and classid = $1 and objid = $2
          and granted and pid <> pg_backend_pid()
          and database = (select oid from pg_database
                           where datname = current_database())`,
      [DRAIN_ADVISORY_LOCK.namespace, DRAIN_ADVISORY_LOCK.id],
    );
    return rows[0]?.pid;
  }

  it("lets exactly one of two drainers walk the prefix, and hands over when it stops", async () => {
    // Taken before either drainer exists, so which one is the holder is this
    // test's decision rather than which startup scan asked first.
    const holderClaim = await openDrainOwnership();
    expect(await holderClaim.take()).toBe(true);
    const standbyClaim = await openDrainOwnership();
    expect(await standbyClaim.take()).toBe(false);

    const holder = startDrainer({
      store: pendingObjectStore(running.ingestStore),
      log: { warn: () => undefined, error: () => undefined },
      scanIntervalMilliseconds: 60 * 60_000,
      ownership: holderClaim,
    });
    const standby = startDrainer({
      store: pendingObjectStore(running.ingestStore),
      log: { warn: () => undefined, error: () => undefined },
      scanIntervalMilliseconds: 60 * 60_000,
      ownership: standbyClaim,
    });

    try {
      // Both startup scans settle before anything is put in the bucket, so
      // what each drains below is a pass this test asked for.
      await holder.drainNow();
      await standby.drainNow();

      const traceId = "ee00000000000000000000000000ee00";
      await accepted(aConversation(traceId));
      expect(await standby.drainNow()).toBe(0);
      expect(standby.standingBy()).toBe("standby");
      expect(await holder.drainNow()).toBe(1);
      expect(holder.standingBy()).toBeUndefined();

      // The holder stops. The other one asks again on its next pass, gets it,
      // and drains what arrives after that without anybody intervening.
      await holderClaim.release();
      const nextTrace = "ff00000000000000000000000000ff00";
      await accepted(aConversation(nextTrace));
      expect(await standby.drainNow()).toBe(1);
      expect(standby.standingBy()).toBeUndefined();

      // Now take its connection away underneath it — a Postgres restart, a
      // failover, an idle socket cut by something in between. Postgres drops
      // the lock with the session, so at this moment nobody is the drainer.
      const beforeTheKill = await whoHoldsTheDrainClaim();
      expect(beforeTheKill).toBeDefined();
      await killTheDrainClaim();
      expect(await whoHoldsTheDrainClaim()).toBeUndefined();

      // **It asks again and carries on.** The next pass builds a connection,
      // takes the claim on it, and drains — which on the single-instance
      // deployment everybody runs is the difference between one dropped socket
      // and draining stopping until somebody restarts the process.
      const thirdTrace = "aa11000000000000000000000000aa11";
      await accepted(aConversation(thirdTrace));
      expect(await standby.drainNow()).toBe(1);
      expect(standby.standingBy()).toBeUndefined();

      // And it is a genuinely new session holding it, so the claim really was
      // lost and really was taken again rather than merely believed.
      const afterTheKill = await whoHoldsTheDrainClaim();
      expect(afterTheKill).toBeDefined();
      expect(afterTheKill).not.toBe(beforeTheKill);
    } finally {
      await standby.stop();
      await holder.stop();
      await holderClaim.release();
      await standbyClaim.release();
    }
  });

  /**
   * The trace store's schema is applied beside the server now rather than in
   * front of it, so the drainer has to wait for it. Writing a segment into a
   * half-built schema is how a perfectly good object becomes a retained defect
   * for a reason that had nothing to do with it.
   */
  it("drains nothing while the trace store's schema is still being applied", async () => {
    const traceId = "1100000000000000000000000000dd00";
    await accepted(aConversation(traceId));

    let ready = false;
    const waiting = startDrainer({
      store: pendingObjectStore(running.ingestStore),
      log: { warn: () => undefined, error: () => undefined },
      scanIntervalMilliseconds: 60 * 60_000,
      traceStoreReady: () => ready,
    });
    try {
      expect(await waiting.drainNow()).toBe(0);
      expect(waiting.standingBy()).toBe("trace_store_migrating");

      ready = true;
      expect(await waiting.drainNow()).toBe(1);
      expect(waiting.standingBy()).toBeUndefined();
    } finally {
      await waiting.stop();
    }
  });
});

/**
 * The two facts a production conversation hands over — its evidence being
 * readable, and the platform saying it ended — arriving in either order.
 *
 * They are separate facts on separate spans, and an exporter is free to send
 * them in separate flushes that become separate segments and drain in either
 * order. A grader that read the trace on the first of them must find evidence
 * there, and the completion that arrives second must not create a second piece
 * of work.
 */
describe.skipIf(!storage.available)("the end fact and the evidence, in either order", () => {
  const running = storage as Extract<ObjectStorage, { available: true }>;

  let api: TestApi;
  let acme: Customer;
  let scope: SegmentScope;
  let bucket: PendingObjectStore;
  let drainer: Drainer;

  const at = BigInt(Date.parse("2026-08-20T10:00:00.000Z")) * 1_000n;

  function turn(traceId: string): IngestionRecord {
    return aRecord({
      trace_id: traceId,
      span_id: `${traceId.slice(0, 14)}02`,
      parent_span_id: `${traceId.slice(0, 14)}01`,
      name: "agent_turn",
      kind: "turn:agent",
      source: "production",
      agent_platform: "livekit_agents",
      started_at_microseconds: String(at + 1_000_000n),
      text: "Tuesday at four, then.",
    });
  }

  function ending(traceId: string): IngestionRecord {
    return aRecord({
      trace_id: traceId,
      span_id: `${traceId.slice(0, 14)}01`,
      parent_span_id: "",
      name: "agent_session",
      kind: "root",
      source: "production",
      agent_platform: "livekit_agents",
      started_at_microseconds: String(at),
      ends_trace: true,
    });
  }

  async function drain(records: readonly IngestionRecord[]): Promise<void> {
    await bucket.create(sealSegment({ scope, records }));
    expect(await drainer.drainNow()).toBe(1);
  }

  async function jobFor(
    traceId: string,
  ): Promise<{ root_closed_at: Date | null } | undefined> {
    const { rows } = await api.database.sql<{ root_closed_at: Date | null }>(
      "select root_closed_at from grading_job where trace_id = $1",
      [traceId],
    );
    expect(rows.length).toBeLessThanOrEqual(1);
    return rows[0];
  }

  beforeAll(async () => {
    if (!storage.available) return;
    api = await createApi("ingestion_drain_order", { traceStore: true });
    acme = await signUp(api.app, "ada@acme.example", "Acme");
    scope = { organizationId: acme.organizationId, projectId: acme.projectId };
    bucket = pendingObjectStore(running.ingestStore);
    drainer = startDrainer({
      store: bucket,
      log: { warn: () => undefined, error: () => undefined },
      scanIntervalMilliseconds: 60 * 60_000,
    });
  });

  afterAll(async () => {
    await drainer?.stop();
    await api?.close();
  });

  it("reports the evidence first and completes it when the ending arrives", async () => {
    const traceId = "4400000000000000000000000000e401";

    await drain([turn(traceId)]);
    // Known and readable, and deliberately not finished: nothing has said the
    // conversation is over.
    expect(await jobFor(traceId)).toEqual({ root_closed_at: null });

    await drain([ending(traceId)]);
    expect(await jobFor(traceId)).toEqual({ root_closed_at: expect.any(Date) });
  });

  it("takes the ending first and still reports the evidence that follows it", async () => {
    const traceId = "4400000000000000000000000000e402";

    await drain([ending(traceId)]);
    expect(await jobFor(traceId)).toEqual({ root_closed_at: expect.any(Date) });

    await drain([turn(traceId)]);
    // One piece of work either way, and a completion that a later flush cannot
    // undo.
    expect(await jobFor(traceId)).toEqual({ root_closed_at: expect.any(Date) });
  });
});

/**
 * The local log's bound, reached.
 *
 * Its own instance because the bound is a setting and this is the only claim
 * about it: a deployment holding as much staged evidence as it is allowed to
 * answers retryably and **discards nothing**, which is the difference between
 * an overloaded Egma and one that silently loses what it already promised to
 * keep.
 */
describe.skipIf(!storage.available)("a local log that will take no more", () => {
  const running = storage as Extract<ObjectStorage, { available: true }>;

  let api: TestApi;
  let secret: string;

  beforeAll(async () => {
    if (!storage.available) return;
    api = await createApi("ingestion_backpressure", {
      traceStore: true,
      ingestStore: running.ingestStore,
      // Small enough that one ordinary export reaches it, and large enough
      // that the first one does not.
      ingestionLogMaxBytes: 4_096,
      // Long, so the bound is reached before anything is uploaded and released.
      ingestionFlushMilliseconds: 60_000,
      // Longer than the flush window above, so what this case meets is the log
      // bound rather than the request's own.
      ingestionRequestTimeoutMilliseconds: 120_000,
    });
    const acme = await signUp(api.app, "ada@acme.example", "Acme");
    secret = await mintKey(api.app, acme.cookie, "a busy agent", acme.projectId);
  });

  afterAll(async () => {
    await api?.close();
  });

  it("answers retryably rather than discarding what is already staged", async () => {
    // One export carrying more than the whole log will hold. The first records
    // are framed on the disk; the one that would cross the bound is refused,
    // and the refusal is the whole answer — nothing older is thrown away to
    // make room for it.
    const spans = Array.from({ length: 24 }, (_, index) => ({
      traceId: "5500000000000000000000000000d500",
      spanId: `55000000000${String(index).padStart(5, "0")}`,
      name: "agent_turn",
      startTimeUnixNano: "1785693880281989804",
      endTimeUnixNano: "1785693881281989804",
      attributes: [
        {
          key: "lk.response.text",
          value: { stringValue: "x".repeat(600) },
        },
      ],
    }));

    const refused = await api.app.inject({
      method: "POST",
      url: OTLP_TRACES_PATH,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${secret}`,
      },
      payload: JSON.stringify({
        resourceSpans: [
          {
            resource: { attributes: [] },
            scopeSpans: [{ scope: { name: "livekit-agents" }, spans }],
          },
        ],
      }),
    });

    expect(refused.statusCode).toBe(503);
    expect(refused.json()).toMatchObject({
      code: 14,
      // Not a discard, and the sentence says so: an operator reading this must
      // not go looking for evidence that was thrown away.
      message: expect.stringContaining("has been discarded"),
    });
  });
});
