import type { AuthContext, Role } from "@egma/db";
import type { FastifyInstance } from "fastify";
import { expect } from "vitest";

import { SIMULATION_ID_ATTRIBUTE } from "../../src/otlp/normalise.ts";
import { OTLP_TRACES_PATH } from "../../src/routes/traces.ts";
import { cookiesFrom, type TestApi } from "./api.ts";
import { capturedRequests, type CapturedRequest } from "./fixture.ts";

/**
 * Driving the trace endpoints from outside: somebody with a key, telemetry to
 * send, and a window to ask about.
 *
 * Everything here goes over HTTP into the running API, because the read surface
 * is one of the two seams this effort is tested through and its contract is what
 * a customer integrates against — a test that called the data-access functions
 * directly would prove the queries and none of the contract.
 */

/** Somebody with an organization, a project and a key, as the product makes one. */
export type Customer = {
  readonly userId: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly cookie: string;
  /** A key for the whole organization, naming no project. */
  readonly secret: string;
};

export async function signUp(
  app: FastifyInstance,
  email: string,
  organizationName: string,
): Promise<Customer> {
  const created = await app.inject({
    method: "POST",
    url: "/api/signup",
    payload: { email, password: "a-long-enough-password", organizationName },
  });
  expect(created.statusCode, created.body).toBe(201);

  const landed = created.json() as {
    userId: string;
    organization: { id: string };
    project: { id: string };
  };
  const cookie = cookiesFrom(created.headers["set-cookie"]);

  return {
    userId: landed.userId,
    organizationId: landed.organization.id,
    projectId: landed.project.id,
    cookie,
    secret: await mintKey(app, cookie, organizationName),
  };
}

/** A key, optionally scoped to one project rather than the whole customer. */
export async function mintKey(
  app: FastifyInstance,
  cookie: string,
  name: string,
  projectId?: string,
): Promise<string> {
  const minted = await app.inject({
    method: "POST",
    url: "/v1/keys",
    headers: { cookie },
    payload: { name, ...(projectId === undefined ? {} : { projectId }) },
  });
  expect(minted.statusCode, minted.body).toBe(201);
  return (minted.json() as { secret: string }).secret;
}

/**
 * A colleague at a named role, added the way the product adds one: invited,
 * and they follow the link. They come away holding a key of their own, and
 * minting it through the product is what makes the role real — a key carries
 * no role, it acts at its creator's current one.
 */
export async function colleagueOf(
  app: FastifyInstance,
  host: Customer,
  email: string,
  role: Role,
): Promise<Customer> {
  const invited = await app.inject({
    method: "POST",
    url: "/v1/invitations",
    headers: { cookie: host.cookie },
    payload: { email, role },
  });
  expect(invited.statusCode, invited.body).toBe(201);

  const link = (invited.json() as { acceptUrl: string }).acceptUrl;
  const joined = await app.inject({
    method: "POST",
    url: "/api/signup",
    payload: {
      email,
      password: "a-long-enough-password",
      invitationToken: new URL(link).searchParams.get("token"),
    },
  });
  expect(joined.statusCode, joined.body).toBe(201);
  const cookie = cookiesFrom(joined.headers["set-cookie"]);

  return {
    userId: (joined.json() as { userId: string }).userId,
    organizationId: host.organizationId,
    projectId: host.projectId,
    cookie,
    secret: await mintKey(app, cookie, email),
  };
}

/**
 * The context this person acts in at a named role, for the seams that take one
 * directly — authoring a persona, driving a simulation the way a simulator
 * would. The role is passed rather than read, because a key acts at its
 * creator's current role and a test says which one it is asking about.
 */
export function contextFor(person: Customer, role: Role): AuthContext {
  return {
    userId: person.userId,
    organizationId: person.organizationId,
    projectId: person.projectId,
    role,
    via: "session",
  };
}

/** A key as `egma login` leaves one: minted for the project a terminal names. */
export function projectKeyFor(
  app: FastifyInstance,
  person: Customer,
): Promise<string> {
  return mintKey(app, person.cookie, "a terminal", person.projectId);
}

/**
 * Somebody plain, for the tests where who the persona is is not the question.
 *
 * Spread into a `createPersona` beside the team's `name`: the authored person
 * is flat, so there is no wrapper to nest them in. The identity name is here
 * because every persona has to have one — it is the name the agent hears, and
 * the factory refuses a persona without it.
 */
export const NEUTRAL_PERSON = {
  identityName: "Sam Okafor",
  personality: "Speaks plainly, stays patient, asks one question at a time.",
  language: "en-US",
} as const;

/** A status and a parsed body, which is all these suites ever assert on. */
export type Answer = {
  readonly statusCode: number;
  readonly body: Record<string, unknown>;
};

/** One request with a key on it, answered by the API in this process. */
export async function request(
  app: FastifyInstance,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  url: string,
  key: string,
  payload?: Record<string, unknown>,
): Promise<Answer> {
  const response = await app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${key}` },
    ...(payload === undefined ? {} : { payload }),
  });
  return {
    statusCode: response.statusCode,
    body: response.json() as Record<string, unknown>,
  };
}

/* ------------------------------------------------------------------ *
 * Telemetry to send.
 * ------------------------------------------------------------------ */

let captured: CapturedRequest[] | undefined;

/**
 * The captured LiveKit trace, read once and replayed byte for byte, then
 * drained.
 *
 * The door stops at object-store durability, so a suite reading rows back has
 * to carry the evidence the rest of the way. It takes the instance rather than
 * its app for exactly that reason.
 */
export async function replayFixture(
  api: Pick<TestApi, "app" | "drainEvidence">,
  secret: string,
): Promise<void> {
  captured ??= await capturedRequests();
  for (const request of captured) {
    const response = await api.app.inject({
      method: "POST",
      url: OTLP_TRACES_PATH,
      headers: {
        "content-type": request.contentType,
        authorization: `Bearer ${secret}`,
      },
      payload: request.body,
    });
    expect(response.statusCode, request.file).toBe(200);
  }
  await api.drainEvidence();
}

export type SyntheticTrace = {
  readonly traceId: string;
  /** When the root span opened, as a `Date`. Turns follow it a second apart. */
  readonly startedAt: Date;
  readonly humanSaid?: string;
  /**
   * The simulation these spans are evidence of, for an export posted with the
   * service token rather than with a customer's key.
   *
   * Absent is the customer path, where the door stamps `production` because a
   * customer key cannot speak for a run. Present, the resource names the
   * simulation and the door resolves the organization, the project, the run and
   * the pins from egma's own row — which is what stamps `simulation`. The trace
   * id has to be the one that simulation's id spells, because the door checks
   * it: the two are the same 128 bits written twice.
   */
  readonly simulationId?: string;
};

/**
 * A short exchange as OTLP/JSON, sent at the same door the real exporter
 * uses.
 *
 * Synthetic rather than captured, because the questions these bodies exist to
 * ask — does page two follow page one, do two traces of the same minute both
 * appear — need many traces at chosen instants, and the capture is deliberately
 * one trace at the instants it really happened. It goes in through the door
 * rather than around it so that what is being read back is what ingest actually
 * writes.
 */
export function syntheticExport(trace: SyntheticTrace): string {
  const start = BigInt(trace.startedAt.getTime()) * 1_000_000n;
  const second = 1_000_000_000n;

  const span = (
    suffix: string,
    name: string,
    parent: string,
    offsetSeconds: bigint,
    durationSeconds: bigint,
    attributes: readonly { key: string; value: { stringValue: string } }[] = [],
  ) => ({
    traceId: trace.traceId,
    spanId: `${trace.traceId.slice(0, 14)}${suffix}`,
    parentSpanId: parent,
    name,
    startTimeUnixNano: String(start + offsetSeconds * second),
    endTimeUnixNano: String(start + (offsetSeconds + durationSeconds) * second),
    attributes,
    status: { code: "STATUS_CODE_UNSET" },
  });

  const rootId = `${trace.traceId.slice(0, 14)}01`;

  return JSON.stringify({
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: "synthetic-agent" } },
            ...(trace.simulationId === undefined
              ? []
              : [
                  {
                    key: SIMULATION_ID_ATTRIBUTE,
                    value: { stringValue: trace.simulationId },
                  },
                ]),
          ],
        },
        scopeSpans: [
          {
            scope: { name: "livekit-agents", version: "1.6.7" },
            spans: [
              span("01", "agent_session", "", 0n, 4n, [
                { key: "session.id", value: { stringValue: trace.traceId } },
              ]),
              span("02", "user_turn", rootId, 1n, 1n, [
                {
                  key: "lk.user_transcript",
                  value: {
                    stringValue: trace.humanSaid ?? "Is anybody there?",
                  },
                },
              ]),
              span("03", "agent_turn", rootId, 2n, 1n, [
                { key: "lk.response.text", value: { stringValue: "I am here." } },
              ]),
              span("04", "llm_request", `${trace.traceId.slice(0, 14)}03`, 2n, 1n),
            ],
          },
        ],
      },
    ],
  });
}

/**
 * One export through the door, and then drained.
 *
 * It takes the instance rather than its app because the door answers on
 * object-store durability and writes no row: a suite asking what a reader sees
 * has to carry the evidence past that boundary, and every one of them must do
 * it the same way.
 */
export async function ingest(
  api: Pick<TestApi, "app" | "drainEvidence">,
  secret: string,
  body: string,
): Promise<void> {
  const response = await api.app.inject({
    method: "POST",
    url: OTLP_TRACES_PATH,
    headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
    payload: body,
  });
  expect(response.statusCode, response.body).toBe(200);
  await api.drainEvidence();
}

/* ------------------------------------------------------------------ *
 * Asking the read endpoints.
 * ------------------------------------------------------------------ */

export type ListedTrace = {
  readonly traceId: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly durationNs: string;
  readonly spanCount: number;
  readonly turnCounts: { human: number; agent: number };
  readonly toolSpanCount: number;
  readonly erroredSpanCount: number;
  readonly source: string;
  readonly emitter: string;
  readonly environment: string;
  readonly connectionType: string;
  readonly providerCallId: string;
  readonly agentPlatform: string;
  readonly platformAgentId: string;
  readonly platformAgentName: string;
  readonly platformAgentVersion: string;
  readonly runId: string;
  readonly agentId: string;
  readonly preview: string;
  /** Null when this trace carried no usable turn-response latency samples. */
  readonly turnResponseLatencyP90Milliseconds: number | null;
  /** Whether that P90 came from the bounded prefix of a larger trace. */
  readonly turnResponseLatencyP90Partial: boolean;
};

export type ListedPage = {
  readonly traces: ListedTrace[];
  readonly nextPageToken: string | null;
  readonly window: { from: string; to: string };
};

export type DetailSpan = {
  readonly spanId: string;
  readonly parentSpanId: string;
  readonly name: string;
  readonly kind: string;
  readonly status: string;
  readonly startedAt: string;
  readonly durationNs: string;
  readonly text: string;
  readonly audioUrl: string;
  readonly toolName: string;
  readonly toolArguments: string;
  readonly toolResult: string;
  readonly spans: DetailSpan[];
};

/** One measure this exchange produced, computed from its own spans. */
export type DetailMeasure = {
  readonly measure: string;
  readonly unit: string;
  /** True when Egma did not time this itself. Absent on an older answer. */
  readonly derived?: boolean;
  /**
   * The agent platform that measured this, on the figures a platform reported
   * rather than Egma measured — and **absent on every other measure**, which is
   * the whole of what keeps simulation traffic what it always was.
   */
  readonly reportedBy?: string;
  readonly samples: readonly number[];
  readonly spanIds: readonly string[];
  /**
   * The average the pages lead with, rounded once by the platform rather than
   * left for every reader to work out for itself.
   */
  readonly mean: number;
  readonly p50: number;
  readonly p90: number;
  /** True when the reading is a prefix, so the figure is of the part held. */
  readonly partial: boolean;
};

export type TraceDetailBody = {
  readonly trace: ListedTrace;
  readonly turns: DetailSpan[];
  readonly spans: DetailSpan[];
  readonly spansTruncated: boolean;
  /** The simulation this trace is, or `null` for a customer's own telemetry. */
  readonly simulationId: string | null;
  /** What was measured — the metrics display's read path. Empty, never absent. */
  readonly metrics: readonly DetailMeasure[];
};

export type ReadQuery = {
  readonly from?: string;
  readonly to?: string;
  readonly projectId?: string;
  /** `simulation` or `production`, and a word that is neither, for the refusal. */
  readonly source?: string;
  readonly pageSize?: string | number;
  readonly pageToken?: string;
};

function queryString(query: ReadQuery): string {
  const parameters = new URLSearchParams();
  for (const [name, value] of Object.entries(query)) {
    if (value !== undefined) parameters.set(name, String(value));
  }
  const written = parameters.toString();
  return written === "" ? "" : `?${written}`;
}

export function listTracesOverHttp(
  app: FastifyInstance,
  secret: string,
  query: ReadQuery,
) {
  return app.inject({
    method: "GET",
    url: `/v1/traces${queryString(query)}`,
    headers: { authorization: `Bearer ${secret}` },
  });
}

/**
 * The same list, asked for by somebody signed in to a browser rather than by a
 * key. The credential is the only difference, which is the thing being asked
 * about.
 */
export function listTracesAsSignedIn(
  app: FastifyInstance,
  cookie: string,
  query: ReadQuery,
) {
  return app.inject({
    method: "GET",
    url: `/v1/traces${queryString(query)}`,
    headers: { cookie },
  });
}

export function readTraceOverHttp(
  app: FastifyInstance,
  secret: string,
  traceId: string,
  query: ReadQuery,
) {
  return app.inject({
    method: "GET",
    url: `/v1/traces/${traceId}${queryString(query)}`,
    headers: { authorization: `Bearer ${secret}` },
  });
}

/** The same transcript, asked for by a browser. The credential is the only difference. */
export function readTraceAsSignedIn(
  app: FastifyInstance,
  cookie: string,
  traceId: string,
  query: ReadQuery,
) {
  return app.inject({
    method: "GET",
    url: `/v1/traces/${traceId}${queryString(query)}`,
    headers: { cookie },
  });
}

/** Every span in a detail response, however deeply it is nested. */
export function everySpan(spans: readonly DetailSpan[]): DetailSpan[] {
  return spans.flatMap((span) => [span, ...everySpan(span.spans)]);
}
