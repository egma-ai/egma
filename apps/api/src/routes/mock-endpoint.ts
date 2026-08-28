import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import {
  appendSpans,
  isErrorAnswer,
  resolveMockToolCall,
  type MockToolCallTarget,
  type NewSpan,
  type ResolvedMockTool,
} from "@egma/db";
import { traceIdOfSimulation } from "@egma/simulation-contract";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

/**
 * The mock endpoint: the one new **public** surface this seam adds.
 *
 * A mocked run points the agent's own tool URLs at this address, so the calls
 * arrive here from the agent's platform rather than from anything of egma's.
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
 * `/mock-tools/{run}/{simulation}/{tool}`. A custom tool configured
 * args-at-root posts no call envelope at all, so the URL is the only channel
 * identity can ride. The run is written into the URL when the temporary version
 * is built; the simulation is a dynamic variable the platform fills per call;
 * the tool's name is percent-encoded on the way in and decoded here, and
 * matched byte-exactly — so any name the platform accepts routes correctly,
 * reserved characters included.
 *
 * ## Three gates, in order
 *
 * 1. **The run named is live.** A finished run's temporary version has been
 *    deleted and its numbers put back; an answer served after it would come
 *    from a world that no longer exists.
 * 2. **The simulation named is that run's.** Two unguessable identifiers that
 *    have to agree, so a call cannot be moved from one customer's run to
 *    another's by editing a URL.
 * 3. **The tool is in that simulation's resolved answers.** The project's
 *    defaults merged with the pinned test version's overrides — the same
 *    resolution everything else uses, applied per simulation at serve time, so
 *    a per-test override beats a project default here for free and one
 *    temporary version serves every override.
 *
 * Everything else is refused, and **each refusal is its own answer**: a dead
 * run, a foreign simulation, an uncovered tool and a bad signature are four
 * different things and are never collapsed into one.
 *
 * ## The signature
 *
 * Where the platform signs one of these requests, it is verified with the key
 * egma holds for the agent, over the raw bytes that arrived. **Which key signs
 * a custom-function call is not assumed** — the platform's webhooks are signed
 * with a different key from the management one, a fact that cost a day to
 * learn — so the check is conditional in the honest direction: a signature that
 * is present must verify, and a request that carries none is admitted on the
 * strength of the two unguessable identifiers and the liveness gate. When the
 * empirical answer lands, the only thing that changes is that the header
 * becomes required.
 *
 * ## The record
 *
 * Every exchange is written onto the simulation's own record by the control
 * plane: the arguments as they arrived, the answer served, the elapsed time
 * bracketed by the span itself, and the provenance `mocked` naming the mock
 * tool that answered. A refused call for a simulation this endpoint could
 * identify lands as `refused` — no answer and no mock tool, but egma was in the
 * path and said no, and a span with no stamp would say the opposite: that the
 * call went past egma to a real backend.
 *
 * **This is the record's second tool-fact writer, deliberately.** The simulator
 * never sees these calls, because they travel platform → egma.
 */

/** Where the endpoint answers, under the deployment's own public origin. */
export const MOCK_TOOL_PREFIX = "/mock-tools";

export const MOCK_TOOL_PATH = `${MOCK_TOOL_PREFIX}/:runId/:simulationId/:toolName`;

/**
 * The base a temporary version's tool URLs are written against.
 *
 * The one place the address is spelled, so the writer and the endpoint cannot
 * disagree about it.
 */
export function mockToolBase(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/u, "")}${MOCK_TOOL_PREFIX}`;
}

/** The header the platform signs these requests with, where it signs them. */
export const SIGNATURE_HEADER = "x-retell-signature";

/**
 * How old a signed request may be, in milliseconds.
 *
 * The platform's own window. A replay of a signed request outside it is
 * refused on the signature, which is the only thing that makes a signature
 * worth checking at all.
 */
export const SIGNATURE_WINDOW_MILLISECONDS = 5 * 60 * 1000;

/** How each refusal names itself, so four different things stay four. */
export const MOCK_TOOL_REFUSALS = [
  "no_live_run",
  "simulation_not_in_run",
  "tool_not_mocked",
  "bad_signature",
] as const;
export type MockToolRefusal = (typeof MOCK_TOOL_REFUSALS)[number];

export type MockEndpointOptions = {
  /**
   * How the endpoint waits out a mock tool's declared delay.
   *
   * A seam, because the delay is the market gap this whole seam exists to
   * fill — nobody else can make a mock slow — and a proof of it that waited
   * out real seconds would be a proof about a timer. A test hands in one that
   * records what it was asked to wait.
   */
  readonly wait?: (milliseconds: number) => Promise<void>;
};

type Params = {
  readonly runId: string;
  readonly simulationId: string;
  readonly toolName: string;
};

const sleep = (milliseconds: number): Promise<void> =>
  milliseconds <= 0
    ? Promise.resolve()
    : new Promise((resolve) => {
        setTimeout(resolve, milliseconds);
      });

/**
 * Whether a signature the platform sent is this request's.
 *
 * `v={milliseconds},d={hex}`, where the digest is an HMAC-SHA256 of the raw
 * body followed by the timestamp. The raw body, always: a body that has been
 * parsed and re-serialised is different bytes, and a check over different bytes
 * is a check of nothing.
 */
export function signatureIsValid(
  header: string,
  rawBody: string,
  key: string,
  now: number,
): boolean {
  const parts = new Map<string, string>();
  for (const piece of header.split(",")) {
    const at = piece.indexOf("=");
    if (at <= 0) return false;
    parts.set(piece.slice(0, at).trim(), piece.slice(at + 1).trim());
  }

  const timestamp = parts.get("v");
  const digest = parts.get("d");
  if (timestamp === undefined || digest === undefined) return false;
  if (!/^\d+$/u.test(timestamp) || !/^[0-9a-f]+$/iu.test(digest)) return false;
  if (Math.abs(now - Number(timestamp)) > SIGNATURE_WINDOW_MILLISECONDS) {
    return false;
  }

  const expected = createHmac("sha256", key)
    .update(`${rawBody}${timestamp}`)
    .digest("hex");
  const sent = Buffer.from(digest.toLowerCase(), "utf8");
  const mine = Buffer.from(expected, "utf8");
  return sent.length === mine.length && timingSafeEqual(sent, mine);
}

/** The signature a caller would have to send. Exported for the tests only. */
export function signatureFor(
  rawBody: string,
  key: string,
  now: number,
): string {
  const digest = createHmac("sha256", key)
    .update(`${rawBody}${now}`)
    .digest("hex");
  return `v=${now},d=${digest}`;
}

/**
 * One exchange, as the record keeps it.
 *
 * The same shape the in-process seam writes, field for field, because a reader
 * asking "what did egma answer this call" must not have to know which seam
 * answered it. The two ends bracket the exchange — the moment the call arrived
 * and the moment the answer went back, the declared delay included — so a delay
 * is readable as the time it really took, with no second field to disagree.
 */
function exchangeSpan(input: {
  readonly target: MockToolCallTarget;
  readonly simulation: NonNullable<MockToolCallTarget["simulation"]>;
  readonly toolName: string;
  readonly rawBody: string;
  readonly served: ResolvedMockTool | undefined;
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
    toolArguments: input.rawBody,
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
      "egma.tool.arguments": input.rawBody,
      ...(refused
        ? { "egma.tool.provenance": "refused" }
        : {
            "egma.tool.result": input.answer,
            "egma.tool.provenance": "mocked",
            // Null exactly when a test's own override answered: an override is
            // the test's content and has no row of its own to name.
            "egma.tool.mock_tool": input.served?.mockToolId ?? null,
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

export async function mockEndpointRoutes(
  app: FastifyInstance,
  options: MockEndpointOptions = {},
): Promise<void> {
  const wait = options.wait ?? sleep;

  // The bytes that were sent, kept as they were sent. A signature is over the
  // raw body, and a body Fastify parsed and something else re-serialised is
  // different bytes. Registered inside this plugin's own scope, without
  // `fastify-plugin`, so encapsulation keeps it away from the JSON routes —
  // the same shape the provider adapter and the OTLP door use.
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

  app.post(MOCK_TOOL_PATH, async (request, reply) => {
    const beganAtMicroseconds = nowMicroseconds();
    const params = request.params as Params;
    const rawBody = typeof request.body === "string" ? request.body : "";
    // Decoded here, and matched byte-exactly against the authored name from
    // here on. Fastify decodes a path segment for us; a segment that is not
    // valid percent-encoding arrives as it was sent and simply matches nothing.
    const toolName = params.toolName;

    const target = await resolveMockToolCall(params.runId, params.simulationId);

    // Gate one. A run nobody has heard of and a run that finished get the same
    // answer, because to this caller they are the same thing.
    if (target === undefined || !target.runIsLive) {
      return refuse(
        reply,
        404,
        "no_live_run",
        "this address does not name a run Egma is conducting right now.",
      );
    }

    // Gate two.
    const simulation = target.simulation;
    if (simulation === undefined) {
      return refuse(
        reply,
        404,
        "simulation_not_in_run",
        "this address names a simulation that is not part of that run.",
      );
    }

    // Gate three. From here on there is a simulation to answer to, so every
    // refusal below lands on its record.
    const served = simulation.answers.find(
      (candidate) => candidate.toolName === toolName,
    );

    const landRefusal = async (): Promise<void> => {
      await record(
        request,
        target,
        exchangeSpan({
          target,
          simulation,
          toolName,
          rawBody,
          served: undefined,
          answer: undefined,
          beganAtMicroseconds,
          endedAtMicroseconds: nowMicroseconds(),
        }),
      );
    };

    if (served === undefined) {
      await landRefusal();
      return refuse(
        reply,
        404,
        "tool_not_mocked",
        "this simulation has no answer for that tool.",
      );
    }

    // The signature, where the platform sent one. A request with none is
    // admitted on the two unguessable identifiers and the liveness gate; a
    // request with one that does not verify is refused, and refused as its own
    // thing rather than as an uncovered tool.
    const signature = request.headers[SIGNATURE_HEADER];
    if (typeof signature === "string" && signature.trim() !== "") {
      const key = target.signingKey;
      if (
        key === null ||
        !signatureIsValid(signature, rawBody, key, Date.now())
      ) {
        await landRefusal();
        return refuse(
          reply,
          401,
          "bad_signature",
          "this request's signature was not made with the key Egma holds for " +
            "this agent.",
        );
      }
    }

    // The delay, and the market gap: a mocked backend takes as long as a real
    // one, so a "let me check that for you" line is actually exercised and the
    // latency numbers on the record stay honest.
    await wait(served.delayMilliseconds);

    const failing = isErrorAnswer(served.answer);
    const body = failing ? { error: served.answer.error } : served.answer.answer;
    const answer = JSON.stringify(body) ?? "null";

    await record(
      request,
      target,
      exchangeSpan({
        target,
        simulation,
        toolName,
        rawBody,
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
    return reply.code(failing ? 500 : 200).send(body ?? null);
  });
}
