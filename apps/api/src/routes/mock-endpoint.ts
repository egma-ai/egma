import { randomBytes } from "node:crypto";

import {
  appendSpans,
  resolveMockToolCall,
  type MockToolCallTarget,
  type NewSpan,
  type TestMockTool,
} from "@egma/db";
import { traceIdOfSimulation } from "@egma/simulation-contract";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

/**
 * Public GET/POST endpoint for platform-served mock tools:
 * /mock-tools/{simulation}/{tool}. Claims supply the per-call routing URL.
 *
 * Resolve the simulation to its run and pinned test version. Require a live run
 * and a covered tool name. There is no signature or bearer-token check; possession
 * of the simulation URL is sufficient while those conditions hold.
 *
 * Do not read, log, or store request headers or query parameters: the shared draft
 * preserves customer backend credentials for unmocked calls. Record body bytes only;
 * GET arguments mixed with static query parameters are therefore omitted.
 *
 * Write a tool span for served calls and identified uncovered-tool refusals.
 * Display derives mock coverage from the pinned test version. The simulator does
 * not observe this HTTP path. Recording failures are logged without withholding the answer.
 */

/** Where the endpoint answers, under the deployment's own public origin. */
export const MOCK_TOOL_PREFIX = "/mock-tools";

export const MOCK_TOOL_PATH = `${MOCK_TOOL_PREFIX}/:simulationId/:toolName`;

/** Shared base URL for claim routing variables and the public mock endpoint. */
export function mockToolBase(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/u, "")}${MOCK_TOOL_PREFIX}`;
}

/** How each refusal names itself, so two different things stay two. */
export const MOCK_TOOL_REFUSALS = ["no_live_run", "tool_not_mocked"] as const;
export type MockToolRefusal = (typeof MOCK_TOOL_REFUSALS)[number];

type Params = {
  readonly simulationId: string;
  readonly toolName: string;
};

/**
 * Record the HTTP tool exchange with its observed body, answer, and handler timing.
 * The span ends before the recording write and response transmission.
 */
function exchangeSpan(input: {
  readonly target: MockToolCallTarget;
  readonly simulation: MockToolCallTarget["simulation"];
  readonly toolName: string;
  /** What the agent asked with, in the JSON form every reader parses. */
  readonly heardArguments: string;
  readonly served: TestMockTool | undefined;
  readonly answer: string | undefined;
  readonly beganAtMicroseconds: bigint;
  readonly endedAtMicroseconds: bigint;
}): NewSpan | undefined {
  const traceId = traceIdOfSimulation(input.simulation.id);
  if (traceId === undefined) return undefined;

  const refused = input.served === undefined;
  return {
    traceId,
    // Random rather than derived: two calls of one tool inside one simulation
    // are two facts, and a derived id would collapse them into one row.
    spanId: randomBytes(8).toString("hex"),
    // The simulator root span ID is unknown here; do not invent a parent.
    parentSpanId: "",
    source: "simulation",
    emitter: "egma-runtime",
    environment: "default",
    startedAtMicroseconds: input.beganAtMicroseconds,
    durationNanoseconds:
      (input.endedAtMicroseconds - input.beganAtMicroseconds) * 1000n,
    name: "tool_call",
    kind: "tool",
    status: refused ? "error" : "ok",
    text: "",
    audioUrl: "",
    toolName: input.toolName,
    toolArguments: input.heardArguments,
    toolResult: input.answer ?? "",
    providerCallId: "",
    agentPlatform: "retell",
    platformAgentId: "",
    platformAgentName: "",
    platformAgentVersion: "",
    connectionType: "",
    runId: input.target.runId,
    agentId: input.simulation.agentId,
    agentVersionId: "",
    testVersionId: input.simulation.testVersionId,
    personaVersionId: input.simulation.personaVersionId,
    // Display derives mock coverage from the pinned test version; status records refusal.
    payload: JSON.stringify({
      "egma.tool.name": input.toolName,
      "egma.tool.arguments": input.heardArguments,
      ...(refused ? {} : { "egma.tool.result": input.answer }),
    }),
    endsTrace: false,
  };
}

/** Microseconds since the epoch, which is what the span store counts in. */
function nowMicroseconds(): bigint {
  return BigInt(Date.now()) * 1000n;
}

/** Log failed evidence writes without failing the tool answer. */
async function record(
  request: FastifyRequest,
  target: MockToolCallTarget,
  span: NewSpan | undefined,
): Promise<void> {
  if (span === undefined) return;
  try {
    await appendSpans(target.auth, [span]);
  } catch (cause) {
    request.log.error(
      { runId: target.runId, err: cause },
      "a mocked tool exchange could not be written to the record",
    );
  }
}

function refuse(
  reply: FastifyReply,
  status: number,
  refusal: MockToolRefusal,
  sentence: string,
): FastifyReply {
  return reply.code(status).send({ refusal, error: sentence });
}

export async function mockEndpointRoutes(app: FastifyInstance): Promise<void> {
  // Keep body bytes without JSON reserialization. Plugin encapsulation limits
  // these parsers to this endpoint.
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (_request, body, done) => {
      done(null, typeof body === "string" ? body : "");
    },
  );
  app.addContentTypeParser(
    "*",
    { parseAs: "string" },
    (_request, body, done) => {
      done(null, typeof body === "string" ? body : "");
    },
  );

  /** Support both methods because the draft preserves each tool's HTTP method. */
  app.route({
    method: ["GET", "POST"],
    url: MOCK_TOOL_PATH,
    handler: async (request, reply) => {
    const beganAtMicroseconds = nowMicroseconds();
    const params = request.params as Params;
    const rawBody = typeof request.body === "string" ? request.body : "";
    // Read body arguments only. GET query strings mix model arguments with customer
    // credentials, so recording them would expose values this endpoint cannot separate.
    const heardArguments = rawBody;
    // Fastify decodes the tool-name path segment; match the authored name exactly.
    const toolName = params.toolName;

    const target = await resolveMockToolCall(params.simulationId);

    // Gate one. A simulation nobody has heard of and one whose run finished get
    // the same answer, because to this caller they are the same thing.
    if (target === undefined || !target.runIsLive) {
      return refuse(
        reply,
        404,
        "no_live_run",
        "this address does not name a simulation Egma is conducting right now.",
      );
    }
    const simulation = target.simulation;

    // Gate two, the tool. A refusal here is about the mocked world and lands on
    // the record.
    const served = simulation.answers.find(
      (candidate) => candidate.tool === toolName,
    );

    if (served === undefined) {
      await record(
        request,
        target,
        exchangeSpan({
          target,
          simulation,
          toolName,
          heardArguments,
          served: undefined,
          answer: undefined,
          beganAtMicroseconds,
          endedAtMicroseconds: nowMicroseconds(),
        }),
      );
      return refuse(
        reply,
        404,
        "tool_not_mocked",
        "this simulation has no answer for that tool.",
      );
    }

    const failing = "error" in served;
    const body = failing ? { error: served.error } : served.answer;
    // Use the same JSON bytes for the stored answer and response, including scalar values.
    const answer = JSON.stringify(body ?? null) ?? "null";

    await record(
      request,
      target,
      exchangeSpan({
        target,
        simulation,
        toolName,
        heardArguments,
        served,
        answer,
        beganAtMicroseconds,
        endedAtMicroseconds: nowMicroseconds(),
      }),
    );

    // Return HTTP 500 for an authored failure so the agent sees a failed backend call.
    return reply
      .code(failing ? 500 : 200)
      .header("content-type", "application/json; charset=utf-8")
      .send(answer);
    },
  });
}
