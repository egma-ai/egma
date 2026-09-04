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
 * The mock endpoint: the one new **public** surface this seam adds.
 *
 * A mocked run points the agent's own tool URLs at this address for exactly
 * the tools a test names, so the calls arrive here from the agent's platform
 * rather than from anything of egma's.
 * That is not a design choice: Retell refuses localhost and private addresses
 * for a tool URL, so a mocked run needs an address its infrastructure can
 * reach. Self-hosters are told this plainly, and it is the only new inbound
 * requirement the seam has.
 *
 * It sits **beside** the control-plane API and never on the simulator, because
 * arrows point out: the simulator reaches the platform and nothing reaches the
 * simulator.
 *
 * ## What is in the URL, and why
 *
 * `/mock-tools/{simulation}/{tool}`. A custom tool configured args-at-root
 * posts no call envelope at all, so the URL is the only channel identity can
 * ride. The whole address arrives as the value of that tool's own per-call
 * variable — the temporary version carries no address of Egma's, only
 * `{{egma_url_<tool>}}` in front of the customer's own URL — so which
 * simulation is in the path is decided per call, in the claim (ADR-0022). The
 * tool's name is percent-encoded on the way in and decoded here, and matched
 * byte-exactly, so any name the platform accepts routes correctly, reserved
 * characters included.
 *
 * The simulation names its own run, so there is no second identifier to agree
 * with: a call cannot be moved from one customer's run to another's, because
 * the run is read from the row rather than read off the URL.
 *
 * ## What is dropped at the door, and why
 *
 * **Every header and every query parameter that arrives, unread.** The
 * temporary version keeps each tool's own headers and query params byte for
 * byte, because that same version serves the tools a test does *not* mock and
 * those calls have to authenticate exactly as production does. So on a mocked
 * call the customer's backend credentials arrive here — and nothing here reads
 * them, logs them, stores them or puts them on the record. No header is read at
 * all.
 *
 * That has a cost, and it is paid deliberately: a tool the customer wrote as a
 * **GET** carries the model's arguments in the same query string as their own
 * static parameters, and Egma cannot tell one from the other — so a GET tool's
 * arguments are not written down at all. The record shows the call, the answer
 * and the provenance, and no arguments. A POST tool's arguments are its body,
 * which is Egma's to read, and they land in full.
 *
 * ## Two gates, in order
 *
 * 1. **The simulation named belongs to a live run.** A simulation nobody has
 *    heard of and one whose run has finished are the same answer: a finished
 *    run's temporary version has been deleted, so an answer served after it
 *    would come from a world that no longer exists.
 * 2. **The tool is one this simulation's own test named.** The pinned test
 *    version carries the answers, so one temporary version serves every test of
 *    the run and each simulation answers for exactly what its own test wrote.
 *
 * Everything else is refused, and **each refusal is its own answer**: a dead
 * run and an unmocked tool are two different things and are never collapsed
 * into one.
 *
 * ## No signature check
 *
 * The request is not authenticated beyond those two gates. The simulation
 * identifier is unguessable and answers only while its run is live. Retell does
 * sign custom-function calls, but with the account's webhook-badged key, which
 * is not the management key a customer stores on the agent — so a check against
 * the stored key refused every real call (2026-09-04, on the founder's own
 * agent), and the founder chose to drop the check rather than ask customers for
 * a second key. Nothing about the arriving headers is read, logged, or kept.
 *
 * ## The record
 *
 * Every exchange is written onto the simulation's own record by the control
 * plane: the arguments as they arrived in the body, the answer served, the
 * elapsed time bracketed by the span itself, and the provenance `mocked`
 * naming the tool that answered. A refused call for a simulation this endpoint could identify
 * lands as `refused` — no answer and no mock tool, but egma was in the path and
 * said no, and a span with no stamp would say the opposite: that the call went
 * past egma to a real backend.
 *
 * **This is the record's second tool-fact writer, deliberately.** The simulator
 * never sees these calls, because they travel platform → egma.
 */

/** Where the endpoint answers, under the deployment's own public origin. */
export const MOCK_TOOL_PREFIX = "/mock-tools";

export const MOCK_TOOL_PATH = `${MOCK_TOOL_PREFIX}/:simulationId/:toolName`;

/**
 * The base a mocked call's routing value is built against.
 *
 * The one place the address is spelled, so the claim that fills it into a
 * per-call variable and the endpoint that answers it cannot disagree about it.
 */
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
 * One exchange, as the record keeps it.
 *
 * The same shape the in-process seam writes, field for field, because a reader
 * asking "what did egma answer this call" must not have to know which seam
 * answered it. The two ends bracket the exchange — the moment the call arrived
 * and the moment the answer went back — so the elapsed time is readable as the
 * time it really took, with no second field to disagree.
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
    // No parent. The conversation's own root span is the simulator's and is
    // minted where egma cannot see it, so claiming a parent here would be
    // inventing a relationship. A reader shows a parentless span under the
    // trace's real root.
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
    payload: JSON.stringify({
      "egma.tool.name": input.toolName,
      "egma.tool.arguments": input.heardArguments,
      ...(refused
        ? { "egma.tool.provenance": "refused" }
        : {
            "egma.tool.result": input.answer,
            "egma.tool.provenance": "mocked",
            // The tool's own name, which is the whole of how a mock tool is
            // named now that the answers live on the test.
            "egma.tool.mock_tool": input.toolName,
          }),
    }),
    endsTrace: false,
  };
}

/** Microseconds since the epoch, which is what the span store counts in. */
function nowMicroseconds(): bigint {
  return BigInt(Date.now()) * 1000n;
}

/**
 * Write the exchange down, and never let the writing be why an answer did not
 * arrive.
 *
 * The agent is waiting on this request. A trace store that is briefly away is
 * an incident for egma and must not become a tool call the customer's agent
 * saw fail, so a failed write is logged and the answer goes out regardless.
 */
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
  // The bytes that were sent, kept as they were sent: the record carries the
  // agent's arguments exactly as they arrived, not a re-serialisation of them.
  // Registered inside this plugin's own scope, without `fastify-plugin`, so
  // encapsulation keeps it away from the JSON routes — the same shape the
  // provider adapter and the OTLP door use.
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

  /**
   * **Both methods, because the transform keeps the tool's own.**
   *
   * A custom tool declares its `method`, and the draft leaves it byte-identical
   * along with the rest of the contract — so a tool the customer wrote as a GET
   * arrives here as a GET. A POST-only door would answer those with a 404 that
   * looks exactly like an uncovered tool, and a developer would go looking for
   * a mock tool they had already authored.
   */
  app.route({
    method: ["GET", "POST"],
    url: MOCK_TOOL_PATH,
    handler: async (request, reply) => {
    const beganAtMicroseconds = nowMicroseconds();
    const params = request.params as Params;
    const rawBody = typeof request.body === "string" ? request.body : "";
    // What the agent asked with, in the one shape the record is read in: the
    // body's own bytes, exactly as they arrived.
    //
    // **The query string is not read, on either method.** It is the customer's
    // own — their static parameters travel in it, credentials among them —
    // and on a GET tool the model's arguments are mixed into the same string
    // with nothing to tell them apart. So a GET lands with no arguments rather
    // than with the customer's secrets on the record, which is the trade this
    // endpoint makes everywhere (see the note at the top of this file).
    const heardArguments = rawBody;
    // Decoded here, and matched byte-exactly against the authored name from
    // here on. Fastify decodes a path segment for us; a segment that is not
    // valid percent-encoding arrives as it was sent and simply matches nothing.
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
    // Serialized once, and the one string is both what goes on the wire and
    // what goes on the record. Handing the value to `reply.send` instead would
    // send a bare scalar — a number, a string, `true` — as `text/plain`, while
    // the record stored its JSON form, so the agent and the record would
    // disagree about what was served for exactly the answers most easily got
    // wrong.
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

    // An authored failure has to *look* like the backend failing, or the agent
    // under test would read it as a successful call that returned an error
    // object — and proving the agent apologises instead of claiming success is
    // the whole reason an answer may be an error.
    return reply
      .code(failing ? 500 : 200)
      .header("content-type", "application/json; charset=utf-8")
      .send(answer);
    },
  });
}
