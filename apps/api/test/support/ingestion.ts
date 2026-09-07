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
 * Include secret-like words in transcript and tool evidence to detect
 * content-based redaction during segment and object-store processing.
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
 * Run one pass of the production drainer before query assertions. Set a long
 * scan interval so the test controls when that pass occurs, then stop it.
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
