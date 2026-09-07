import { gunzipSync } from "node:zlib";

import {
  authorize,
  NotPermittedError,
  resolveSimulationByProviderReference,
  resolveSimulationStanding,
  type SimulationStanding,
} from "@egma/db";
import { traceIdOfSimulation } from "@egma/simulation-contract";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { requesterOf } from "../http/credentialed.ts";
import {
  IngestionUnavailableError,
  type EvidenceGroup,
} from "../ingestion/accept.ts";
import {
  attributionOf,
  fileSimulationEvidence,
  type SimulationFiling,
} from "../ingestion/simulation-ingestion.ts";
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
  budgetForOneRequest,
  normaliseOtlpExport,
  providerReferenceClaimedBy,
  simulationNamedBy,
  PROVIDER_REFERENCE_ATTRIBUTE,
  SIMULATION_ID_ATTRIBUTE,
  type NormalisationBudget,
} from "../otlp/normalise.ts";
import {
  EXPORT_TRACE_SERVICE_RESPONSE,
  RPC_STATUS_MESSAGE,
} from "../otlp/schema.ts";

/**
 * Accept OTLP/HTTP exports as protobuf or JSON.
 *
 * The service token attributes resources through simulation IDs stored in this
 * deployment. Customer credentials supply organization and project scope; a
 * provider reference selects simulation evidence, and its absence selects
 * production evidence. Late simulation evidence is accepted regardless of status.
 *
 * Body, span, and normalized-row limits bound each request. Use OTLP responses
 * for decoding errors and partial rejections. Acceptance waits for object-store
 * durability; temporary failures return 503 for retry. Query visibility and
 * grading follow later in the drainer.
 */

export type TraceRoutesOptions = {
  readonly provider: SessionIdentityProvider;
  readonly rateLimit: RateLimit;
  /** The deployment's service token, from configuration — the second credential. */
  readonly serviceToken: string;
};

/** The path OTLP/HTTP defines. Nothing else is served here. */
export const OTLP_TRACES_PATH = "/v1/traces";

/** Bound both the buffered request and its decompressed body to 20 MiB. */
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
 * Encode google.rpc.Status in the request encoding. Use JSON when the request
 * encoding is unknown.
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
 * Reject requests without authorization or cookie headers before buffering
 * the body. Header presence is only an early check; resolution validates it.
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
 * Limit provider references quoted in errors so an attribute cannot inflate the response.
 */
const LONGEST_QUOTED_REFERENCE = 200;

/**
 * How many conversations one project-key export may speak for.
 *
 * The egma SDK exports from one agent process, which is in one room, so one is
 * the ordinary number and a handful covers a process that has moved on to the
 * next simulation before its exporter flushed. More than that is a
 * misconfiguration, and it is bounded because each distinct reference costs a
 * store lookup before anything is normalised.
 */
const MOST_SIMULATIONS_PER_EXPORT = 8;

function shortened(reference: string): string {
  return reference.length <= LONGEST_QUOTED_REFERENCE
    ? reference
    : `${reference.slice(0, LONGEST_QUOTED_REFERENCE)}…`;
}

/**
 * The resources of one simulation, gathered before anything is normalised.
 *
 * One export may carry several simulations — even, on the service path,
 * several customers' — and each is filed on its own, under its own row's
 * tenancy and its own pins. **Never blended**: a resource whose simulation
 * resolved elsewhere must not drag another conversation's spans along with it,
 * so the gathering key is the simulation and not the customer.
 */
type SimulationResources = {
  readonly standing: SimulationStanding;
  readonly resources: OtlpResourceSpans[];
};

/**
 * Gather one export's resources by the simulation each of them named, in
 * arrival order.
 *
 * `standingOf` is how this door found the row — by simulation id on the service
 * path, by provider reference on the project-key path — and a resource it
 * answers `undefined` for was already refused before this runs.
 */
function gatheredBySimulation(
  resources: readonly OtlpResourceSpans[],
  standingOf: (resourceSpans: OtlpResourceSpans) => SimulationStanding | undefined,
): SimulationResources[] {
  const gathered = new Map<string, SimulationResources>();
  for (const resourceSpans of resources) {
    const standing = standingOf(resourceSpans);
    if (standing === undefined) continue;
    const held = gathered.get(standing.id);
    if (held === undefined) {
      gathered.set(standing.id, { standing, resources: [resourceSpans] });
    } else {
      held.resources.push(resourceSpans);
    }
  }
  return [...gathered.values()];
}

/** Normalize each simulation separately while sharing one request-wide row budget. */
function normalisedFilings(
  gathered: readonly SimulationResources[],
  emitter: "egma-runtime" | "agent",
  rejected: { count: number; firstReason: string },
  budget: NormalisationBudget,
): SimulationFiling[] {
  return gathered.map((one) => {
    const normalised = normaliseOtlpExport(
      { resourceSpans: one.resources },
      () => attributionOf(one.standing, emitter),
      budget,
    );
    rejected.count += normalised.rejected.length;
    rejected.firstReason ||= normalised.rejected[0]?.reason ?? "";

    // The same function every write in the product goes through, asked with
    // the narrowed context the row resolved to. It cannot refuse a context
    // the module itself built — which is the point of asking: a change that
    // made it refusable would surface here, not in a customer's missing rows.
    authorize(one.standing.auth, "ingest_traces", {
      organizationId: one.standing.auth.organizationId,
      projectId: one.standing.auth.projectId,
    });

    return { standing: one.standing, emitter, spans: normalised.spans };
  });
}

/**
 * The service token has already been checked. Resolve every resource to a
 * stored simulation before building rows; unknown attribution rejects the
 * whole export. Accept late evidence for terminal simulations too.
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
   * Reject valid trace IDs that do not derive from the named simulation ID.
   * Transcript grades and recordings use this mapping, so a mismatch could pair
   * one simulation with another's evidence. Normalization handles malformed IDs
   * as individual span rejections.
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

  // Gathered by the simulation each resource named, in arrival order, and
  // normalised with the stamp that simulation's own row answers — the persona's
  // POV, because the service token is egma's own simulator and nothing else.
  const rejected: { count: number; firstReason: string } = {
    count: 0,
    firstReason: "",
  };
  const filings = normalisedFilings(
    gatheredBySimulation(resources, (resourceSpans) =>
      targets.get(simulationNamedBy(resourceSpans)),
    ),
    "egma-runtime",
    rejected,
    budgetForOneRequest(),
  );

  // Every filing in one call, and one answer for all of them: a batch naming
  // several projects gets a segment each, and it is a success only once every
  // one of them is durable. A per-group answer would tell the simulator its
  // whole flush landed while one project's evidence was still in a local log —
  // and the retry that follows a refusal replays the groups that did land,
  // which stable span identity makes a no-op rather than a duplicate.
  let accepted;
  try {
    accepted = await fileSimulationEvidence(filings);
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
 * Return retryable 503 when evidence cannot become durable within the request
 * bound. Any staged copy remains eligible for upload; repeated span identities
 * are handled by the storage replay rules.
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
  // Preserve framework client-error status codes in OTLP format. Log unexpected
  // errors locally and return a generic retryable error so internal paths or
  // evidence do not appear in the response.
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

    let decoded;
    try {
      decoded = decodeOtlpExport(
        encoding,
        decompressed(body, request.headers["content-encoding"]),
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

    /*
     * Resources with a provider reference are simulation agent POV evidence.
     * Resolve the reference within the credential's project; resources without
     * one are production evidence.
     */
    const resources = decoded.resourceSpans ?? [];
    // Claimed once per resource, and the answer carried, because the two
    // filters below are complements: a resource that claims a reference and
    // one that does not must be built from the same reading, or a resource
    // whose claim this door could not read would fall through both into
    // production. `providerReferenceClaimedBy` says why the claim can come
    // from the resource or from the spans.
    const claimed = new Map(
      resources.map((one) => [one, providerReferenceClaimedBy(one)] as const),
    );
    const naming = resources.filter(
      (one) => claimed.get(one)?.kind !== "none",
    );
    const named = (one: OtlpResourceSpans): string => {
      const claim = claimed.get(one);
      return claim?.kind === "named" ? claim.reference : "";
    };

    // Stamped spans that disagree name no one conversation, so there is
    // nothing to look up and nothing safe to guess: one export from one agent
    // process is one conversation, and filing a disagreeing resource under
    // either answer would put one customer's turns on another's record. A span
    // that carries no reference at all is not this case — it opened before the
    // SDK's stamp existed and is filed under what the rest of the resource
    // says, which `providerReferenceClaimedBy` explains.
    const disagreeing = naming.find(
      (one) => claimed.get(one)?.kind === "disagreeing",
    );
    if (disagreeing !== undefined) {
      const claim = claimed.get(disagreeing);
      const references =
        claim?.kind === "disagreeing" ? claim.references : [];
      return statusResponse(
        reply,
        encoding,
        400,
        RPC_INVALID_ARGUMENT,
        `a resource in this export has spans that do not agree on ` +
          `${PROVIDER_REFERENCE_ATTRIBUTE} (${references
            .map((one) => `"${shortened(one)}"`)
            .join(", ")}). One agent process runs one conversation, so the ` +
          `spans under one resource that carry a reference all name the same ` +
          `room or call — spans naming two name no conversation to file them ` +
          `under. Export each room from the process running it. Nothing from ` +
          `this request was stored.`,
      );
    }

    // A malformed export before anything is looked up, because an empty
    // reference has nothing to look up: the sender said these spans are a
    // simulation's and left out which. Refused whole, like every other
    // attribution failure at this door, and told apart from a reference that
    // simply matched nothing — quoting an empty string back would name nothing
    // for the developer to go and fix.
    if (naming.some((one) => named(one) === "")) {
      return statusResponse(
        reply,
        encoding,
        400,
        RPC_INVALID_ARGUMENT,
        `a resource in this export carries ${PROVIDER_REFERENCE_ATTRIBUTE} ` +
          `with no value. The attribute says these spans are a simulation's ` +
          `agent POV, and its value is the room or call the conversation ran ` +
          `in — so an empty one names no conversation to file them under. ` +
          `Stamp the room name the simulation was reported with, or leave the ` +
          `attribute off entirely and the spans are production. Nothing from ` +
          `this request was stored.`,
      );
    }

    const references = new Set(naming.map(named));
    /*
     * How many conversations one export may speak for.
     *
     * The SDK exports one room from one agent process, so a request naming more
     * than a handful of them is a misconfiguration rather than a use. The bound
     * is here because everything after it costs: one store lookup per distinct
     * reference before a byte is normalised, and one segment per simulation
     * after. The row caps below bound the bytes; this bounds the lookups.
     */
    if (references.size > MOST_SIMULATIONS_PER_EXPORT) {
      return statusResponse(
        reply,
        encoding,
        400,
        RPC_INVALID_ARGUMENT,
        `this export names ${references.size} conversations by ` +
          `${PROVIDER_REFERENCE_ATTRIBUTE}, and Egma files at most ` +
          `${MOST_SIMULATIONS_PER_EXPORT} from one request. An agent process ` +
          `runs one room at a time, so an export naming more than a few is a ` +
          `configuration mistake rather than a batch — export each room from ` +
          `the process running it. Nothing from this request was stored.`,
      );
    }

    const carriers = new Map<string, SimulationStanding>();
    for (const reference of references) {
      const standing = await resolveSimulationByProviderReference(auth, reference);
      if (standing === undefined) {
        /*
         * Reject the whole export before storage. Unknown and out-of-project
         * references get the same response to avoid revealing another project's data.
         */
        return statusResponse(
          reply,
          encoding,
          400,
          RPC_INVALID_ARGUMENT,
          `no simulation in this project carries the provider reference ` +
            `"${shortened(reference)}". Spans posted with ${PROVIDER_REFERENCE_ATTRIBUTE} ` +
            `on the resource are a simulation's agent POV, and the reference ` +
            `is the room or call the conversation ran in — check the key names ` +
            `the project the run belongs to, and that the SDK stamps the same ` +
            `reference the simulation was reported with. Nothing from this ` +
            `request was stored.`,
        );
      }
      carriers.set(reference, standing);
    }

    const rejected: { count: number; firstReason: string } = {
      count: 0,
      firstReason: "",
    };
    // One budget for the whole request, spent by every call below: the caps
    // bound what one request can ask this side for, and naming several
    // simulations must not buy several times the bound.
    const budget: NormalisationBudget = budgetForOneRequest();

    // Production, exactly as today: one normalisation of everything that
    // carried no reference at all, under the credential's own context. An
    // export with no simulation resources — every export before this branch
    // existed — reaches acceptance as the one group it always was.
    const production = normaliseOtlpExport(
      {
        resourceSpans: resources.filter(
          (resourceSpans) => claimed.get(resourceSpans)?.kind === "none",
        ),
      },
      undefined,
      budget,
    );
    rejected.count += production.rejected.length;
    rejected.firstReason ||= production.rejected[0]?.reason ?? "";
    const alongside: EvidenceGroup[] = [{ auth, spans: production.spans }];

    const filings = normalisedFilings(
      gatheredBySimulation(naming, (resourceSpans) =>
        carriers.get(named(resourceSpans)),
      ),
      "agent",
      rejected,
      budget,
    );

    // Handed over once and complete, and answered only when it is durable in
    // the ingestion object store. Monitoring health and the grader-owned
    // evidence-ready handoff are effects of that evidence becoming
    // query-visible, so they belong to whatever reads the segment back — not
    // to a door that would be asserting them about rows nobody has written.
    let accepted;
    try {
      accepted = await fileSimulationEvidence(filings, alongside);
    } catch (cause) {
      if (!(cause instanceof IngestionUnavailableError)) throw cause;
      return unavailable(request, reply, encoding, cause);
    }

    return exportResponse(
      reply,
      encoding,
      rejected.count + accepted.refused.length,
      // One message, because the field is one string. A record over a
      // documented bound names the field and the two numbers, which is the
      // more actionable of the two, so it speaks first; the rest of either
      // kind is the same mistake repeated.
      accepted.refused[0]?.reason ?? rejected.firstReason,
    );
  });
}
