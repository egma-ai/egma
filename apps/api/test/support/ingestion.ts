import { gunzipSync } from "node:zlib";

import { startDrainer } from "../../src/ingestion/drainer.ts";
import {
  pendingObjectStore,
  type IngestionStore,
} from "../../src/ingestion/object-store.ts";
import {
  RECORD_FORMAT_VERSION,
  recordFrom,
  type IngestionRecord,
} from "../../src/ingestion/record.ts";
import type { SegmentHeader } from "../../src/ingestion/segment.ts";

/**
 * One normalized record, with evidence in it that a careless implementation
 * would damage.
 *
 * The default transcript carries the three words a credential scanner reaches
 * for and the tool evidence carries a fourth, because the product's promise is
 * that a transcript does not change because of what it contains. A record built
 * here is what the segment and object-store suites seal, so anything that
 * rewrote, truncated or dropped one of these values would fail where the object
 * is inspected rather than in a unit test of the thing that did it.
 */
export function aRecord(
  overrides: Partial<IngestionRecord> = {},
): IngestionRecord {
  return {
    v: RECORD_FORMAT_VERSION,
    trace_id: "4bf92f3577b34da6a3ce929d0e0e4736",
    span_id: "00f067aa0ba902b7",
    parent_span_id: "",
    source: "production",
    emitter: "agent",
    environment: "default",
    started_at_microseconds: "1755820800000000",
    duration_nanoseconds: "1250000000",
    name: "turn",
    kind: "turn:human",
    status: "ok",
    text: "my password is hunter2, the Bearer token is on the invoice",
    audio_url: "",
    tool_name: "lookup_account",
    tool_arguments: '{"api-key":"kept exactly as the agent sent it"}',
    tool_result: '{"balance":"1200.00"}',
    provider_call_id: "call_9c2f",
    agent_platform: "retell",
    platform_agent_id: "agent_44b1",
    platform_agent_name: "Front desk",
    platform_agent_version: "7",
    connection_kind: "phone",
    run_id: "",
    agent_id: "",
    agent_version_id: "",
    test_version_id: "",
    persona_version_id: "",
    payload: '{"disconnection_reason":"user_hangup"}',
    ends_trace: false,
    ...overrides,
  };
}

/** One pending object, opened: its header line and the records under it. */
export type PendingSegment = {
  readonly key: string;
  readonly header: SegmentHeader;
  readonly records: readonly IngestionRecord[];
};

/** Every pending object in the bucket, opened and checked far enough to read. */
export async function pendingSegments(
  store: IngestionStore,
): Promise<readonly PendingSegment[]> {
  const bucket = pendingObjectStore(store);
  const opened: PendingSegment[] = [];
  for (const object of await bucket.list()) {
    const lines = gunzipSync(Buffer.from(await bucket.read(object.key)))
      .toString("utf8")
      .split("\n")
      .slice(0, -1);
    const [header, ...records] = lines;
    opened.push({
      key: object.key,
      header: JSON.parse(header ?? "{}") as SegmentHeader,
      records: records.map((line) => recordFrom(JSON.parse(line))),
    });
  }
  return opened;
}

/**
 * Every pending object drained, the way the deployment drains one.
 *
 * The real drainer, driven for exactly one pass and then stopped — not a
 * stand-in that repeats its steps. A suite whose claim is about what a reader
 * sees has to carry evidence past the acceptance boundary somehow, and every
 * one of them must do it the same way or they would be proving different
 * things; doing it through the module the deployment runs is what stops this
 * helper from quietly becoming a second implementation of the order that
 * matters.
 *
 * A scan interval far beyond any suite's life, because the one pass is asked
 * for here rather than waited for.
 */
export async function drainPendingEvidence(
  store: IngestionStore,
): Promise<number> {
  const drainer = startDrainer({
    store: pendingObjectStore(store),
    log: { warn: () => undefined, error: () => undefined },
    scanIntervalMilliseconds: 60 * 60_000,
  });
  try {
    return await drainer.drainNow();
  } finally {
    await drainer.stop();
  }
}
