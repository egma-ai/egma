import { EXPORT_TRACE_SERVICE_REQUEST } from "./schema.ts";

/**
 * Turning an export request into something egma can read, whichever of the two
 * encodings it arrived in.
 *
 * OTLP/HTTP defines protobuf and JSON over the same message, and the JSON
 * mapping is protobuf's own: `lowerCamelCase` field names, 64-bit numbers as
 * decimal strings because a JSON number cannot hold one, and — the one place
 * the mapping departs from protobuf's defaults — trace and span ids as
 * lowercase hex rather than base64. Both encodings therefore land on the same
 * shape below, and everything downstream is written once.
 *
 * **Parsing is strict and refuses rather than guesses.** A body that is not the
 * message it claims to be is a client defect an exporter will otherwise repeat
 * forever, and answering "fine" to it is how a customer discovers weeks later
 * that nothing was ever stored.
 */

export class NotOtlpError extends Error {
  override readonly name = "NotOtlpError";
}

/** A value on an attribute, as the OTLP JSON mapping writes it. */
export type OtlpValue = {
  readonly stringValue?: string;
  readonly boolValue?: boolean;
  readonly intValue?: string | number;
  readonly doubleValue?: number;
  readonly arrayValue?: { readonly values?: readonly OtlpValue[] };
  readonly kvlistValue?: { readonly values?: readonly OtlpAttribute[] };
  readonly bytesValue?: string;
};

export type OtlpAttribute = {
  readonly key: string;
  readonly value?: OtlpValue;
};

export type OtlpEvent = {
  readonly timeUnixNano?: string;
  readonly name?: string;
  readonly attributes?: readonly OtlpAttribute[];
};

export type OtlpStatus = {
  readonly message?: string;
  /** The name in both encodings, or the number a hand-written client sends. */
  readonly code?: string | number;
};

export type OtlpSpan = {
  /** Lowercase hex, both encodings. Empty when the exporter sent none. */
  readonly traceId?: string;
  readonly spanId?: string;
  readonly parentSpanId?: string;
  readonly name?: string;
  readonly kind?: string;
  readonly startTimeUnixNano?: string;
  readonly endTimeUnixNano?: string;
  readonly attributes?: readonly OtlpAttribute[];
  readonly events?: readonly OtlpEvent[];
  readonly links?: readonly unknown[];
  readonly status?: OtlpStatus;
  readonly traceState?: string;
};

export type OtlpScope = {
  readonly name?: string;
  readonly version?: string;
  readonly attributes?: readonly OtlpAttribute[];
};

export type OtlpScopeSpans = {
  readonly scope?: OtlpScope;
  readonly spans?: readonly OtlpSpan[];
  readonly schemaUrl?: string;
};

export type OtlpResource = {
  readonly attributes?: readonly OtlpAttribute[];
};

export type OtlpResourceSpans = {
  readonly resource?: OtlpResource;
  readonly scopeSpans?: readonly OtlpScopeSpans[];
  readonly schemaUrl?: string;
};

export type OtlpExport = {
  readonly resourceSpans?: readonly OtlpResourceSpans[];
};

/** The two encodings OTLP/HTTP defines. No gRPC, per the spec. */
export type OtlpEncoding = "protobuf" | "json";

const PROTOBUF_TYPES = ["application/x-protobuf", "application/protobuf"];
const JSON_TYPES = ["application/json"];

/**
 * Which encoding a request is in, or nothing if egma does not speak it. The
 * parameters after a `;` — a charset, a proto descriptor — are not part of the
 * decision.
 */
export function encodingOf(contentType: string | undefined): OtlpEncoding | null {
  const type = (contentType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (PROTOBUF_TYPES.includes(type)) return "protobuf";
  if (JSON_TYPES.includes(type)) return "json";
  return null;
}

function hex(bytes: Uint8Array | undefined): string {
  return bytes === undefined ? "" : Buffer.from(bytes).toString("hex");
}

/**
 * The decoded protobuf as the JSON mapping's shape.
 *
 * `longs: String` because a 64-bit nanosecond timestamp is larger than a JS
 * number can hold exactly, and losing its low digits would move a span's
 * recorded start time — the one value ticket 09 requires be replayed
 * byte-identically. `bytes: Array` so ids can be hexed here rather than
 * arriving base64 and being converted somewhere further away from the wire.
 */
function fromProtobuf(body: Uint8Array): OtlpExport {
  let decoded: unknown;
  try {
    const message = EXPORT_TRACE_SERVICE_REQUEST.decode(body);
    decoded = EXPORT_TRACE_SERVICE_REQUEST.toObject(message, {
      longs: String,
      enums: String,
      bytes: Array,
      defaults: false,
      arrays: false,
      objects: false,
      oneofs: false,
    });
  } catch (cause) {
    throw new NotOtlpError(
      "this body is not an ExportTraceServiceRequest in protobuf. " +
        "Send OTLP/HTTP with Content-Type: application/x-protobuf, or the " +
        "same message as JSON.",
      { cause },
    );
  }

  const request = decoded as {
    resourceSpans?: {
      resource?: OtlpResource;
      schemaUrl?: string;
      scopeSpans?: {
        scope?: OtlpScope;
        schemaUrl?: string;
        spans?: (Omit<OtlpSpan, "traceId" | "spanId" | "parentSpanId"> & {
          traceId?: Uint8Array;
          spanId?: Uint8Array;
          parentSpanId?: Uint8Array;
        })[];
      }[];
    }[];
  };

  return {
    resourceSpans: (request.resourceSpans ?? []).map((resourceSpans) => ({
      ...resourceSpans,
      scopeSpans: (resourceSpans.scopeSpans ?? []).map((scopeSpans) => ({
        ...scopeSpans,
        spans: (scopeSpans.spans ?? []).map((span) => ({
          ...span,
          traceId: hex(span.traceId),
          spanId: hex(span.spanId),
          parentSpanId: hex(span.parentSpanId),
        })),
      })),
    })),
  };
}

/**
 * The JSON encoding, read exactly as strictly as the protobuf one.
 *
 * The shape is checked here rather than trusted, because JSON has no schema on
 * the wire to check it for us: a body of `[]`, or one whose `resourceSpans` is
 * a string, would otherwise reach the normaliser as an export containing
 * nothing and be answered with a cheerful 200.
 */
function fromJson(body: Uint8Array): OtlpExport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body).toString("utf8"));
  } catch (cause) {
    throw new NotOtlpError("this body is not JSON.", { cause });
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new NotOtlpError(
      "an OTLP/JSON export is an object with a resourceSpans array on it.",
    );
  }

  const request = parsed as { resourceSpans?: unknown };
  if (request.resourceSpans === undefined) return { resourceSpans: [] };
  if (!Array.isArray(request.resourceSpans)) {
    throw new NotOtlpError("resourceSpans is an array.");
  }

  for (const resourceSpans of request.resourceSpans as unknown[]) {
    if (typeof resourceSpans !== "object" || resourceSpans === null) {
      throw new NotOtlpError("every entry of resourceSpans is an object.");
    }
    const scopeSpans = (resourceSpans as { scopeSpans?: unknown }).scopeSpans;
    if (scopeSpans === undefined) continue;
    if (!Array.isArray(scopeSpans)) {
      throw new NotOtlpError("scopeSpans is an array.");
    }
    for (const scope of scopeSpans as unknown[]) {
      if (typeof scope !== "object" || scope === null) {
        throw new NotOtlpError("every entry of scopeSpans is an object.");
      }
      const spans = (scope as { spans?: unknown }).spans;
      if (spans === undefined) continue;
      if (!Array.isArray(spans)) throw new NotOtlpError("spans is an array.");
      for (const span of spans as unknown[]) {
        if (typeof span !== "object" || span === null) {
          throw new NotOtlpError("every entry of spans is an object.");
        }
      }
    }
  }

  return parsed as OtlpExport;
}

export function decodeOtlpExport(
  encoding: OtlpEncoding,
  body: Uint8Array,
): OtlpExport {
  return encoding === "protobuf" ? fromProtobuf(body) : fromJson(body);
}
