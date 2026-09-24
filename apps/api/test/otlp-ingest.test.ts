import {
  getGradingJobForTrace,
  readProductionGradingPlan,
  type AuthContext,
} from "@egma/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { OTLP_TRACES_PATH } from "../src/routes/traces.ts";
import { cookiesFrom, createApi, type TestApi } from "./support/api.ts";
import {
  capturedRequests,
  FIXTURE_TRACE,
  type CapturedRequest,
} from "./support/fixture.ts";
import { startObjectStorage, type ObjectStorage } from "./support/object-storage.ts";

/**
 * Replay fourteen captured OTLP bodies through authentication, decoding,
 * normalization, object-store staging, and ClickHouse insertion. Each accepted
 * object is drained explicitly. Query FINAL to inspect logical spans despite
 * physical replay copies; this does not exercise the standing drain loop.
 */

const storage: ObjectStorage = await startObjectStorage("otlp-ingest");

if (!storage.available) {
  process.stderr.write(
    `\nskipping the captured-trace ingest suite — ${storage.why}\n\n`,
  );
}

let api: TestApi;
let requests: CapturedRequest[];

/** Somebody with an organization, a project and a key, as the product makes one. */
type Customer = {
  readonly organizationId: string;
  readonly projectId: string;
  readonly secret: string;
};

async function signUpWithAKey(
  email: string,
  organizationName: string,
): Promise<Customer> {
  const created = await api.app.inject({
    method: "POST",
    url: "/api/signup",
    payload: { email, password: "a-long-enough-password", organizationName },
  });
  expect(created.statusCode).toBe(201);

  const landed = created.json() as {
    organization: { id: string };
    project: { id: string };
  };

  const minted = await api.app.inject({
    method: "POST",
    url: "/v1/keys",
    headers: { cookie: cookiesFrom(created.headers["set-cookie"]) },
    payload: {
      name: `${organizationName}'s agent`,
      projectId: landed.project.id,
    },
  });
  expect(minted.statusCode).toBe(201);

  return {
    organizationId: landed.organization.id,
    projectId: landed.project.id,
    secret: (minted.json() as { secret: string }).secret,
  };
}

async function post(
  secret: string | null,
  body: Buffer | string,
  contentType = "application/x-protobuf",
) {
  const response = await api.app.inject({
    method: "POST",
    url: OTLP_TRACES_PATH,
    headers: {
      "content-type": contentType,
      ...(secret === null ? {} : { authorization: `Bearer ${secret}` }),
    },
    payload: body,
  });
  await api.drainEvidence();
  return response;
}

function jsonExport(
  traceId: string,
  spanId: string,
  name: string,
  scopeName = "livekit-agents",
): string {
  return JSON.stringify({
    resourceSpans: [{
      resource: { attributes: [] },
      scopeSpans: [{
        scope: { name: scopeName },
        spans: [{
          traceId,
          spanId,
          name,
          kind: "SPAN_KIND_INTERNAL",
          startTimeUnixNano: "1785693880281989804",
          endTimeUnixNano: "1785693881281989804",
        }],
      }],
    }],
  });
}

/** Replay the whole capture, in order, as one exporter's fourteen flushes. */
async function replay(secret: string): Promise<void> {
  for (const request of requests) {
    const response = await post(secret, request.body, request.contentType);
    expect(response.statusCode, request.file).toBe(200);
  }
}

function store(): NonNullable<TestApi["traceStore"]> {
  const traceStore = api.traceStore;
  if (traceStore === undefined) throw new Error("this API has no trace store");
  return traceStore;
}

async function countOf(query: string): Promise<number> {
  const [row] = await store().rows<{ n: string }>(query);
  return Number(row?.n ?? -1);
}

let acme: Customer;

beforeAll(async () => {
  if (!storage.available) return;
  requests = await capturedRequests();
  api = await createApi("otlp_ingest", {
    traceStore: true,
    ingestStore: storage.ingestStore,
  });
  acme = await signUpWithAKey("ada@acme.example", "Acme");
  await replay(acme.secret);
});

afterAll(async () => {
  await api?.close();
  if (storage.available) storage.stop();
});

describe.skipIf(!storage.available)("the captured trace, posted at the door", () => {
  /**
   * Nothing was invented and nothing was thrown away: the names on the rows are
   * exactly the names the framework emitted, and there is no speech-to-text
   * span because this framework emits none — recognition rides the human's turn
   * as attributes.
   */
  it("stores one row per span that arrived, under the name it arrived with", async () => {
    const rows = await store().rows<{ name: string; n: string }>(
      "select name, count() as n from spans final group by name order by name",
    );

    expect(Object.fromEntries(rows.map((row) => [row.name, Number(row.n)]))).toEqual(
      {
        agent_session: 1,
        agent_speaking: 4,
        agent_turn: 8,
        drain_agent_activity: 1,
        eou_detection: 5,
        function_tool: 2,
        llm_fallback_adapter: 8,
        llm_node: 8,
        llm_request: 10,
        llm_request_run: 19,
        on_enter: 1,
        on_exit: 1,
        start_agent_activity: 1,
        tts_fallback_adapter: 8,
        tts_node: 6,
        tts_request: 8,
        tts_request_run: 22,
        tts_stream_adapter: 6,
        user_speaking: 9,
        user_turn: 5,
      },
    );

    expect(await countOf("select count() as n from spans final where kind = 'stt'")).toBe(
      0,
    );
  });

  /**
   * An exporter retries a flush it never heard back about, and the bytes are
   * identical by design. Replaying the whole capture is that retry, fourteen
   * times over, and the row counts have to be exactly what they were.
   */
  it("is the same trace after being sent a second time, not two of it", async () => {
    const before = await countOf("select count() as n from spans final");
    const turnsBefore = await countOf("select count() as n from turns final");

    await replay(acme.secret);

    expect(await countOf("select count() as n from spans final")).toBe(before);
    expect(await countOf("select count() as n from turns final")).toBe(turnsBefore);
  });
});

/**
 * The same trace, sent twice by two different customers.
 *
 * It is the strongest form of the question: identical bytes, identical trace
 * id, identical span ids — the only thing telling the two apart is which key
 * was on the request. If the organization came from anywhere else, these two
 * customers would be reading each other's trace.
 */
describe("two organizations sending the very same trace", () => {
  let globex: Customer;

  beforeAll(async () => {
    globex = await signUpWithAKey("grace@globex.example", "Globex");
    await replay(globex.secret);
  });

  it("each hold the whole of it, and only their own copy", async () => {
    const rows = await store().rows<{ organization_id: string; n: number }>(
      "select organization_id, count() as n from spans final " +
        "group by organization_id order by organization_id",
    );

    expect(new Map(rows.map((row) => [row.organization_id, row.n]))).toEqual(
      new Map([
        [acme.organizationId, FIXTURE_TRACE.spans],
        [globex.organizationId, FIXTURE_TRACE.spans],
      ]),
    );
  });
});

describe("a request with no usable credential", () => {
  it("is refused, and stores nothing", async () => {
    const request = requests[0];
    if (request === undefined) throw new Error("the capture is empty");

    const before = await countOf("select count() as n from spans final");

    const anonymous = await post(null, request.body);
    expect(anonymous.statusCode).toBe(401);

    const invented = await post(`egma_sk_${"a".repeat(43)}`, request.body);
    expect(invented.statusCode).toBe(401);

    const wrongScheme = await api.app.inject({
      method: "POST",
      url: OTLP_TRACES_PATH,
      headers: {
        "content-type": "application/x-protobuf",
        authorization: "Basic bm90LWEta2V5",
      },
      payload: request.body,
    });
    expect(wrongScheme.statusCode).toBe(401);

    expect(await countOf("select count() as n from spans final")).toBe(before);
  });
});

describe("the production grading completion signal", () => {
  it("creates work only for an explicit supported-platform end", async () => {
    await api.database.sql(
      `update project_grader
          set scope = '{"simulations":[],"production":{"sample_percent":100}}'::jsonb
        where organization_id = $1 and project_id = $2`,
      [acme.organizationId, acme.projectId],
    );
    const auth: AuthContext = {
      userId: "production-completion-test",
      organizationId: acme.organizationId,
      projectId: acme.projectId,
      role: "member",
      via: "session",
    };
    const genericRoot = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1";
    const unsupportedEnd = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa2";
    const supportedEnd = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa3";

    const generic = await post(
      acme.secret,
      jsonExport(
        genericRoot,
        "0000000000000001",
        "a_generic_parentless_span",
      ),
      "application/json",
    );
    const unsupported = await post(
      acme.secret,
      jsonExport(
        unsupportedEnd,
        "0000000000000002",
        "agent_session",
        "another-platform",
      ),
      "application/json",
    );
    expect([generic.statusCode, unsupported.statusCode]).toEqual([200, 200]);
    await expect(getGradingJobForTrace(auth, genericRoot)).resolves.toBeUndefined();
    await expect(getGradingJobForTrace(auth, unsupportedEnd)).resolves
      .toBeUndefined();
    await expect(readProductionGradingPlan(auth, genericRoot)).resolves
      .toBeUndefined();
    await expect(readProductionGradingPlan(auth, unsupportedEnd)).resolves
      .toBeUndefined();

    const supported = await post(
      acme.secret,
      jsonExport(
        supportedEnd,
        "0000000000000003",
        "agent_session",
      ),
      "application/json",
    );
    expect(supported.statusCode).toBe(200);
    await expect(getGradingJobForTrace(auth, supportedEnd)).resolves
      .toMatchObject({ source: "production", traceId: supportedEnd });
    await expect(readProductionGradingPlan(auth, supportedEnd)).resolves
      .toMatchObject({ traceId: supportedEnd, entries: [expect.any(Object)] });

    // Processing another explicit end gives any background work a turn. The
    // earlier parentless and unsupported traces still never become work.
    await expect(getGradingJobForTrace(auth, genericRoot)).resolves.toBeUndefined();
    await expect(getGradingJobForTrace(auth, unsupportedEnd)).resolves
      .toBeUndefined();
  });
});
