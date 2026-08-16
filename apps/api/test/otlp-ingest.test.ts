import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { OTLP_TRACES_PATH } from "../src/routes/traces.ts";
import { EXPORT_TRACE_SERVICE_RESPONSE } from "../src/otlp/schema.ts";
import { cookiesFrom, createApi, type TestApi } from "./support/api.ts";
import {
  capturedRequests,
  FIXTURE_PROVIDER_CALL_ID,
  FIXTURE_TRACE,
  FIXTURE_WINDOW,
  type CapturedRequest,
} from "./support/fixture.ts";

/**
 * A real LiveKit agent's telemetry, replayed at the door it will really arrive
 * at.
 *
 * This is the spine: fourteen captured OTLP bodies, byte for byte as an
 * exporter sent them, posted over HTTP to the running API with an ordinary Egma
 * API key, landing in a real ClickHouse. It exercises the credential, the
 * protobuf decoding, the normalisation, the tenancy stamp and the append in one
 * pass — because every one of those is a place the path could be right in
 * isolation and wrong end to end.
 *
 * What is asserted is the landed shape rather than the code's own opinion of
 * it. The read functions over `spans` belong to the next ticket, so the store
 * is queried directly here, the way the migration tests already do.
 */

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
    url: "/api/keys",
    headers: { cookie: cookiesFrom(created.headers["set-cookie"]) },
    payload: { name: `${organizationName}'s agent` },
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
  return api.app.inject({
    method: "POST",
    url: OTLP_TRACES_PATH,
    headers: {
      "content-type": contentType,
      ...(secret === null ? {} : { authorization: `Bearer ${secret}` }),
    },
    payload: body,
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

const inTheWindow =
  `started_at >= toDateTime64('${FIXTURE_WINDOW.from}', 6, 'UTC') ` +
  `and started_at < toDateTime64('${FIXTURE_WINDOW.to}', 6, 'UTC')`;

let acme: Customer;

beforeAll(async () => {
  requests = await capturedRequests();
  api = await createApi("otlp_ingest", { traceStore: true });
  acme = await signUpWithAKey("ada@acme.example", "Acme");
  await replay(acme.secret);
});

afterAll(async () => {
  await api?.close();
});

describe("the captured trace, posted at the door", () => {
  it("is fourteen requests the exporter really sent, and every one of them is protobuf", () => {
    expect(requests).toHaveLength(14);
    for (const request of requests) {
      expect(request.path).toBe(OTLP_TRACES_PATH);
      expect(request.contentType).toBe("application/x-protobuf");
    }
  });

  it("lands as one trace of the spans that arrived, and not one more", async () => {
    expect(await countOf("select count() as n from spans")).toBe(
      FIXTURE_TRACE.spans,
    );
    expect(
      await countOf("select uniqExact(trace_id) as n from spans"),
    ).toBe(1);
  });

  it("adopts the ids off the wire rather than minting any", async () => {
    const rows = await store().rows<{ trace_id: string; span_id: string }>(
      "select distinct trace_id, span_id from spans limit 200",
    );
    expect(rows).toHaveLength(FIXTURE_TRACE.spans);
    for (const row of rows) {
      expect(row.trace_id).toMatch(/^[0-9a-f]{32}$/);
      expect(row.span_id).toMatch(/^[0-9a-f]{16}$/);
    }
  });

  /**
   * The key this capture arrived on names no project, because that is what a
   * key minted for a whole customer does. Its rows file under the sentinel the
   * schema declares rather than under whichever project happened to be oldest —
   * pointing an organization-scoped credential at one product area would be
   * silent, and wrong the moment anything is read back by project.
   */
  it("files every row under the organization the key names, and under no project it did not", async () => {
    const rows = await store().rows<{
      organization_id: string;
      project_id: string;
    }>("select distinct organization_id, project_id from spans");

    expect(rows).toEqual([
      { organization_id: acme.organizationId, project_id: "default" },
    ]);
  });

  it("calls it production from an agent, in the environment nobody named", async () => {
    const rows = await store().rows<{
      source: string;
      emitter: string;
      environment: string;
    }>("select distinct source, emitter, environment from spans");

    expect(rows).toEqual([
      { source: "production", emitter: "agent", environment: "default" },
    ]);
  });

  it("keeps the vendor's own identifier for this trace on every row", async () => {
    const rows = await store().rows<{ provider_call_id: string }>(
      "select distinct provider_call_id from spans",
    );
    expect(rows).toEqual([{ provider_call_id: FIXTURE_PROVIDER_CALL_ID }]);
  });

  it("records when the trace happened, to the microsecond it was stamped", async () => {
    expect(
      await countOf(`select count() as n from spans where ${inTheWindow}`),
    ).toBe(FIXTURE_TRACE.spans);

    const [root] = await store().rows<{ started_at: string; duration_ns: number }>(
      "select started_at, duration_ns from spans where parent_span_id = '' limit 1",
    );
    // The wire said 1785693880281989804 nanoseconds. Microseconds is what the
    // column holds, and the sub-microsecond digits are dropped rather than
    // inserted raw — a raw nanosecond count would file this row in the year
    // 58567.
    expect(root?.started_at).toBe("2026-08-02 18:04:40.281989");
    // Full nanoseconds, which is the precision `started_at` gives up.
    expect(root?.duration_ns).toBe(73_494_876_403);
  });

  it("reads the transcript as turns, five from the human and eight from the agent", async () => {
    const rows = await store().rows<{ kind: string; n: number }>(
      "select kind, count() as n from turns group by kind order by kind",
    );
    expect(rows).toEqual([
      { kind: "turn:agent", n: FIXTURE_TRACE.agentTurns },
      { kind: "turn:human", n: FIXTURE_TRACE.humanTurns },
    ]);

    const [first] = await store().rows<{ text_preview: string }>(
      "select text_preview from turns where kind = 'turn:human' order by started_at limit 1",
    );
    expect(first?.text_preview).toBe("Hi Kelly, my name is Sam.");
  });

  it("keeps the tool the agent used, what it asked and what came back", async () => {
    const rows = await store().rows<{
      tool_name: string;
      tool_arguments: string;
      tool_result: string;
    }>(
      "select tool_name, tool_arguments, tool_result from spans " +
        "where kind = 'tool' order by started_at",
    );

    expect(rows).toHaveLength(FIXTURE_TRACE.toolSpans);
    expect(rows.map((row) => row.tool_name)).toEqual([
      "lookup_weather",
      "lookup_weather",
    ]);
    expect(rows[0]?.tool_arguments).toBe('{"location": "Lisbon"}');
    expect(rows[0]?.tool_result).toBe(
      "sunny with a temperature of 70 degrees.",
    );
  });

  /**
   * The capture deliberately keeps a real failure — a model timing out, the
   * fallback giving up, and the turn succeeding on the retry. A door that
   * quietly dropped the failed attempts would make every trace look healthier
   * than it was.
   */
  it("keeps the spans that failed, and what they said about it", async () => {
    const rows = await store().rows<{ name: string; payload: string }>(
      "select name, payload from spans where status = 'error' order by started_at",
    );

    expect(rows).toHaveLength(FIXTURE_TRACE.erroredSpans);
    expect(rows.map((row) => row.name).sort()).toEqual([
      "llm_request",
      "llm_request_run",
      "llm_request_run",
    ]);

    // The timeout that started it and the fallback that gave up after it, both
    // still readable on the rows they happened on.
    const said = rows.map((row) => row.payload).join("");
    expect(said).toContain("APITimeoutError");
    expect(said).toContain("all LLMs failed");
    expect(said).toContain("exception.stacktrace");
  });

  /**
   * Nothing was invented and nothing was thrown away: the names on the rows are
   * exactly the names the framework emitted, and there is no speech-to-text
   * span because this framework emits none — recognition rides the human's turn
   * as attributes.
   */
  it("stores one row per span that arrived, under the name it arrived with", async () => {
    const rows = await store().rows<{ name: string; n: string }>(
      "select name, count() as n from spans group by name order by name",
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

    expect(await countOf("select count() as n from spans where kind = 'stt'")).toBe(
      0,
    );
  });

  it("keeps the whole of what the human said, and the framework's own attributes with it", async () => {
    const [row] = await store().rows<{ text: string; payload: string }>(
      "select text, payload from spans where kind = 'turn:human' " +
        "order by started_at limit 1",
    );

    expect(row?.text).toBe("Hi Kelly, my name is Sam.");
    // The transcript's confidence and delay are not columns, and are not lost.
    expect(row?.payload).toContain("lk.transcript_confidence");
    expect(row?.payload).toContain("lk.transcription_delay");
    // The resource and the scope ride each row too, so nothing about where the
    // span came from has to be reconstructed later.
    expect(row?.payload).toContain("livekit-agents");
    expect(row?.payload).toContain("telemetry.sdk.version");
  });

  it("says which framework the agent was reached over, and measures no audio it did not hear", async () => {
    const rows = await store().rows<{
      connection_type: string;
      audio_sample_rate_hz: number;
      audio_encoding: string;
    }>(
      "select distinct connection_type, audio_sample_rate_hz, audio_encoding from spans",
    );
    expect(rows).toEqual([
      { connection_type: "livekit", audio_sample_rate_hz: 0, audio_encoding: "" },
    ]);
  });

  it("pins no run, no agent and no versions, because nothing here started one", async () => {
    expect(
      await countOf(
        "select count() as n from spans where run_id != '' or agent_id != '' " +
          "or agent_version_id != '' or test_version_id != '' " +
          "or persona_version_id != ''",
      ),
    ).toBe(0);
  });

  it("answers in the specification's own message, so an exporter can read it", async () => {
    const request = requests[0];
    if (request === undefined) throw new Error("the capture is empty");

    const response = await post(acme.secret, request.body, request.contentType);
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/x-protobuf");

    const answered = EXPORT_TRACE_SERVICE_RESPONSE.decode(response.rawPayload);
    expect(
      EXPORT_TRACE_SERVICE_RESPONSE.toObject(answered, { defaults: false }),
    ).toEqual({});
  });

  /**
   * An exporter retries a flush it never heard back about, and the bytes are
   * identical by design. Replaying the whole capture is that retry, fourteen
   * times over, and the row counts have to be exactly what they were.
   */
  it("is the same trace after being sent a second time, not two of it", async () => {
    const before = await countOf("select count() as n from spans");
    const turnsBefore = await countOf("select count() as n from turns");

    await replay(acme.secret);

    expect(await countOf("select count() as n from spans")).toBe(before);
    expect(await countOf("select count() as n from turns")).toBe(turnsBefore);
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
      "select organization_id, count() as n from spans " +
        "group by organization_id order by organization_id",
    );

    expect(new Map(rows.map((row) => [row.organization_id, row.n]))).toEqual(
      new Map([
        [acme.organizationId, FIXTURE_TRACE.spans],
        [globex.organizationId, FIXTURE_TRACE.spans],
      ]),
    );
  });

  /**
   * Read with raw SQL, so what this shows is that the rows are *separable* —
   * one shared trace id names a different trace in each account, because the
   * organization leads the filing order and the id does not. It is not a claim
   * that a customer cannot reach the other's rows: nothing reads spans through
   * the data-access module yet, and enforcing tenancy at read belongs to the
   * read functions, which inject the predicate the way every Postgres one
   * already does.
   */
  it("keeps each organization's copy separable by the organization, not by the trace id", async () => {
    const [row] = await store().rows<{ trace_id: string }>(
      "select distinct trace_id from spans limit 1",
    );
    const traceId = row?.trace_id ?? "";
    expect(traceId).not.toBe("");

    // The same trace id names a different trace in each account, which
    // is exactly what the organization leading the filing order is for.
    expect(
      await countOf(
        `select count() as n from spans where trace_id = '${traceId}' ` +
          `and organization_id = '${globex.organizationId}'`,
      ),
    ).toBe(FIXTURE_TRACE.spans);
  });
});

describe("a request with no usable credential", () => {
  it("is refused, and stores nothing", async () => {
    const request = requests[0];
    if (request === undefined) throw new Error("the capture is empty");

    const before = await countOf("select count() as n from spans");

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

    expect(await countOf("select count() as n from spans")).toBe(before);
  });
});
