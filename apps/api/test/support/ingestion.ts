import {
  RECORD_FORMAT_VERSION,
  type IngestionRecord,
} from "../../src/ingestion/record.ts";

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
