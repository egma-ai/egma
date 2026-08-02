import protobuf from "protobufjs";

/**
 * The OpenTelemetry trace wire format, as the door has to be able to read it.
 *
 * Transcribed from `opentelemetry-proto` v1.9.0 — `common/v1/common.proto`,
 * `resource/v1/resource.proto`, `trace/v1/trace.proto` and
 * `collector/trace/v1/trace_service.proto` — with the upstream comments and the
 * per-language `option` lines left out and nothing else changed. Field numbers,
 * field types and message nesting are what decide whether bytes off the wire
 * come back as the values that were sent, so those are exactly upstream's.
 *
 * It is a string in a TypeScript file rather than four `.proto` files beside it
 * because the compiled service is what runs in a container: `tsc` emits
 * JavaScript and copies nothing, so a `.proto` on disk would be present when the
 * tests run from source and missing the moment the image starts. Refreshing it
 * means re-transcribing from a named upstream tag, which is the same discipline
 * the captured fixture is refreshed under.
 *
 * **Reading is all this is for.** Nothing in egma writes OTLP; the one message
 * encoded here is the response the specification requires the door to answer
 * with.
 */

const COMMON = `
syntax = "proto3";
package opentelemetry.proto.common.v1;

message AnyValue {
  oneof value {
    string string_value = 1;
    bool bool_value = 2;
    int64 int_value = 3;
    double double_value = 4;
    ArrayValue array_value = 5;
    KeyValueList kvlist_value = 6;
    bytes bytes_value = 7;
  }
}

message ArrayValue {
  repeated AnyValue values = 1;
}

message KeyValueList {
  repeated KeyValue values = 1;
}

message KeyValue {
  string key = 1;
  AnyValue value = 2;
}

message InstrumentationScope {
  string name = 1;
  string version = 2;
  repeated KeyValue attributes = 3;
  uint32 dropped_attributes_count = 4;
}

message EntityRef {
  string schema_url = 1;
  string type = 2;
  repeated string id_keys = 3;
  repeated string description_keys = 4;
}
`;

const RESOURCE = `
syntax = "proto3";
package opentelemetry.proto.resource.v1;

message Resource {
  repeated opentelemetry.proto.common.v1.KeyValue attributes = 1;
  uint32 dropped_attributes_count = 2;
  repeated opentelemetry.proto.common.v1.EntityRef entity_refs = 3;
}
`;

const TRACE = `
syntax = "proto3";
package opentelemetry.proto.trace.v1;

message TracesData {
  repeated ResourceSpans resource_spans = 1;
}

message ResourceSpans {
  reserved 1000;
  opentelemetry.proto.resource.v1.Resource resource = 1;
  repeated ScopeSpans scope_spans = 2;
  string schema_url = 3;
}

message ScopeSpans {
  opentelemetry.proto.common.v1.InstrumentationScope scope = 1;
  repeated Span spans = 2;
  string schema_url = 3;
}

message Span {
  bytes trace_id = 1;
  bytes span_id = 2;
  string trace_state = 3;
  bytes parent_span_id = 4;
  fixed32 flags = 16;
  string name = 5;
  enum SpanKind {
    SPAN_KIND_UNSPECIFIED = 0;
    SPAN_KIND_INTERNAL = 1;
    SPAN_KIND_SERVER = 2;
    SPAN_KIND_CLIENT = 3;
    SPAN_KIND_PRODUCER = 4;
    SPAN_KIND_CONSUMER = 5;
  }
  SpanKind kind = 6;
  fixed64 start_time_unix_nano = 7;
  fixed64 end_time_unix_nano = 8;
  repeated opentelemetry.proto.common.v1.KeyValue attributes = 9;
  uint32 dropped_attributes_count = 10;
  message Event {
    fixed64 time_unix_nano = 1;
    string name = 2;
    repeated opentelemetry.proto.common.v1.KeyValue attributes = 3;
    uint32 dropped_attributes_count = 4;
  }
  repeated Event events = 11;
  uint32 dropped_events_count = 12;
  message Link {
    bytes trace_id = 1;
    bytes span_id = 2;
    string trace_state = 3;
    repeated opentelemetry.proto.common.v1.KeyValue attributes = 4;
    uint32 dropped_attributes_count = 5;
    fixed32 flags = 6;
  }
  repeated Link links = 13;
  uint32 dropped_links_count = 14;
  Status status = 15;
}

message Status {
  reserved 1;
  string message = 2;
  enum StatusCode {
    STATUS_CODE_UNSET = 0;
    STATUS_CODE_OK = 1;
    STATUS_CODE_ERROR = 2;
  }
  StatusCode code = 3;
}

enum SpanFlags {
  SPAN_FLAGS_DO_NOT_USE = 0;
  SPAN_FLAGS_TRACE_FLAGS_MASK = 0x000000FF;
  SPAN_FLAGS_CONTEXT_HAS_IS_REMOTE_MASK = 0x00000100;
  SPAN_FLAGS_CONTEXT_IS_REMOTE_MASK = 0x00000200;
}
`;

const TRACE_SERVICE = `
syntax = "proto3";
package opentelemetry.proto.collector.trace.v1;

message ExportTraceServiceRequest {
  repeated opentelemetry.proto.trace.v1.ResourceSpans resource_spans = 1;
}

message ExportTraceServiceResponse {
  ExportTracePartialSuccess partial_success = 1;
}

message ExportTracePartialSuccess {
  int64 rejected_spans = 1;
  string error_message = 2;
}
`;

/**
 * One root holding all four, parsed in dependency order. `parse` adds types to
 * the root it is given and resolves nothing by itself, so a reference across
 * packages is settled by the `resolveAll` below rather than by reaching for a
 * file that is not there.
 */
function buildRoot(): protobuf.Root {
  const root = new protobuf.Root();
  for (const source of [COMMON, RESOURCE, TRACE, TRACE_SERVICE]) {
    protobuf.parse(source, root);
  }
  root.resolveAll();
  return root;
}

const root = buildRoot();

export const EXPORT_TRACE_SERVICE_REQUEST = root.lookupType(
  "opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest",
);

export const EXPORT_TRACE_SERVICE_RESPONSE = root.lookupType(
  "opentelemetry.proto.collector.trace.v1.ExportTraceServiceResponse",
);
