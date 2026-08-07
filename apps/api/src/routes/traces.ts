import { gunzipSync } from "node:zlib";

import {
  appendSpans,
  authorize,
  NotPermittedError,
  recordProductionTraces,
  TraceStoreRefusedError,
} from "@egma/db";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

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
import {
  EXPORT_TRACE_SERVICE_RESPONSE,
  RPC_STATUS_MESSAGE,
} from "../otlp/schema.ts";

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
 * **What one request may ask for is bounded, and the bound is reported rather
 * than enforced in silence.** A body stops at the size the OpenTelemetry
 * Collector stops at, and an export becomes at most a fixed number of spans and
 * a fixed weight of rows — because every row carries its resource verbatim, so
 * a small request can otherwise become gigabytes of them. What did not fit
 * comes back in the partial-success field, which is the same mechanism a
 * refused span uses.
 *
 * **The response is OTLP's, not egma's.** An exporter reads
 * `ExportTraceServiceResponse` and its partial-success field; inventing a
 * different body would mean every OpenTelemetry SDK on earth mis-reads what
 * happened. Spans egma refuses are reported there — a count and one message —
 * because the specification is explicit that rejected data must not be retried
 * and the client must be told how much of it there was.
 *
 * **A conversation ending here becomes grading work, and nothing more.** The
 * spans are stored, and then one row per trace goes to the grading queue saying
 * when this trace was last heard from and whether its root span closed. That is
 * bookkeeping: a queue write and a notification, on the same terms as the
 * transaction that ends a simulation raising one. No grader is resolved here, no
 * conversation is read back, no judgment is made and no model is called.
 * Judging belongs to a service that holds no request open, and it stays there:
 * a door that judged would make an exporter's timeout depend on how many
 * graders a customer wrote and on how fast somebody else's judge model felt
 * like answering.
 */

export type TraceRoutesOptions = {
  readonly provider: SessionIdentityProvider;
  readonly rateLimit: RateLimit;
};

/** The path OTLP/HTTP defines. Nothing else is served here. */
export const OTLP_TRACES_PATH = "/v1/traces";

/**
 * How much of a body will be read.
 *
 * Twenty mebibytes, which is what the OpenTelemetry Collector's own HTTP
 * receiver accepts by default — so an exporter configured to reach a Collector
 * reaches egma unchanged, and one that would be refused here would have been
 * refused there. An export is one flush of an exporter's batch queue and the
 * SDKs split their own flushes; a cap larger than any of them only decides how
 * much memory a runaway client can ask for.
 */
const MAXIMUM_BODY_BYTES = 20 * 1024 * 1024;

/**
 * The gRPC status codes the specification's `Status` uses, and the two egma
 * answers with. `INVALID_ARGUMENT` is what a body egma cannot read is;
 * `PERMISSION_DENIED` is what a credential that may not write is.
 */
const RPC_INVALID_ARGUMENT = 3;
const RPC_PERMISSION_DENIED = 7;

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
 * A refusal as the specification says to write one: `google.rpc.Status`, in the
 * encoding the request arrived in.
 *
 * An exporter that sent protobuf parses protobuf back — handing it JSON with an
 * egma-shaped body means the one thing it can say about a 400 is that it was a
 * 400, and the reason it was refused never reaches whoever has to fix it. When
 * the encoding is the thing being refused there is none to mirror, and JSON is
 * what a person reading a `curl` sees.
 */
function statusResponse(
  reply: FastifyReply,
  encoding: OtlpEncoding | null,
  httpStatus: number,
  code: number,
  message: string,
): FastifyReply {
  if (encoding !== "protobuf") {
    return reply.code(httpStatus).type("application/json").send({ code, message });
  }

  const status = RPC_STATUS_MESSAGE.create({ code, message });
  return reply
    .code(httpStatus)
    .type("application/x-protobuf")
    .send(Buffer.from(RPC_STATUS_MESSAGE.encode(status).finish()));
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

/**
 * Whether a request carries anything that could name a customer at all.
 *
 * Read off the headers before a byte of the body is, because the body is the
 * expensive part: a client with no credential would otherwise have twenty
 * mebibytes buffered on its behalf before anything asked who it was, and an
 * unauthenticated flood costs the memory of every request in flight. What
 * counts as "something" is deliberately shallow — a bearer token or any cookie
 * at all — because deciding whether a credential is *good* is the resolver's
 * job and this only declines to read a body for a request that named nobody.
 */
function carriesACredential(request: FastifyRequest): boolean {
  return (
    request.headers.authorization !== undefined ||
    request.headers.cookie !== undefined
  );
}

export async function traceRoutes(
  app: FastifyInstance,
  options: TraceRoutesOptions,
): Promise<void> {
  // Before the body parser, which is the whole point: `onRequest` is the one
  // hook Fastify runs with nothing read yet.
  app.addHook("onRequest", async (request, reply) => {
    if (carriesACredential(request)) return undefined;
    return reply.code(401).send({
      error: "not_authenticated",
      message:
        "this request carried no session and no usable API key. " +
        "Sign in, or send Authorization: Bearer with an egma key.",
    });
  });

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
      return statusResponse(
        reply,
        encoding,
        415,
        RPC_INVALID_ARGUMENT,
        "OTLP/HTTP arrives as application/x-protobuf or application/json, " +
          `and this request said ${request.headers["content-type"] ?? "nothing"}.`,
      );
    }

    // Writing telemetry is a write, so it goes through the same function every
    // other write in the product goes through, before the body is looked at.
    // A read-only credential that could still file spans would be read-only in
    // name only.
    try {
      authorize(auth, "ingest_traces", {
        organizationId: auth.organizationId,
        projectId: auth.projectId,
      });
    } catch (cause) {
      if (cause instanceof NotPermittedError) {
        return statusResponse(
          reply,
          encoding,
          403,
          RPC_PERMISSION_DENIED,
          `${cause.message}. Sending an agent's traces is a write, and this ` +
            "key acts at the role of whoever minted it.",
        );
      }
      throw cause;
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
        return statusResponse(
          reply,
          encoding,
          400,
          RPC_INVALID_ARGUMENT,
          cause.message,
        );
      }
      throw cause;
    }

    // Appended once and complete: nothing is read first, nothing is patched,
    // and a batch too large for one insert is split rather than trimmed.
    try {
      await appendSpans(auth, normalised.spans);
    } catch (cause) {
      if (!(cause instanceof TraceStoreRefusedError)) throw cause;

      // The store looked at these rows and said no, and it will say no to the
      // identical bytes forever. A 5xx would be read as "try again later" and
      // an exporter would retry this batch until its queue overflowed, so it
      // is answered the way the specification says to answer data that must
      // not be retried: accepted request, every span rejected, reason given.
      request.log.error({ err: cause }, "the trace store refused a batch");
      return exportResponse(
        reply,
        encoding,
        normalised.spans.length + normalised.rejected.length,
        `the trace store refused these spans: ${cause.message}. They were ` +
          "not stored and re-sending the same batch will not change that.",
      );
    }

    // And the conversations those spans belong to become known to the grading
    // queue: one row per trace, saying when egma last heard about it and whether
    // its root span closed. The same spans go to both calls, so what completion
    // means is read off the telemetry in one place rather than agreed between
    // two.
    //
    // Deliberately not caught. A trace nothing recorded is a trace nothing will
    // ever grade, so an export whose bookkeeping did not land was not accepted:
    // the failure reaches the exporter as a 5xx, which OTLP says to retry, and
    // the retry is byte-identical so the store drops the spans it already has.
    // The door's availability already depends on this database — the credential
    // is resolved from it before a byte of the body is read — so this couples
    // nothing that was not coupled.
    await recordProductionTraces(auth, normalised.spans);

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
