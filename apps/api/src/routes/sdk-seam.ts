import {
  authorize,
  LARGEST_MOCK_TOOL_ANSWER_BYTES,
  NotPermittedError,
  recordAgentReport,
  resolveLiveDailyRoomSimulation,
  type AgentReportTool,
  type AuthContext,
  type LiveDailyRoomSimulation,
  type NewAgentReport,
  type TestMockTool,
} from "@egma/db";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { resolveApiKeyRequest } from "../auth/api-key.ts";
import type { RateLimit } from "../http/rate-limit.ts";
import { tooManyRequests } from "../http/refusals.ts";
import { toIdentityRequest } from "../http/web-handler.ts";
import { platformEvent } from "../platform-log.ts";

/**
 * The mock-tool seam a Pipecat bot speaks with egma over HTTPS.
 *
 * The egma SDK in the customer's bot calls these routes with the project API
 * key and the provider reference the start request carried (the simulation's
 * id). The messages are the in-room seam's: the same protocol version, hello
 * census and reply, tagged tool answer, refusal codes and answer cap. The
 * routes sit outside the documented platform API, like the OTLP door.
 *
 * A reference that does not name a live Daily room simulation of the key's
 * project answers one 404 body, which is the only answer that makes the SDK
 * inert. A hello that reaches that check is recorded on the simulation so the
 * simulator can learn that the agent reported; a tool call records nothing,
 * because the agent's own spans are the tool record.
 */

export type SdkSeamRoutesOptions = {
  /** The organization request budget `/v1/traces` spends from. */
  readonly rateLimit: RateLimit;
};

export const SDK_HELLO_PATH = "/sdk/v1/hello";
export const SDK_TOOL_PATH = "/sdk/v1/tool";
export const SDK_CONFIRM_PATH = "/sdk/v1/confirm";

/** The one version of the exchange egma speaks. */
const PROTOCOL_VERSION = 1;

/** Request body caps, per route. */
const LARGEST_HELLO_BYTES = 256 * 1024;
const LARGEST_TOOL_BYTES = 64 * 1024;
const LARGEST_CONFIRM_BYTES = 4 * 1024;

/** A provider reference longer than this names no simulation egma minted. */
const LONGEST_PROVIDER_REFERENCE = 512;

const MALFORMED_REQUEST = 901;
const UNKNOWN_TOOL = 902;
const ANSWER_TOO_LARGE = 903;
const UNSUPPORTED_PROTOCOL_VERSION = 904;
const FLOWS_FUNCTION_MOCKED = 905;

const NOT_A_SIMULATION = {
  error: "not_a_simulation",
  message:
    "This provider reference does not name a live Egma simulation in this API key's project.",
} as const;

const NOT_AUTHENTICATED = {
  error: "not_authenticated",
  message:
    "The Egma SDK needs your project API key in Authorization: Bearer egma_sk_…",
} as const;

const NOT_PROJECT_SCOPED = {
  error: "not_permitted",
  message:
    "The Egma SDK needs a project API key; this key is not scoped to one project.",
} as const;

const CANNOT_SEND_TRACES = {
  error: "not_permitted",
  message:
    "The Egma SDK needs a project API key that may send traces; this key acts at a role that cannot.",
} as const;

const MALFORMED_HELLO =
  'egma.hello carries the agent\'s tools as a list of {"name": …} objects and names the simulation in provider_reference; this one does not.';

const MALFORMED_TOOL =
  "egma.tool names the tool being called and carries its arguments as a JSON object or not at all; this one does not.";

const MALFORMED_CONFIRM =
  "egma.confirm names the simulation in provider_reference; this one does not.";

type SeamRefusal = {
  readonly error: "seam_refused" | "flows_function_mocked";
  readonly code: number;
  readonly message: string;
};

declare module "fastify" {
  interface FastifyRequest {
    /** Set by the gate below: the project key's context. */
    sdkAuth: AuthContext | null;
  }
}

function refused(reply: FastifyReply, refusal: SeamRefusal): FastifyReply {
  return reply.code(422).send(refusal);
}

function seamRefused(code: number, message: string): SeamRefusal {
  return { error: "seam_refused", code, message };
}

function notASimulation(reply: FastifyReply): FastifyReply {
  return reply.code(404).send(NOT_A_SIMULATION);
}

/** Answer exactly these bytes as JSON. */
function sendJson(reply: FastifyReply, bytes: string): FastifyReply {
  return reply
    .code(200)
    .header("content-type", "application/json; charset=utf-8")
    .send(bytes);
}

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The body as a JSON value, or `undefined` for bytes that are not JSON. */
function parsed(body: unknown): unknown {
  if (typeof body !== "string") return undefined;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
}

/** A provider reference the lookup can take, or `undefined`. */
function providerReferenceIn(body: Record<string, unknown>): string | undefined {
  const reference = body.provider_reference;
  if (
    typeof reference !== "string" ||
    reference.trim() === "" ||
    reference.length > LONGEST_PROVIDER_REFERENCE
  ) {
    return undefined;
  }
  return reference;
}

type Census = {
  readonly providerReference: string;
  readonly protocolVersion: unknown;
  /** The census entries as sent, in the stored report's shape. */
  readonly tools: readonly AgentReportTool[];
};

/** A hello this exchange can read, or `undefined` for a 901. */
function censusIn(body: unknown): Census | undefined {
  if (!isObject(body)) return undefined;
  const providerReference = providerReferenceIn(body);
  if (providerReference === undefined) return undefined;
  if (!Array.isArray(body.tools)) return undefined;

  const tools: AgentReportTool[] = [];
  for (const entry of body.tools as unknown[]) {
    if (!isObject(entry)) return undefined;
    const { name, schema, flows } = entry;
    if (typeof name !== "string" || name.trim() === "") return undefined;
    if (flows !== undefined && typeof flows !== "boolean") return undefined;
    tools.push({
      name,
      ...(schema === undefined ? {} : { schema }),
      ...(flows === true ? { flows: true as const } : {}),
    });
  }
  return { providerReference, protocolVersion: body.protocol_version, tools };
}

/** How a declared protocol version is quoted back in the 904 sentence. */
function declaredVersion(version: unknown): string {
  if (version === undefined) return "none";
  if (typeof version === "number") return String(version);
  return JSON.stringify(version) ?? "none";
}

/** The 905 sentence for the mocked Flows functions, in census order. */
function flowsRefusal(names: readonly string[]): SeamRefusal {
  const quoted = names.map((name) => `"${name}"`).join(", ");
  const message =
    names.length === 1
      ? `the test mocks ${quoted}, and this is a Pipecat Flows function; Egma cannot mock it yet. ` +
        "Remove it from the test's mock tools. Flows functions that are not mocked run for real and are recorded."
      : `the test mocks ${quoted}, and these are Pipecat Flows functions; Egma cannot mock them yet. ` +
        "Remove them from the test's mock tools. Flows functions that are not mocked run for real and are recorded.";
  return { error: "flows_function_mocked", code: FLOWS_FUNCTION_MOCKED, message };
}

/** Every mocked tool name, in the order the test authored them. */
function mockedNames(simulation: LiveDailyRoomSimulation): string[] {
  return simulation.answers.map((answer) => answer.tool);
}

/** The refusal a hello earns after the live check, or `undefined` for none. */
function helloRefusal(
  census: Census,
  mocked: readonly string[],
  reply: string,
): SeamRefusal | undefined {
  if (census.protocolVersion !== PROTOCOL_VERSION) {
    return seamRefused(
      UNSUPPORTED_PROTOCOL_VERSION,
      `this hello speaks protocol version ${declaredVersion(census.protocolVersion)}, ` +
        `and Egma speaks ${PROTOCOL_VERSION}. Upgrade the egma package.`,
    );
  }

  const mockedSet = new Set(mocked);
  const flowsMocked: string[] = [];
  for (const tool of census.tools) {
    const name = tool.name.trim();
    if (tool.flows === true && mockedSet.has(name) && !flowsMocked.includes(name)) {
      flowsMocked.push(name);
    }
  }
  if (flowsMocked.length > 0) return flowsRefusal(flowsMocked);

  const bytes = utf8Bytes(reply);
  if (bytes > LARGEST_MOCK_TOOL_ANSWER_BYTES) {
    return seamRefused(
      ANSWER_TOO_LARGE,
      `the list of tools Egma answers for is ${String(bytes)} bytes, more than ` +
        `the ${String(LARGEST_MOCK_TOOL_ANSWER_BYTES)} the exchange carries.`,
    );
  }
  return undefined;
}

/** The tagged answer, byte for byte as the in-room seam serves it. */
function taggedAnswer(mock: TestMockTool): string {
  return JSON.stringify("error" in mock ? { error: mock.error } : { answer: mock.answer ?? null });
}

type ToolCall = {
  readonly providerReference: string;
  readonly name: string;
  readonly flows: boolean;
};

/** A tool call this exchange can read, or `undefined` for a 901. */
function toolCallIn(body: unknown): ToolCall | undefined {
  if (!isObject(body)) return undefined;
  const providerReference = providerReferenceIn(body);
  if (providerReference === undefined) return undefined;
  const { name, arguments: args, flows } = body;
  if (typeof name !== "string" || name.trim() === "") return undefined;
  if (args !== undefined && args !== null && !isObject(args)) return undefined;
  if (flows !== undefined && typeof flows !== "boolean") return undefined;
  return { providerReference, name: name.trim(), flows: flows === true };
}

/** The project key's context, set by the gate before any route runs. */
function sdkAuthOf(request: FastifyRequest): AuthContext {
  const auth = request.sdkAuth;
  if (auth === null) {
    throw new Error("an SDK seam route ran without the key gate");
  }
  return auth;
}

export async function sdkSeamRoutes(
  app: FastifyInstance,
  options: SdkSeamRoutesOptions,
): Promise<void> {
  // The body reaches the handlers as text, so an unreadable body is this
  // seam's own 901 rather than the framework's parse error. Registered inside
  // this plugin's scope, which keeps every other route's parser intact.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("*", { parseAs: "string" }, (_request, body, done) => {
    done(null, typeof body === "string" ? body : "");
  });

  // The project key is the gate, resolved before the body is read. A session
  // cookie opens nothing here: the caller is the SDK in the customer's bot.
  app.decorateRequest("sdkAuth", null);
  app.addHook("onRequest", async (request, reply) => {
    const key = await resolveApiKeyRequest(toIdentityRequest(request));
    if (key === null) return reply.code(401).send(NOT_AUTHENTICATED);

    const { auth } = key;
    if (auth.projectId === undefined) {
      return reply.code(403).send(NOT_PROJECT_SCOPED);
    }
    try {
      authorize(auth, "ingest_traces", {
        organizationId: auth.organizationId,
        projectId: auth.projectId,
      });
    } catch (cause) {
      if (cause instanceof NotPermittedError) {
        return reply.code(403).send(CANNOT_SEND_TRACES);
      }
      throw cause;
    }

    const verdict = options.rateLimit.reached(auth.organizationId);
    if (!verdict.allowed) {
      return tooManyRequests(reply, verdict.retryAfterSeconds);
    }

    request.sdkAuth = auth;
    return undefined;
  });

  /**
   * The census in, the names egma answers for out. Every hello that reaches
   * the live check replaces the simulation's stored agent report.
   */
  app.post(SDK_HELLO_PATH, { bodyLimit: LARGEST_HELLO_BYTES }, async (request, reply) => {
    const auth = sdkAuthOf(request);
    const census = censusIn(parsed(request.body));
    if (census === undefined) {
      return refused(reply, seamRefused(MALFORMED_REQUEST, MALFORMED_HELLO));
    }

    const simulation = await resolveLiveDailyRoomSimulation(auth, census.providerReference);
    if (simulation === undefined) return notASimulation(reply);

    const mocked = mockedNames(simulation);
    const answer = JSON.stringify({
      protocol_version: PROTOCOL_VERSION,
      mocked_tools: mocked,
    });
    const refusal = helloRefusal(census, mocked, answer);

    const report: NewAgentReport =
      refusal === undefined
        ? { state: "accepted", tools: census.tools, mockedTools: mocked }
        : {
            state: "refused",
            code: refusal.code,
            message: refusal.message,
            tools: census.tools,
          };
    const recorded = await recordAgentReport(auth, simulation.simulationId, report);
    // The row left claimed/running between the lookup and the write.
    if (!recorded) return notASimulation(reply);

    request.log.info(
      platformEvent(
        refusal === undefined ? "egma.sdk.hello.accepted" : "egma.sdk.hello.refused",
        refusal === undefined
          ? "the Egma SDK reported the agent's tools"
          : "the Egma SDK's report was refused",
        {
          "egma.simulation_id": simulation.simulationId,
          "egma.run_id": simulation.runId,
          "egma.sdk.tool_count": census.tools.length,
          "egma.sdk.mocked_tool_count": mocked.length,
          ...(refusal === undefined ? {} : { "egma.sdk.refusal_code": refusal.code }),
        },
      ),
    );

    if (refusal !== undefined) return refused(reply, refusal);
    return sendJson(reply, answer);
  });

  /** One mocked tool call, answered from the pinned test version. */
  app.post(SDK_TOOL_PATH, { bodyLimit: LARGEST_TOOL_BYTES }, async (request, reply) => {
    const auth = sdkAuthOf(request);
    const call = toolCallIn(parsed(request.body));
    if (call === undefined) {
      return refused(reply, seamRefused(MALFORMED_REQUEST, MALFORMED_TOOL));
    }

    const simulation = await resolveLiveDailyRoomSimulation(auth, call.providerReference);
    if (simulation === undefined) return notASimulation(reply);

    const mock = simulation.answers.find((answer) => answer.tool === call.name);
    if (mock !== undefined && call.flows) {
      return refused(reply, flowsRefusal([call.name]));
    }
    if (mock === undefined) {
      const offered = mockedNames(simulation).join(", ") || "no tools at all";
      return refused(
        reply,
        seamRefused(
          UNKNOWN_TOOL,
          `this simulation has no mock tool for '${call.name}', so Egma has ` +
            `nothing to answer with. It answers for: ${offered}`,
        ),
      );
    }

    const answer = taggedAnswer(mock);
    const bytes = utf8Bytes(answer);
    if (bytes > LARGEST_MOCK_TOOL_ANSWER_BYTES) {
      return refused(
        reply,
        seamRefused(
          ANSWER_TOO_LARGE,
          `the mock tool for '${call.name}' is ${String(bytes)} bytes, more than ` +
            `the ${String(LARGEST_MOCK_TOOL_ANSWER_BYTES)} the exchange carries.`,
        ),
      );
    }
    return sendJson(reply, answer);
  });

  /** Whether a provider reference names a live simulation; records nothing. */
  app.post(SDK_CONFIRM_PATH, { bodyLimit: LARGEST_CONFIRM_BYTES }, async (request, reply) => {
    const auth = sdkAuthOf(request);
    const body = parsed(request.body);
    const providerReference = isObject(body) ? providerReferenceIn(body) : undefined;
    if (providerReference === undefined) {
      return refused(reply, seamRefused(MALFORMED_REQUEST, MALFORMED_CONFIRM));
    }

    const simulation = await resolveLiveDailyRoomSimulation(auth, providerReference);
    if (simulation === undefined) return notASimulation(reply);
    return reply.code(200).send({ simulation: true });
  });
}
