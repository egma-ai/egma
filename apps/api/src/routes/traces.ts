import { gunzipSync } from "node:zlib";

import { appendSpans } from "@egma/db";
import type { FastifyInstance, FastifyReply } from "fastify";

import { credentialed, requesterOf } from "../http/credentialed.ts";
import type { RateLimit } from "../http/rate-limit.ts";
import type { SessionIdentityProvider } from "../auth/seam.ts";
import {
  decodeOtlpExport,
  encodingOf,
  NotOtlpError,
  type OtlpEncoding,
} from "../otlp/decode.ts";
import { normaliseOtlpExport } from "../otlp/normalise.ts";
import { EXPORT_TRACE_SERVICE_RESPONSE } from "../otlp/schema.ts";

/**
 * The ingest door: `POST /v1/traces`, OTLP/HTTP, protobuf or JSON.
 *
 * It is the standard path an OpenTelemetry exporter posts to, so a customer's
 * agent reaches egma by setting two environment variables and writing no
 * integration code. **One door**, for the customer's agent now and for egma's
 * own simulation runtime later — one wire format, one code path, and a
 * simulation and a production trace therefore arrive the same way and are the
 * same shape at rest.
 *
 * **The organization and the project come from the credential.** A tenancy
 * attribute in the payload is not refused and not obeyed — it is simply not
 * consulted, the way a reserved attribute is treated by every platform that
 * learned this lesson the expensive way. The rows the data-access module writes
 * have no organization on them for a handler to set, so this is a property of
 * the shape rather than of anyone's care.
 *
 * **The response is OTLP's, not egma's.** An exporter reads
 * `ExportTraceServiceResponse` and its partial-success field; inventing a
 * different body would mean every OpenTelemetry SDK on earth mis-reads what
 * happened. Spans egma refuses are reported there — a count and one message —
 * because the specification is explicit that rejected data must not be retried
 * and the client must be told how much of it there was.
 */

export type TraceRoutesOptions = {
  readonly provider: SessionIdentityProvider;
  readonly rateLimit: RateLimit;
};

/** The path OTLP/HTTP defines. Nothing else is served here. */
export const OTLP_TRACES_PATH = "/v1/traces";

/**
 * How much of a body will be read. An export is one flush of an exporter's
 * batch queue, and a cap several times larger than any of them keeps a runaway
 * client from being answered with the whole of memory.
 */
const MAXIMUM_BODY_BYTES = 64 * 1024 * 1024;

/**
 * The one compression OTLP/HTTP names, and what most exporters are configured
 * with. An encoding egma cannot undo is refused rather than stored as bytes
 * nobody can read.
 */
function decompressed(
  body: Buffer,
  contentEncoding: string | undefined,
): Buffer {
  const encoding = (contentEncoding ?? "").trim().toLowerCase();
  if (encoding === "" || encoding === "identity") return body;
  if (encoding !== "gzip") {
    throw new NotOtlpError(
      `this body says it is ${encoding}-encoded, and egma reads identity and gzip.`,
    );
  }

  try {
    // Bounded by the same limit the uncompressed path is, because otherwise a
    // few kilobytes of zeroes expand into as much memory as they like.
    return gunzipSync(body, { maxOutputLength: MAXIMUM_BODY_BYTES });
  } catch (cause) {
    throw new NotOtlpError(
      "this body says it is gzipped and does not decompress, or decompresses " +
        "to more than one export could reasonably be.",
      { cause },
    );
  }
}

/**
 * The specification's own response message, in the encoding the request came
 * in. An exporter sending protobuf parses protobuf back.
 */
function exportResponse(
  reply: FastifyReply,
  encoding: OtlpEncoding,
  rejected: number,
  errorMessage: string,
): FastifyReply {
  const partial =
    rejected === 0
      ? {}
      : {
          partialSuccess: {
            rejectedSpans: String(rejected),
            errorMessage,
          },
        };

  if (encoding === "json") {
    return reply.code(200).type("application/json").send(partial);
  }

  const message = EXPORT_TRACE_SERVICE_RESPONSE.create(
    rejected === 0
      ? {}
      : { partialSuccess: { rejectedSpans: rejected, errorMessage } },
  );
  return reply
    .code(200)
    .type("application/x-protobuf")
    .send(Buffer.from(EXPORT_TRACE_SERVICE_RESPONSE.encode(message).finish()));
}

export async function traceRoutes(
  app: FastifyInstance,
  options: TraceRoutesOptions,
): Promise<void> {
  // The body reaches the handler as the bytes that were sent. Protobuf is not
  // text and the JSON encoding is parsed strictly by the decoder rather than
  // loosely by the framework, so both arrive here unread. Registered inside
  // this plugin's scope, which is what keeps every other route's parser intact.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser(
    "*",
    { parseAs: "buffer", bodyLimit: MAXIMUM_BODY_BYTES },
    (_request, body, done) => {
      done(null, body);
    },
  );

  credentialed(app, {
    provider: options.provider,
    rateLimit: options.rateLimit,
  });

  app.post(OTLP_TRACES_PATH, async (request, reply) => {
    const { auth } = requesterOf(request);

    const encoding = encodingOf(request.headers["content-type"]);
    if (encoding === null) {
      return reply.code(415).send({
        error: "unsupported_encoding",
        message:
          "OTLP/HTTP arrives as application/x-protobuf or application/json, " +
          `and this request said ${request.headers["content-type"] ?? "nothing"}.`,
      });
    }

    const body = Buffer.isBuffer(request.body)
      ? request.body
      : Buffer.alloc(0);

    let normalised;
    try {
      normalised = normaliseOtlpExport(
        decodeOtlpExport(
          encoding,
          decompressed(body, request.headers["content-encoding"]),
        ),
      );
    } catch (cause) {
      if (cause instanceof NotOtlpError) {
        return reply
          .code(400)
          .send({ error: "not_otlp", message: cause.message });
      }
      throw cause;
    }

    // Appended once and complete: nothing is read first, nothing is patched,
    // and a batch too large for one insert is split rather than trimmed.
    await appendSpans(auth, normalised.spans);

    return exportResponse(
      reply,
      encoding,
      normalised.rejected.length,
      // One message, because the field is one string. The first refusal is the
      // one a developer needs; the rest are the same mistake repeated.
      normalised.rejected[0]?.reason ?? "",
    );
  });
}
