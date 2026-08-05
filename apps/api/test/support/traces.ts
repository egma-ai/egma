import type { FastifyInstance } from "fastify";
import { expect } from "vitest";

import { OTLP_TRACES_PATH } from "../../src/routes/traces.ts";
import { cookiesFrom } from "./api.ts";
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
    url: "/api/keys",
    headers: { cookie },
    payload: { name, ...(projectId === undefined ? {} : { project_id: projectId }) },
  });
  expect(minted.statusCode, minted.body).toBe(201);
  return (minted.json() as { secret: string }).secret;
}

/* ------------------------------------------------------------------ *
 * Telemetry to send.
 * ------------------------------------------------------------------ */

let captured: CapturedRequest[] | undefined;

/** The captured LiveKit trace, read once and replayed byte for byte. */
export async function replayFixture(
  app: FastifyInstance,
  secret: string,
): Promise<void> {
  captured ??= await capturedRequests();
  for (const request of captured) {
    const response = await app.inject({
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
}

export type SyntheticTrace = {
  readonly traceId: string;
  /** When the root span opened, as a `Date`. Turns follow it a second apart. */
  readonly startedAt: Date;
  readonly humanSaid?: string;
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

export async function ingest(
  app: FastifyInstance,
  secret: string,
  body: string,
): Promise<void> {
  const response = await app.inject({
    method: "POST",
    url: OTLP_TRACES_PATH,
    headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
    payload: body,
  });
  expect(response.statusCode, response.body).toBe(200);
}

/* ------------------------------------------------------------------ *
 * Asking the read endpoints.
 * ------------------------------------------------------------------ */

export type ListedTrace = {
  readonly trace_id: string;
  readonly started_at: string;
  readonly ended_at: string;
  readonly duration_ns: string;
  readonly span_count: number;
  readonly turn_counts: { human: number; agent: number };
  readonly tool_span_count: number;
  readonly errored_span_count: number;
  readonly source: string;
  readonly emitter: string;
  readonly environment: string;
  readonly connection_type: string;
  readonly provider_call_id: string;
  readonly run_id: string;
  readonly agent_id: string;
  readonly preview: string;
};

export type ListedPage = {
  readonly traces: ListedTrace[];
  readonly next_cursor: string | null;
  readonly window: { from: string; to: string };
};

export type DetailSpan = {
  readonly span_id: string;
  readonly parent_span_id: string;
  readonly name: string;
  readonly kind: string;
  readonly status: string;
  readonly started_at: string;
  readonly duration_ns: string;
  readonly text: string;
  readonly audio_url: string;
  readonly tool_name: string;
  readonly tool_arguments: string;
  readonly tool_result: string;
  readonly spans: DetailSpan[];
};

export type TraceDetailBody = {
  readonly trace: ListedTrace;
  readonly turns: DetailSpan[];
  readonly spans: DetailSpan[];
  readonly spans_truncated: boolean;
};

export type ReadQuery = {
  readonly from?: string;
  readonly to?: string;
  readonly project_id?: string;
  readonly limit?: string | number;
  readonly cursor?: string;
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

/** Every span in a detail response, however deeply it is nested. */
export function everySpan(spans: readonly DetailSpan[]): DetailSpan[] {
  return spans.flatMap((span) => [span, ...everySpan(span.spans)]);
}
