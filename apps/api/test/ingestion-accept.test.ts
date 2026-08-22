import { mkdtempSync, rmSync } from "node:fs";
import { createServer as createProxy, request } from "node:http";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { NewSpan } from "@egma/db";

import {
  acceptEvidenceForProjects,
  IngestionUnavailableError,
  stagedEvidence,
  type EvidenceGroup,
} from "../src/ingestion/accept.ts";
import { buildApi } from "../src/server.ts";
import type { IngestionStore } from "../src/ingestion/object-store.ts";
import { RECORD_FORMAT_VERSION } from "../src/ingestion/record.ts";
import { PENDING_PREFIX } from "../src/ingestion/segment.ts";
import { OTLP_TRACES_PATH } from "../src/routes/traces.ts";
import { createApi, type TestApi } from "./support/api.ts";
import {
  drainPendingEvidence,
  pendingSegments,
} from "./support/ingestion.ts";
import {
  startObjectStorage,
  type ObjectStorage,
} from "./support/object-storage.ts";
import { mintKey, signUp, type Customer } from "./support/traces.ts";

/**
 * The acceptance boundary, entered through the door a customer really uses.
 *
 * One promise is under test here and it is the whole design: **a request is
 * answered as accepted only when its evidence is durable in the object store.**
 * Not when it normalized, not when it reached the local log, and — the change
 * this release is — not when a row was written. So every question this file
 * asks is asked in the gap the door now leaves: what is in the bucket before
 * anything drains it, what is in the bucket when the request was refused, and
 * what a sender was told either way.
 *
 * It runs against a real MinIO, a real Postgres and a real ClickHouse, because
 * every one of those answers a question no stand-in can. The door tests next
 * door still own the wire contract; what is proved here is the boundary behind
 * it.
 */

const storage: ObjectStorage = await startObjectStorage("ingestion-accept");

if (!storage.available) {
  process.stderr.write(
    `\nskipping the acceptance suite — ${storage.why}\n\n`,
  );
}

/**
 * A store that answers a connection and then nothing at all.
 *
 * The failure this exists to reproduce is the one the request bound is for: not
 * a bucket that refuses — that would answer instantly — but a bucket that has
 * gone quiet while holding the request open. A refused connection would prove
 * the error path and say nothing about the bound, which is the part a customer
 * feels.
 */
async function aStoreThatNeverAnswers(): Promise<{
  readonly store: IngestionStore;
  readonly close: () => void;
}> {
  const held: Server = createServer((socket) => {
    // Accepted and then ignored, deliberately. The socket is kept so the
    // client sees an open connection rather than a reset.
    socket.on("error", () => undefined);
  });
  await new Promise<void>((listening) => {
    held.listen(0, "127.0.0.1", listening);
  });
  const address = held.address();
  if (address === null || typeof address === "string") {
    throw new Error("the silent store did not take a port");
  }
  return {
    store: {
      endpoint: `http://127.0.0.1:${address.port}`,
      bucket: "egma-ingestion",
      region: "us-east-1",
      accessKeyId: "SENTINEL-silent-store-key-id",
      secretAccessKey: "SENTINEL-silent-store-secret",
    },
    close: () => {
      held.close();
      held.unref();
    },
  };
}

/**
 * Something wearing the store's address that refuses the Nth object it is asked
 * to create, and forwards everything else untouched.
 *
 * A proxy rather than a stand-in client, because what has to be proved is the
 * real client meeting a real refusal: the request is signed for this address
 * and passed on byte for byte, headers included, so the store validates the
 * signature it was given and the only thing that changes is which call comes
 * back as a `503`.
 */
type RefusingStore = {
  readonly store: IngestionStore;
  /**
   * Let this many object creations through and refuse every one after them.
   *
   * Every one, rather than a single call, because the client retries a `503`
   * on its own: refusing once would be answered by a retry that succeeded, and
   * the acceptance module would never see a failure at all.
   */
  refuseEveryPutAfter(calls: number): void;
  /** Answer normally again. */
  stopRefusing(): void;
  /** How many object creations have been asked for, refused ones included. */
  putsSeen(): number;
  close(): void;
};

async function aStoreRefusingOnePut(
  real: IngestionStore,
): Promise<RefusingStore> {
  const upstream = new URL(real.endpoint);
  let putsUntilRefusal: number | undefined;
  let puts = 0;

  const held = createProxy((incoming, answering) => {
    if (incoming.method === "PUT") puts += 1;
    if (incoming.method === "PUT" && putsUntilRefusal !== undefined) {
      if (putsUntilRefusal === 0) {
        answering.writeHead(403, { "content-type": "application/xml" });
        answering.end(
          "<Error><Code>AccessDenied</Code><Message>not now</Message></Error>",
        );
        incoming.resume();
        return;
      }
      putsUntilRefusal -= 1;
    }

    const forwarded = request(
      {
        host: upstream.hostname,
        port: upstream.port,
        method: incoming.method,
        path: incoming.url,
        headers: incoming.headers,
      },
      (answer) => {
        answering.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(answering);
      },
    );
    forwarded.on("error", () => {
      answering.writeHead(502).end();
      incoming.resume();
    });
    incoming.pipe(forwarded);
  });

  await new Promise<void>((listening) => {
    held.listen(0, "127.0.0.1", listening);
  });
  const address = held.address();
  if (address === null || typeof address === "string") {
    throw new Error("the refusing store did not take a port");
  }

  return {
    store: { ...real, endpoint: `http://127.0.0.1:${address.port}` },
    refuseEveryPutAfter(calls) {
      putsUntilRefusal = calls;
    },
    stopRefusing() {
      putsUntilRefusal = undefined;
    },
    putsSeen() {
      return puts;
    },
    close() {
      held.close();
      held.unref();
    },
  };
}

/** One normalized span, as a door hands one over. */
function aSpanOf(spanId: string): NewSpan {
  return {
    traceId: `${spanId}${spanId}`,
    spanId,
    parentSpanId: "",
    source: "production",
    emitter: "agent",
    environment: "default",
    startedAtMicroseconds: BigInt(Date.parse("2026-08-20T09:00:00Z")) * 1_000n,
    durationNanoseconds: 1_000_000_000n,
    name: "agent_session",
    kind: "root",
    status: "ok",
    text: "",
    audioUrl: "",
    toolName: "",
    toolArguments: "",
    toolResult: "",
    providerCallId: "",
    agentPlatform: "livekit_agents",
    platformAgentId: "",
    platformAgentName: "",
    platformAgentVersion: "",
    connectionKind: "livekit",
    runId: "",
    agentId: "",
    agentVersionId: "",
    testVersionId: "",
    personaVersionId: "",
    payload: "{}",
    endsTrace: true,
  };
}

function jsonSpan(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    traceId: "c0ffee00c0ffee00c0ffee00c0ffee00",
    spanId: "c0ffee0000000001",
    name: "agent_turn",
    startTimeUnixNano: "1785693880281989804",
    endTimeUnixNano: "1785693881281989804",
    attributes: [
      { key: "lk.response.text", value: { stringValue: "I am here." } },
    ],
    ...overrides,
  };
}

function jsonExport(spans: readonly Record<string, unknown>[]): string {
  return JSON.stringify({
    resourceSpans: [
      {
        resource: { attributes: [] },
        scopeSpans: [{ scope: { name: "livekit-agents" }, spans }],
      },
    ],
  });
}

describe.skipIf(!storage.available)("evidence at the acceptance boundary", () => {
  const running = storage as Extract<ObjectStorage, { available: true }>;

  let api: TestApi;
  let acme: Customer;
  let secret: string;

  async function post(
    body: string,
    headers: Record<string, string> = {},
  ): Promise<{ statusCode: number; body: string }> {
    const answer = await api.app.inject({
      method: "POST",
      url: OTLP_TRACES_PATH,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${secret}`,
        ...headers,
      },
      payload: body,
    });
    return { statusCode: answer.statusCode, body: answer.body };
  }

  async function countOf(query: string): Promise<number> {
    const traceStore = api.traceStore;
    if (traceStore === undefined) throw new Error("this API has no trace store");
    const [row] = await traceStore.rows<{ n: string }>(query);
    return Number(row?.n ?? -1);
  }

  beforeAll(async () => {
    api = await createApi("ingestion_accept", {
      traceStore: true,
      ingestStore: running.ingestStore,
    });
    acme = await signUp(api.app, "ada@acme.example", "Acme");
    secret = await mintKey(api.app, acme.cookie, "the outbound agent", acme.projectId);
  });

  afterAll(async () => {
    await api?.close();
  });

  it("is in the object store before the request is answered, and in no row yet", async () => {
    const before = await countOf("select count() as n from spans final");

    const answered = await post(jsonExport([jsonSpan()]));
    expect(answered.statusCode, answered.body).toBe(200);

    // The request has been answered, so the promise has been made. Nothing has
    // drained yet, so the only place that promise can be kept is the bucket.
    const pending = await pendingSegments(running.ingestStore);
    expect(pending).toHaveLength(1);
    expect(await countOf("select count() as n from spans final")).toBe(before);

    expect(await drainPendingEvidence(running.ingestStore)).toBe(1);
    expect(await countOf("select count() as n from spans final")).toBe(before + 1);
  });

  it("is one sealed object naming a version, one trusted project, and no credential", async () => {
    const answered = await post(
      jsonExport([
        jsonSpan({
          traceId: "aa11aa11aa11aa11aa11aa11aa11aa11",
          spanId: "aa11aa1100000001",
        }),
      ]),
    );
    expect(answered.statusCode, answered.body).toBe(200);

    const [pending] = await pendingSegments(running.ingestStore);
    if (pending === undefined) throw new Error("nothing was staged");

    expect(pending.key.startsWith(PENDING_PREFIX)).toBe(true);
    expect(pending.header).toMatchObject({
      v: RECORD_FORMAT_VERSION,
      organization_id: acme.organizationId,
      project_id: acme.projectId,
      record_count: 1,
    });
    expect(pending.records).toHaveLength(1);
    expect(pending.records[0]).toMatchObject({
      v: RECORD_FORMAT_VERSION,
      trace_id: "aa11aa11aa11aa11aa11aa11aa11aa11",
      span_id: "aa11aa1100000001",
      source: "production",
    });

    // The key names the segment and nothing else: tenancy is sealed inside the
    // object, where the checksum covers it, so no rename can make an object
    // claim a customer it does not hold.
    expect(pending.key).not.toContain(acme.organizationId);
    expect(pending.key).not.toContain(acme.projectId);

    // And nothing operational rode along. The credential that authenticated
    // the request lives outside the evidence and never enters a record.
    const bytes = JSON.stringify(pending);
    expect(bytes).not.toContain(secret);
    expect(bytes).not.toContain(running.ingestStore.secretAccessKey);
    expect(bytes).not.toContain(running.ingestStore.accessKeyId);

    await drainPendingEvidence(running.ingestStore);
  });

  it("keeps a customer's credential-looking values byte for byte", async () => {
    const transcript =
      "My password is hunter2 and the header said Authorization: Bearer abc.123";
    const answered = await post(
      jsonExport([
        jsonSpan({
          traceId: "bb22bb22bb22bb22bb22bb22bb22bb22",
          spanId: "bb22bb2200000001",
          attributes: [
            { key: "lk.response.text", value: { stringValue: transcript } },
            { key: "api_key", value: { stringValue: "customer-named-this" } },
            {
              key: "session.id",
              value: { stringValue: "Bearer looks-like-one-and-is-not" },
            },
          ],
        }),
      ]),
    );
    expect(answered.statusCode, answered.body).toBe(200);

    const [pending] = await pendingSegments(running.ingestStore);
    const record = pending?.records[0];
    if (record === undefined) throw new Error("nothing was staged");

    expect(record.text).toBe(transcript);
    expect(record.payload).toContain("customer-named-this");
    expect(record.payload).toContain("Bearer looks-like-one-and-is-not");
    expect(JSON.stringify(pending)).not.toContain("REDACTED");

    await drainPendingEvidence(running.ingestStore);
  });

  it("stages nothing at all for a credential the door will not take", async () => {
    const anonymous = await post(jsonExport([jsonSpan()]), {
      authorization: "Bearer egma_sk_not-a-key-this-deployment-minted",
    });
    expect(anonymous.statusCode).toBe(401);
    expect(await pendingSegments(running.ingestStore)).toHaveLength(0);
  });

  it("stages nothing at all for a body the door cannot read", async () => {
    const unreadable = await post("{ not json at all");
    expect(unreadable.statusCode).toBe(400);
    expect(await pendingSegments(running.ingestStore)).toHaveLength(0);
  });

  it("stages only the valid remainder when part of an export is refused", async () => {
    const answered = await post(
      jsonExport([
        jsonSpan({
          traceId: "cc33cc33cc33cc33cc33cc33cc33cc33",
          spanId: "cc33cc3300000001",
        }),
        jsonSpan({ traceId: "not-an-otel-trace-id", spanId: "not-an-id" }),
      ]),
    );
    expect(answered.statusCode, answered.body).toBe(200);
    expect(JSON.parse(answered.body)).toEqual({
      partialSuccess: {
        rejectedSpans: "1",
        errorMessage: expect.any(String),
      },
    });

    const [pending] = await pendingSegments(running.ingestStore);
    expect(pending?.records).toHaveLength(1);
    expect(pending?.records[0]).toMatchObject({
      span_id: "cc33cc3300000001",
    });

    await drainPendingEvidence(running.ingestStore);
  });

  it("refuses a span whose instant the store cannot hold, and stages nothing of it", async () => {
    // A start time far past the trace store's readable ceiling — a broken clock,
    // or an exporter sending the wrong unit — which would seal into a valid
    // segment and then stop the read probe that guards every replay. Refused at
    // the door, the way an oversize field is: a 200 with a count and a reason,
    // never a 5xx and never a staged record.
    const answered = await post(
      jsonExport([
        jsonSpan({
          traceId: "eeff0000eeff0000eeff0000eeff0000",
          spanId: "eeff000000000001",
          startTimeUnixNano: "9".repeat(25),
          endTimeUnixNano: "9".repeat(25),
        }),
        jsonSpan({
          traceId: "eeff0000eeff0000eeff0000eeff0000",
          spanId: "eeff000000000002",
        }),
      ]),
    );

    expect(answered.statusCode, answered.body).toBe(200);
    const refusal = JSON.parse(answered.body) as {
      partialSuccess: { rejectedSpans: string; errorMessage: string };
    };
    expect(refusal.partialSuccess.rejectedSpans).toBe("1");
    expect(refusal.partialSuccess.errorMessage).toContain("trace store holds");

    const [pending] = await pendingSegments(running.ingestStore);
    expect(pending?.records).toHaveLength(1);
    expect(pending?.records[0]?.span_id).toBe("eeff000000000002");
    expect(JSON.stringify(pending)).not.toContain("9999999999999999999999999");

    await drainPendingEvidence(running.ingestStore);
  });

  it("refuses a record over a documented bound by name, and stages neither it nor a shortened one", async () => {
    const tooLong = "n".repeat(1_100);
    const answered = await post(
      jsonExport([
        jsonSpan({
          traceId: "dd44dd44dd44dd44dd44dd44dd44dd44",
          spanId: "dd44dd4400000001",
          name: tooLong,
        }),
        jsonSpan({
          traceId: "dd44dd44dd44dd44dd44dd44dd44dd44",
          spanId: "dd44dd4400000002",
        }),
      ]),
    );

    // A 200 with a count and a reason, which is what the specification says to
    // answer data that must not be retried — never a 5xx an exporter would
    // resend forever, and never a truncated row that reads as a whole one.
    expect(answered.statusCode, answered.body).toBe(200);
    const refusal = JSON.parse(answered.body) as {
      partialSuccess: { rejectedSpans: string; errorMessage: string };
    };
    expect(refusal.partialSuccess.rejectedSpans).toBe("1");
    expect(refusal.partialSuccess.errorMessage).toContain("name");
    expect(refusal.partialSuccess.errorMessage).toContain("1024");
    expect(refusal.partialSuccess.errorMessage).toContain("1100");

    const [pending] = await pendingSegments(running.ingestStore);
    expect(pending?.records).toHaveLength(1);
    expect(pending?.records[0]?.span_id).toBe("dd44dd4400000002");
    expect(JSON.stringify(pending)).not.toContain(tooLong);

    await drainPendingEvidence(running.ingestStore);
  });
});

/**
 * The store stops answering, and the whole promise is tested at once: the
 * refusal a sender can act on, the staged evidence nothing threw away, the
 * upload a later start finishes, and the one visible span a client's retry
 * leaves behind.
 *
 * It gets its own instance because it needs two of them over one local log —
 * which is what a restart is — and because the bound it proves is a second
 * rather than the deployment's ten.
 */
describe.skipIf(!storage.available)("an object store that has gone quiet", () => {
  const running = storage as Extract<ObjectStorage, { available: true }>;
  const logDirectory = mkdtempSync(
    path.join(tmpdir(), "egma-ingestion-restart-"),
  );

  let silent: Awaited<ReturnType<typeof aStoreThatNeverAnswers>>;
  let api: TestApi;
  let restarted: ReturnType<typeof buildApi> | undefined;
  let acme: Customer;
  let secret: string;

  beforeAll(async () => {
    silent = await aStoreThatNeverAnswers();
    api = await createApi("ingestion_unreachable", {
      traceStore: true,
      ingestStore: silent.store,
      ingestionLogDirectory: logDirectory,
      ingestionRequestTimeoutMilliseconds: 700,
    });
    acme = await signUp(api.app, "ada@acme.example", "Acme");
    secret = await mintKey(api.app, acme.cookie, "the outbound agent", acme.projectId);
  });

  afterAll(async () => {
    await restarted?.app.close();
    await api?.close();
    silent?.close();
    rmSync(logDirectory, { recursive: true, force: true });
  });

  it("answers 503, keeps the staged evidence, and lands it once on the next start", async () => {
    const body = jsonExport([
      jsonSpan({
        traceId: "ee55ee55ee55ee55ee55ee55ee55ee55",
        spanId: "ee55ee5500000001",
      }),
    ]);

    const refused = await api.app.inject({
      method: "POST",
      url: OTLP_TRACES_PATH,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${secret}`,
      },
      payload: body,
    });
    // Not a rejection: an exporter stops resending what it is told was
    // rejected, and this evidence is still on its way.
    expect(refused.statusCode).toBe(503);
    expect(refused.json()).toMatchObject({
      code: 14,
      message: expect.stringContaining("send it again"),
    });
    expect(await pendingSegments(running.ingestStore)).toHaveLength(0);

    // The process stops with the record staged and starts again against a
    // store that answers — the same local log, and nothing in it discarded.
    await api.app.close();
    restarted = buildApi({
      config: {
        ...api.config,
        ingestion: { ...api.config.ingestion, store: running.ingestStore },
      },
      retellProductionIngestionIntervalMilliseconds: 60 * 60_000,
      // The recovered segment is left in the bucket to be looked at, which is
      // this file's claim; that it is then drained is the drain suite's.
      drainsPendingEvidence: false,
    });
    await restarted.app.ready();

    await expect
      .poll(async () => (await pendingSegments(running.ingestStore)).length, {
        timeout: 10_000,
      })
      .toBe(1);

    // And the client's retry, which meets evidence already on its way. One
    // immutable identity, so the two are a replay of each other.
    const retried = await restarted.app.inject({
      method: "POST",
      url: OTLP_TRACES_PATH,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${secret}`,
      },
      payload: body,
    });
    expect(retried.statusCode, retried.body).toBe(200);

    await expect
      .poll(async () => (await pendingSegments(running.ingestStore)).length, {
        timeout: 10_000,
      })
      .toBe(2);
    await drainPendingEvidence(running.ingestStore);

    const traceStore = api.traceStore;
    if (traceStore === undefined) throw new Error("this API has no trace store");
    const [spans] = await traceStore.rows<{ n: string }>(
      "select count() as n from spans final " +
        "where trace_id = 'ee55ee55ee55ee55ee55ee55ee55ee55'",
    );
    expect(Number(spans?.n)).toBe(1);
    const [turns] = await traceStore.rows<{ n: string }>(
      "select count() as n from turns final " +
        "where trace_id = 'ee55ee55ee55ee55ee55ee55ee55ee55'",
    );
    expect(Number(turns?.n)).toBe(1);
  });
});

/**
 * A batch naming two projects, one of whose segments the store refuses.
 *
 * **The answer is all or nothing, and no evidence is discarded either way.** A
 * trusted service batch may carry more than one project, each project gets a
 * segment of its own, and the request is a success only once every one of them
 * is durable — so a store that takes one and refuses the other is a retryable
 * refusal for the whole call.
 *
 * What the two halves then are is deliberately different, and both are safe.
 * The project whose segment landed is **durable**, and stays so: an object in
 * the store is not un-made by another project's failure. The project whose
 * segment was refused is **still staged**, and stays so until the store
 * confirms it. A sender's retry meets one of each, and stable identity makes
 * the meeting a replay rather than a duplicate.
 *
 * The fault sits on the wire rather than behind an injected client, so what is
 * proved is the real client meeting a real refusal from something wearing the
 * store's address.
 */
describe.skipIf(!storage.available)("a store that refuses one project's segment", () => {
  const running = storage as Extract<ObjectStorage, { available: true }>;

  let refusing: RefusingStore;
  let api: TestApi;
  let acme: Customer;
  let globex: Customer;

  function groupFor(person: Customer, spanId: string): EvidenceGroup {
    return {
      auth: {
        userId: person.userId,
        organizationId: person.organizationId,
        projectId: person.projectId,
        role: "member",
        via: "api_key",
      },
      spans: [aSpanOf(spanId)],
    };
  }

  beforeAll(async () => {
    if (!storage.available) return;
    refusing = await aStoreRefusingOnePut(running.ingestStore);
    api = await createApi("ingestion_partial_batch", {
      traceStore: true,
      ingestStore: refusing.store,
      // Long enough that the refused segment is still staged when the
      // assertions read it, and short enough that the retry below is prompt.
      ingestionRequestTimeoutMilliseconds: 2_000,
    });
    acme = await signUp(api.app, "ada@acme.example", "Acme");
    globex = await signUp(api.app, "grace@globex.example", "Globex");
  });

  afterAll(async () => {
    await api?.close();
    refusing?.close();
  });

  it("refuses the whole call retryably and keeps both projects' records staged", async () => {
    refusing.refuseEveryPutAfter(1);

    await expect(
      acceptEvidenceForProjects([
        groupFor(acme, "9a9a9a9a00000001"),
        groupFor(globex, "9b9b9b9b00000001"),
      ]),
    ).rejects.toBeInstanceOf(IngestionUnavailableError);

    // Nothing was discarded to make the refusal look tidy. One project's
    // segment reached the store and stays there — a durable object is not
    // un-made by another project's failure — and the project whose segment was
    // refused is still staged, still in hand, still on its way.
    const landed = await pendingSegments(running.ingestStore);
    expect(landed).toHaveLength(1);
    const stillStaged = stagedEvidence();
    expect(stillStaged).toHaveLength(1);
    expect(
      [
        ...landed.map((segment) => segment.header.project_id),
        ...stillStaged.map((one) => one.scope.projectId),
      ].sort(),
    ).toEqual([acme.projectId, globex.projectId].sort());

    // And with the store answering again, the standing loop finishes what is
    // left: one segment for each project, the one that already landed
    // untouched under the identity it was sealed with.
    refusing.stopRefusing();
    await expect
      .poll(async () => (await pendingSegments(running.ingestStore)).length, {
        timeout: 10_000,
      })
      .toBe(2);
    expect(stagedEvidence()).toHaveLength(0);

    const projects = (await pendingSegments(running.ingestStore))
      .map((segment) => segment.header.project_id)
      .sort();
    expect(projects).toEqual([acme.projectId, globex.projectId].sort());

    await drainPendingEvidence(running.ingestStore);
  });
});

/**
 * A store that keeps refusing, and the pace at which Egma asks it again.
 *
 * A sealed segment whose upload failed stays sealed, which is what keeps the
 * evidence — and it also means the group is permanently *due*, so the standing
 * loop would otherwise wake, fail and wake again with nothing between the
 * attempts. Against a store that is refusing quickly, that is a loop as fast as
 * the network answers: it spends this service's capacity and lands on the
 * failing store as a flood, at exactly the moment the store is least able to
 * take one.
 *
 * So an attempt that failed puts its own group aside for a while. The wait
 * starts at the flush interval and doubles up to the request bound — two
 * settings this path already has, rather than a third nobody has tuned — and it
 * ends the moment an attempt succeeds. Nothing is discarded while it waits, and
 * a request that is waiting keeps its own bound and its own `503`.
 */
describe.skipIf(!storage.available)("a store that keeps refusing", () => {
  const running = storage as Extract<ObjectStorage, { available: true }>;

  let refusing: RefusingStore;
  let api: TestApi;
  let acme: Customer;

  beforeAll(async () => {
    if (!storage.available) return;
    refusing = await aStoreRefusingOnePut(running.ingestStore);
    api = await createApi("ingestion_refusing_store", {
      traceStore: true,
      ingestStore: refusing.store,
      ingestionFlushMilliseconds: 100,
      ingestionRequestTimeoutMilliseconds: 1_000,
    });
    acme = await signUp(api.app, "ada@acme.example", "Acme");
  });

  afterAll(async () => {
    await api?.close();
    refusing?.close();
  });

  it("spaces its attempts, keeps the evidence, and lands it once the store answers", async () => {
    refusing.refuseEveryPutAfter(0);

    await expect(
      acceptEvidenceForProjects([
        {
          auth: {
            userId: acme.userId,
            organizationId: acme.organizationId,
            projectId: acme.projectId,
            role: "member",
            via: "api_key",
          },
          spans: [aSpanOf("9c9c9c9c00000001")],
        },
      ]),
    ).rejects.toBeInstanceOf(IngestionUnavailableError);

    // Two seconds of a store saying no. Backing off from a 100ms flush toward
    // a 1s bound is a handful of attempts; rescheduling for *now* on every
    // failure measures in the hundreds against a store on loopback.
    //
    // The refusal is one the store client will not retry inside a single call,
    // deliberately. A retryable status would be paced by that client's own
    // policy — a dependency's property, and one that says nothing about
    // whether this loop waits.
    const before = refusing.putsSeen();
    await new Promise((waited) => setTimeout(waited, 2_000));
    const asked = refusing.putsSeen() - before;
    expect(asked).toBeLessThan(15);
    // And it has not given up either — the segment is still being offered.
    expect(asked).toBeGreaterThan(0);

    // Nothing was discarded to make the waiting cheap.
    expect(stagedEvidence().map((one) => one.record.span_id)).toEqual([
      "9c9c9c9c00000001",
    ]);

    // The first attempt that is answered lands it, once.
    refusing.stopRefusing();
    await expect
      .poll(async () => (await pendingSegments(running.ingestStore)).length, {
        timeout: 10_000,
      })
      .toBe(1);
    expect(stagedEvidence()).toHaveLength(0);

    expect(await drainPendingEvidence(running.ingestStore)).toBe(1);
    const traceStore = api.traceStore;
    if (traceStore === undefined) throw new Error("this API has no trace store");
    const [row] = await traceStore.rows<{ n: string }>(
      "select count() as n from spans final where span_id = '9c9c9c9c00000001'",
    );
    expect(Number(row?.n)).toBe(1);
  });
});
