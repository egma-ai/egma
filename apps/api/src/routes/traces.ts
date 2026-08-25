import { gunzipSync } from "node:zlib";

import {
  authorize,
  NotPermittedError,
  resolveSimulationStanding,
  type AuthContext,
  type NewSpan,
  type SimulationStanding,
} from "@egma/db";
import { traceIdOfSimulation } from "@egma/simulation-contract";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { requesterOf } from "../http/credentialed.ts";
import {
  acceptEvidence,
  acceptEvidenceForProjects,
  IngestionUnavailableError,
  type EvidenceGroup,
} from "../ingestion/accept.ts";
import {
  notAuthenticated,
  tooManyRequests,
  wrongServiceToken,
} from "../http/refusals.ts";
import type { RateLimit } from "../http/rate-limit.ts";
import { resolveRequester } from "../auth/requester.ts";
import {
  acceptsServiceToken,
  wearsServiceTokenPrefix,
} from "../auth/service-token.ts";
import type { SessionIdentityProvider } from "../auth/seam.ts";
import { toIdentityRequest } from "../http/web-handler.ts";
import {
  decodeOtlpExport,
  encodingOf,
  NotOtlpError,
  type OtlpEncoding,
  type OtlpResourceSpans,
} from "../otlp/decode.ts";
import {
  normaliseOtlpExport,
  simulationNamedBy,
  SIMULATION_ID_ATTRIBUTE,
  type SpanAttribution,
} from "../otlp/normalise.ts";
import {
  EXPORT_TRACE_SERVICE_RESPONSE,
  RPC_STATUS_MESSAGE,
} from "../otlp/schema.ts";

/**
 * The ingest door: `POST /v1/traces`, OTLP/HTTP, protobuf or JSON.
 *
 * It is the standard path a configured OpenTelemetry exporter posts to.
 * LiveKit customers configure that exporter with the explicit Egma
 * Python SDK helper; other runtimes must configure their own exporter. **One
 * door**, for customer agents and for egma's own simulator — one wire format,
 * one code path, and a simulation and a production trace therefore arrive the
 * same way and are the same shape at rest.
 *
 * **The door branches on the credential, and only there.** A customer key
 * resolves tenancy as it always has. The deployment's own service token — the
 * same secret the claim door answers to — resolves to no customer at all:
 * each arriving resource must say which simulation its spans are evidence of
 * (`egma.simulation_id`), and the door resolves the organization, the project
 * and the run from that simulation's own row. Spans are accepted for any
 * simulation this deployment conducted, whatever its status: a late-returning
 * orphan's spans are evidence and are kept, even as its lifecycle claims are
 * refused elsewhere.
 *
 * **The organization and the project come from the credential, or from egma's
 * own row — never from the payload.** A tenancy attribute in the payload is
 * not refused and not obeyed — it is simply not consulted, the way a reserved
 * attribute is treated by every platform that learned this lesson the
 * expensive way. The rows the data-access module writes have no organization
 * on them for a handler to set, so this is a property of the shape rather than
 * of anyone's care. The simulation id a resource names is not a tenancy claim:
 * it names a conversation, and whose it is is read off the row egma wrote.
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
 * **The door decodes and hands over, and that is the whole of what it does.**
 * Authentication, decompression, decoding, tenant resolution and normalization
 * happen here, and then the evidence goes to the one acceptance module — which
 * answers when it is durable in the object store and not before. Nothing here
 * writes a trace row, updates Monitoring health or names a grader. Those are
 * effects of evidence being *query-visible*, which happens later and elsewhere,
 * and a door that performed them would be claiming an outcome it cannot see:
 * an exporter's timeout would depend on a store's cold start, and a request
 * answered before a durable copy existed would be a promise nothing kept.
 *
 * **`503` is the one new answer, and it means *not yet*.** Evidence that could
 * not be made durable inside the request's bound is still staged and is
 * retryable, which is exactly what an OTLP exporter does with a 5xx. Evidence
 * this side refuses — a malformed span, a reserved environment, a record over a
 * documented bound — is still reported the way the specification says to report
 * data that must not be retried: a 200 carrying a count and a reason.
 */

export type TraceRoutesOptions = {
  readonly provider: SessionIdentityProvider;
  readonly rateLimit: RateLimit;
  /** The deployment's service token, from configuration — the second credential. */
  readonly serviceToken: string;
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
 * The gRPC status codes the specification's `Status` uses, and the three egma
 * answers with. `INVALID_ARGUMENT` is what a body egma cannot read is;
 * `PERMISSION_DENIED` is what a credential that may not write is; `UNAVAILABLE`
 * is evidence this side could not make durable yet, which is the one refusal a
 * sender is meant to try again.
 */
const RPC_INVALID_ARGUMENT = 3;
const RPC_PERMISSION_DENIED = 7;
const RPC_UNAVAILABLE = 14;
/** What an unexpected failure on this side is, and the one an exporter retries. */
const RPC_INTERNAL = 13;

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
      `this body says it is ${encoding}-encoded, and Egma reads identity and gzip.`,
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

declare module "fastify" {
  interface FastifyRequest {
    /** Set by the gate below: this request holds the deployment's own token. */
    simulatorIngest: boolean;
  }
}

/**
 * A trace id as OpenTelemetry writes one: 16 bytes of lowercase hex. Matched
 * before a span's own is held against the trace its simulation spells, so that
 * an id which is not one at all stays normalisation's business rather than
 * this door's.
 */
const A_TRACE_ID = /^[0-9a-f]{32}$/u;

/**
 * The spans of one customer's simulations, with the context they are filed
 * under. One export may carry several simulations — even several customers' —
 * so the resources are gathered by the tenancy their rows resolved to, and
 * each gathering is appended under its own narrowed context, because that
 * context is the only place an organization ever enters a row.
 */
type AttributedGroup = {
  readonly auth: AuthContext;
  readonly resources: OtlpResourceSpans[];
};

/**
 * The simulator's own path through the door.
 *
 * By the time this runs, the gate has already matched the service token, and
 * the token resolves to nobody — so the first real work is attribution: every
 * resource must name its simulation, every named simulation must be one this
 * deployment conducted, and both are settled before a single row is built.
 * Attribution is all-or-nothing on purpose. A resource that cannot be
 * attributed is an emitter defect, not a partial success: answering 200 for
 * it would tell the sender's write-ahead log the evidence landed when it has
 * nowhere to land, and the refusal is terminal (a 400 is never retried) so
 * the defect surfaces in the simulator's log instead of looping.
 *
 * Whatever the simulation's status. The row is looked up, never inspected: a
 * late flush for a simulation the sweep already called orphaned is evidence
 * arriving after the messenger was marked terminal, and it is kept.
 *
 * A refusal here is `google.rpc.Status`, like every refusal on this door —
 * the sender is an OTLP exporter before it is anything else — with the
 * sentence written for whoever reads the simulator's log: what happened, and
 * what to send instead.
 */
async function simulatorExport(
  request: FastifyRequest,
  reply: FastifyReply,
  encoding: OtlpEncoding,
): Promise<FastifyReply> {
  const body = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);

  let decoded;
  try {
    decoded = decodeOtlpExport(
      encoding,
      decompressed(body, request.headers["content-encoding"]),
    );
  } catch (cause) {
    if (cause instanceof NotOtlpError) {
      return statusResponse(reply, encoding, 400, RPC_INVALID_ARGUMENT, cause.message);
    }
    throw cause;
  }

  const resources = decoded.resourceSpans ?? [];
  const named: string[] = [];
  for (const resourceSpans of resources) {
    const simulationId = simulationNamedBy(resourceSpans);
    if (simulationId === "") {
      return statusResponse(
        reply,
        encoding,
        400,
        RPC_INVALID_ARGUMENT,
        "a resource in this export names no simulation. Spans posted with " +
          `the service token are a simulation's evidence, so every resource ` +
          `carries the ${SIMULATION_ID_ATTRIBUTE} resource attribute holding ` +
          "the simulation_id from the claimed spec, exactly as it was handed " +
          "over. Nothing from this request was stored.",
      );
    }
    named.push(simulationId);
  }

  // Each named simulation resolved to where it stands — the same asking the
  // heartbeat and report doors make about a row, because arriving spans are
  // one more call coming back about it. The standing is looked up and never
  // inspected: whatever state the row is in, its telemetry files under it.
  const targets = new Map<string, SimulationStanding>();
  for (const simulationId of new Set(named)) {
    const standing = await resolveSimulationStanding(simulationId);
    if (standing !== undefined) targets.set(simulationId, standing);
  }
  const unknown = named.find((simulationId) => !targets.has(simulationId));
  if (unknown !== undefined) {
    return statusResponse(
      reply,
      encoding,
      400,
      RPC_INVALID_ARGUMENT,
        `there is no simulation ${unknown} on this Egma instance, so its spans have ` +
        "nowhere to file. A simulation id arrives inside a claimed spec and " +
        "is echoed verbatim — check the resource attribute against the spec, " +
        "and check the simulator is pointed at the deployment that handed " +
        "the work out. Nothing from this request was stored.",
    );
  }

  /*
   * And every span is filed under the trace its own simulation's id spells.
   *
   * **This is what stops a transcript playing the wrong conversation's audio.**
   * A simulation id and its trace id are the same 128 bits written two ways,
   * and both directions of that derivation are load-bearing reads: a reader
   * opening a transcript converts the trace id back into a simulation id to
   * find its grades, and — since ticket 03 — to resolve its recording. So a
   * resource that named simulation A while filing its spans under B's trace
   * would hand whoever opened that transcript B's turns beside A's audio, both
   * inside one organization, with nothing anywhere saying they disagree.
   *
   * Nothing egma ships can do it: the simulator derives the trace from the id
   * it was handed and authors every span itself, forwarding none. That is
   * exactly why it is checked here rather than trusted — the invariant is worth
   * more than the emitter's current good behaviour, and an emitter that took a
   * trace id from a provider instead would be a one-line change over there and
   * a wrong recording over here.
   *
   * Refused whole, like every other attribution failure at this door: a partial
   * success would tell the sender's write-ahead log that evidence landed when
   * it landed somewhere nobody will look, and the 400 is terminal so the defect
   * surfaces in the simulator's log rather than looping. A malformed id is
   * deliberately not this check's business — normalisation already rejects
   * those span by span, and widening this to catch them would turn a per-span
   * rejection into a whole refused export.
   */
  for (const [index, resourceSpans] of resources.entries()) {
    const simulationId = named[index] ?? "";
    const belongsUnder = traceIdOfSimulation(simulationId);
    if (belongsUnder === undefined) continue;

    for (const scopeSpans of resourceSpans.scopeSpans ?? []) {
      for (const span of scopeSpans.spans ?? []) {
        const filedUnder = (span.traceId ?? "").toLowerCase();
        if (!A_TRACE_ID.test(filedUnder) || filedUnder === belongsUnder) {
          continue;
        }
        return statusResponse(
          reply,
          encoding,
          400,
          RPC_INVALID_ARGUMENT,
          `a span of simulation ${simulationId} is filed under trace ` +
            `${filedUnder}, and that simulation's spans belong under ` +
            `${belongsUnder}. The two are the same 128 bits written twice, so ` +
            "derive the trace id from the simulation id rather than taking " +
            "one from a provider — filing under another simulation's trace " +
            "would show a reader that conversation's turns beside this one's " +
            "audio. Nothing from this request was stored.",
        );
      }
    }
  }

  // Gathered by the customer each simulation resolved to, in arrival order —
  // the stamp is per resource, the append is per customer, and neither is
  // anything the payload said.
  const groups = new Map<string, AttributedGroup>();
  for (const [index, resourceSpans] of resources.entries()) {
    const target = targets.get(named[index] ?? "");
    if (target === undefined) continue;
    const key = `${target.auth.organizationId}/${target.auth.projectId ?? ""}`;
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, { auth: target.auth, resources: [resourceSpans] });
    } else {
      group.resources.push(resourceSpans);
    }
  }

  const attributionFor = (resourceSpans: OtlpResourceSpans): SpanAttribution => {
    const target = targets.get(simulationNamedBy(resourceSpans));
    if (target === undefined) {
      // Every resource was checked against the map before any group was
      // normalised, so this is this file having lost track of its own input.
      throw new Error("a resource lost its simulation between checks");
    }
    return {
      source: "simulation",
      emitter: "egma-runtime",
      runId: target.runId,
      agentId: target.agentId,
      testVersionId: target.testVersionId ?? "",
      personaVersionId: target.personaVersionId,
    };
  };

  const rejected: { count: number; firstReason: string } = {
    count: 0,
    firstReason: "",
  };
  const accepting: EvidenceGroup[] = [];
  for (const group of groups.values()) {
    // Normalised per gathering, so the row caps guard each customer's append
    // rather than the request: a bound loosened only by naming more
    // customers' simulations, which only the deployment's own simulator can.
    const normalised = normaliseOtlpExport(
      { resourceSpans: group.resources },
      attributionFor,
    );
    rejected.count += normalised.rejected.length;
    rejected.firstReason ||= normalised.rejected[0]?.reason ?? "";

    // The same function every write in the product goes through, asked with
    // the narrowed context the row resolved to. It cannot refuse a context
    // the module itself built — which is the point of asking: a change that
    // made it refusable would surface here, not in a customer's missing rows.
    authorize(group.auth, "ingest_traces", {
      organizationId: group.auth.organizationId,
      projectId: group.auth.projectId,
    });

    accepting.push({ auth: group.auth, spans: normalised.spans });
  }

  // Every group in one call, and one answer for all of them: a batch naming
  // several projects gets a segment each, and it is a success only once every
  // one of them is durable. A per-group answer would tell the simulator its
  // whole flush landed while one project's evidence was still in a local log —
  // and the retry that follows a refusal replays the groups that did land,
  // which stable span identity makes a no-op rather than a duplicate.
  let accepted;
  try {
    accepted = await acceptEvidenceForProjects(accepting);
  } catch (cause) {
    if (!(cause instanceof IngestionUnavailableError)) throw cause;
    return unavailable(request, reply, encoding, cause);
  }

  // One truthful answer: the normaliser's rejects plus the records acceptance
  // refused by name, and nothing that landed. The field is one string, and a
  // named field over its bound is the more actionable of the two, so it speaks
  // first.
  return exportResponse(
    reply,
    encoding,
    rejected.count + accepted.refused.length,
    accepted.refused[0]?.reason ?? rejected.firstReason,
  );
}

/**
 * Evidence that could not be made durable in time, answered as *not yet*.
 *
 * `503` rather than a rejection, because the two are read differently and only
 * one of them is true here: an OTLP exporter retries a 5xx and stops resending
 * data reported as rejected. The staged copy is still on this side's disk and
 * still on its way to the object store, so a retry meeting it is a replay of
 * one immutable identity and produces one visible span. The body is the same
 * `google.rpc.Status` every other refusal on this door uses, in the encoding
 * the request arrived in.
 */
function unavailable(
  request: FastifyRequest,
  reply: FastifyReply,
  encoding: OtlpEncoding,
  cause: IngestionUnavailableError,
): FastifyReply {
  request.log.error({ err: cause }, "evidence could not be made durable");
  return statusResponse(reply, encoding, 503, RPC_UNAVAILABLE, cause.message);
}

export async function traceRoutes(
  app: FastifyInstance,
  options: TraceRoutesOptions,
): Promise<void> {
  // The one place an unexpected throw is answered, and it is answered as OTLP's
  // — not egma's, and never with the cause. A failure with no status of its own
  // can carry an absolute local-log path or an ordinal in its message, and the
  // body is read by an exporter and logged where an exporter's operator sees it;
  // so the cause goes to this side's log alone and the sender gets one generic
  // sentence and a status it retries. Everything a handler means to say — a
  // refusal, a partial success, `503` — it returns rather than throws, so this
  // catches only what nobody meant to happen.
  //
  // A framework refusal the door itself did not raise — a body over the cap is
  // the one that reaches here — arrives with its own status and a generic
  // message that names no evidence and no path, so it keeps both.
  app.setErrorHandler((error: unknown, request, reply) => {
    const encoding = encodingOf(request.headers["content-type"]);
    const framework = error as { statusCode?: unknown; message?: unknown };
    if (typeof framework.statusCode === "number" && framework.statusCode < 500) {
      return statusResponse(
        reply,
        encoding,
        framework.statusCode,
        RPC_INVALID_ARGUMENT,
        typeof framework.message === "string"
          ? framework.message
          : "this export could not be read.",
      );
    }
    request.log.error({ err: error }, "the trace door could not answer an export");
    return statusResponse(
      reply,
      encoding,
      500,
      RPC_INTERNAL,
      "Egma could not accept this export. Nothing about the failure is echoed " +
        "here; if it continues, it is a fault on Egma's side rather than " +
        "anything wrong with the request. Try again.",
    );
  });

  // Before the body parser, which is the whole point: `onRequest` is the one
  // hook Fastify runs with nothing read yet.
  app.addHook("onRequest", async (request, reply) => {
    if (carriesACredential(request)) return undefined;
    return reply.code(401).send({
      error: "not_authenticated",
      message:
        "this request carried no session and no usable API key. " +
        "Sign in, or send Authorization: Bearer with an Egma key.",
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

  // This door serves two credentials, so it carries `credentialed`'s hook
  // spelled out rather than calling it: the service token is checked first,
  // in constant time, and resolves to nobody — there is no requester to hand
  // the shared hook, and no organization to key its rate limit on. The token
  // is the gate here, exactly as on the claim door, and everything after it
  // is checked per resolved row. Anything else falls through to the customer
  // branch, which is `credentialed`'s own body line for line: the same
  // resolver, the same budget, the same refusals — so the customer path is
  // the path it always was.
  app.decorateRequest("requester", null);
  app.decorateRequest("simulatorIngest", false);
  app.addHook("onRequest", async (request, reply) => {
    if (acceptsServiceToken(request.headers.authorization, options.serviceToken)) {
      request.simulatorIngest = true;
      return undefined;
    }
    // Wearing the prefix without the secret is a mis-provisioned simulator,
    // not a customer: it gets the fix in the service's own vocabulary rather
    // than advice about signing in, and it never reaches the resolver — the
    // prefix already says no customer key could be under it.
    if (wearsServiceTokenPrefix(request.headers.authorization)) {
      return wrongServiceToken(reply);
    }

    const requester = await resolveRequester(
      options.provider,
      toIdentityRequest(request),
    );
    if (requester === null) {
      return notAuthenticated(reply);
    }

    const verdict = options.rateLimit.reached(requester.auth.organizationId);
    if (!verdict.allowed) {
      return tooManyRequests(reply, verdict.retryAfterSeconds);
    }

    request.requester = requester;
    return undefined;
  });

  app.post(OTLP_TRACES_PATH, async (request, reply) => {
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

    if (request.simulatorIngest) {
      return simulatorExport(request, reply, encoding);
    }

    const { auth } = requesterOf(request);

    // Production telemetry must name the project it belongs to. An
    // organization-wide key cannot provide that fact, and accepting the body
    // would leave valid-looking spans that no Monitoring page or grader owns.
    // Refuse it before decoding so the customer gets one clear setup error and
    // no part of the export can land under a storage sentinel.
    if (auth.projectId === undefined) {
      return statusResponse(
        reply,
        encoding,
        403,
        RPC_PERMISSION_DENIED,
        "Production trace export requires a project API key. Create a key " +
          "for the project you want to monitor, then use that key for OTLP export.",
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

    // Handed over once and complete, and answered only when it is durable in
    // the ingestion object store. Monitoring health and the grader-owned
    // evidence-ready handoff are effects of that evidence becoming
    // query-visible, so they belong to whatever reads the segment back — not
    // to a door that would be asserting them about rows nobody has written.
    let accepted;
    try {
      accepted = await acceptEvidence(normalised.spans, { auth });
    } catch (cause) {
      if (!(cause instanceof IngestionUnavailableError)) throw cause;
      return unavailable(request, reply, encoding, cause);
    }

    return exportResponse(
      reply,
      encoding,
      normalised.rejected.length + accepted.refused.length,
      // One message, because the field is one string. A record over a
      // documented bound names the field and the two numbers, which is the
      // more actionable of the two, so it speaks first; the rest of either
      // kind is the same mistake repeated.
      accepted.refused[0]?.reason ?? normalised.rejected[0]?.reason ?? "",
    );
  });
}
