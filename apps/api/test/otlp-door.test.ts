import { gzipSync } from "node:zlib";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { OTLP_TRACES_PATH } from "../src/routes/traces.ts";
import {
  EXPORT_TRACE_SERVICE_REQUEST,
  EXPORT_TRACE_SERVICE_RESPONSE,
  RPC_STATUS_MESSAGE as RPC_STATUS,
} from "../src/otlp/schema.ts";
import { cookiesFrom, createApi, type TestApi } from "./support/api.ts";

/**
 * What the door accepts, what it refuses, and what it says either way.
 *
 * The captured LiveKit trace answers "does real telemetry land"; this file
 * answers the questions a capture cannot, because a capture is one exporter
 * behaving well: the other encoding, a body that is not what it claims, a
 * client that tries to name its own customer, and the shape of a refusal an
 * OpenTelemetry SDK is going to parse rather than read.
 */

let api: TestApi;
let secret: string;
let organizationId: string;
let projectId: string;

/** One span, written the way the OTLP JSON mapping says to write one. */
function jsonSpan(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    traceId: "112233445566778899aabbccddeeff00",
    spanId: "0011223344556677",
    name: "agent_turn",
    kind: "SPAN_KIND_INTERNAL",
    // Strings, because a 64-bit nanosecond count does not fit a JSON number.
    startTimeUnixNano: "1785693880281989804",
    endTimeUnixNano: "1785693881281989804",
    attributes: [
      { key: "session.id", value: { stringValue: "room-1" } },
      { key: "lk.response.text", value: { stringValue: "Hello there." } },
    ],
    ...overrides,
  };
}

function jsonExport(
  spans: readonly Record<string, unknown>[],
  resourceAttributes: readonly Record<string, unknown>[] = [],
): string {
  return JSON.stringify({
    resourceSpans: [
      {
        resource: { attributes: resourceAttributes },
        scopeSpans: [{ scope: { name: "livekit-agents" }, spans }],
      },
    ],
  });
}

async function post(body: Buffer | string, headers: Record<string, string> = {}) {
  return api.app.inject({
    method: "POST",
    url: OTLP_TRACES_PATH,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${secret}`,
      ...headers,
    },
    payload: body,
  });
}

function store(): NonNullable<TestApi["traceStore"]> {
  const traceStore = api.traceStore;
  if (traceStore === undefined) throw new Error("this API has no trace store");
  return traceStore;
}

beforeAll(async () => {
  api = await createApi("otlp_door", { traceStore: true });

  const created = await api.app.inject({
    method: "POST",
    url: "/api/signup",
    payload: {
      email: "ada@acme.example",
      password: "a-long-enough-password",
      organizationName: "Acme",
    },
  });
  expect(created.statusCode).toBe(201);
  const landed = created.json() as {
    organization: { id: string };
    project: { id: string };
  };
  organizationId = landed.organization.id;
  projectId = landed.project.id;

  // A key naming a project, because the two scopes file their rows
  // differently and only one of them is exercised by the capture.
  const minted = await api.app.inject({
    method: "POST",
    url: "/api/keys",
    headers: { cookie: cookiesFrom(created.headers["set-cookie"]) },
    payload: { name: "the outbound agent", project_id: projectId },
  });
  expect(minted.statusCode).toBe(201);
  secret = (minted.json() as { secret: string }).secret;
});

afterAll(async () => {
  await api?.close();
});

describe("the JSON encoding", () => {
  it("lands the same way protobuf does, ids and nanoseconds included", async () => {
    const response = await post(jsonExport([jsonSpan()]));
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/json");
    expect(response.json()).toEqual({});

    const [row] = await store().rows<{
      trace_id: string;
      span_id: string;
      started_at: string;
      duration_ns: number;
      kind: string;
      text: string;
      provider_call_id: string;
    }>(
      "select trace_id, span_id, started_at, duration_ns, kind, text, " +
        "provider_call_id from spans where trace_id = " +
        "'112233445566778899aabbccddeeff00'",
    );

    expect(row).toEqual({
      trace_id: "112233445566778899aabbccddeeff00",
      span_id: "0011223344556677",
      started_at: "2026-08-02 18:04:40.281989",
      duration_ns: 1_000_000_000,
      kind: "turn:agent",
      text: "Hello there.",
      provider_call_id: "room-1",
    });
  });

  it("files a project-scoped key's rows under that project", async () => {
    // Its own trace and its own row, so that what this asserts is the key's
    // scope rather than whatever the test before it happened to leave behind.
    const traceId = "0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f";
    const response = await post(
      jsonExport([jsonSpan({ traceId, spanId: "0f0f0f0f0f0f0f0f" })]),
    );
    expect(response.statusCode).toBe(200);

    const [row] = await store().rows<{
      organization_id: string;
      project_id: string;
    }>(
      `select organization_id, project_id from spans where trace_id = '${traceId}'`,
    );
    expect(row).toEqual({ organization_id: organizationId, project_id: projectId });
  });

  it("keeps a Pipecat service span whole without making a transcript turn", async () => {
    const traceId = "21212121212121212121212121212121";
    const frameworkSpan = jsonSpan({
      traceId,
      spanId: "2121212121212121",
      parentSpanId: "1010101010101010",
      name: "tts",
      // Egma's pinned OTel request encoder is converted with integer enums,
      // which is the exact simulator document shape this door receives.
      kind: 3,
      flags: 257,
      droppedAttributesCount: 2,
      droppedEventsCount: 3,
      droppedLinksCount: 4,
      attributes: [
        { key: "gen_ai.provider.name", value: { stringValue: "elevenlabs" } },
        { key: "settings.sample_rate", value: { intValue: "16000" } },
      ],
      status: { code: 2, message: "native status" },
      events: [
        {
          timeUnixNano: "1785693880781989804",
          name: "audio-ready",
          droppedAttributesCount: 1,
          attributes: [
            { key: "pipecat.event", value: { stringValue: "kept" } },
          ],
        },
      ],
      links: [
        {
          traceId: "31313131313131313131313131313131",
          spanId: "3131313131313131",
          traceState: "vendor=kept",
          flags: 769,
          droppedAttributesCount: 5,
          attributes: [
            { key: "pipecat.link", value: { stringValue: "kept" } },
          ],
        },
      ],
    });
    const body = JSON.stringify({
      resourceSpans: [
        {
          resource: {
            attributes: [
              {
                key: "service.name",
                value: { stringValue: "egma-simulator" },
              },
            ],
          },
          scopeSpans: [
            {
              scope: {
                name: "pipecat",
                attributes: [
                  { key: "scope.native", value: { stringValue: "kept" } },
                ],
              },
              spans: [frameworkSpan],
            },
          ],
        },
      ],
    });

    const response = await post(body);
    expect(response.statusCode).toBe(200);

    const [row] = await store().rows<{
      kind: string;
      text: string;
      payload: string;
    }>(`select kind, text, payload from spans where trace_id = '${traceId}'`);
    expect(row?.kind).toBe("other");
    expect(row?.text).toBe("");
    expect(JSON.parse(row?.payload ?? "{}")).toEqual({
      resource: {
        attributes: [
          { key: "service.name", value: { stringValue: "egma-simulator" } },
        ],
      },
      resourceSchemaUrl: "",
      scope: {
        name: "pipecat",
        attributes: [
          { key: "scope.native", value: { stringValue: "kept" } },
        ],
      },
      scopeSchemaUrl: "",
      span: frameworkSpan,
    });
    const [turns] = await store().rows<{ n: number }>(
      `select count() as n from turns where trace_id = '${traceId}'`,
    );
    expect(turns?.n).toBe(0);
  });
});

describe("a payload that names a customer", () => {
  /**
   * A client can send whatever attributes it likes. Which account its
   * telemetry lands in is not one of them — the request's own claim is not
   * refused and not obeyed, it is simply never consulted.
   */
  it("is stored verbatim and changes nothing about whose it is, at any level it is claimed", async () => {
    const traceId = "aaaabbbbccccddddeeeeffff00001111";
    const claim = (prefix: string) => [
      { key: "organization_id", value: { stringValue: `org_${prefix}` } },
      { key: "project_id", value: { stringValue: `prj_${prefix}` } },
      { key: "egma.organization_id", value: { stringValue: `org_${prefix}` } },
    ];

    // The three places an attribute can be put, all claiming a different
    // account. A client is entitled to send any of them; none of them is where
    // the answer comes from.
    const response = await post(
      JSON.stringify({
        resourceSpans: [
          {
            resource: { attributes: claim("on_the_resource") },
            scopeSpans: [
              {
                scope: {
                  name: "livekit-agents",
                  attributes: claim("on_the_scope"),
                },
                spans: [
                  jsonSpan({
                    traceId,
                    spanId: "1111222233334444",
                    attributes: [
                      ...claim("on_the_span"),
                      { key: "session.id", value: { stringValue: "room-1" } },
                    ],
                  }),
                ],
              },
            ],
          },
        ],
      }),
    );
    expect(response.statusCode).toBe(200);

    const [row] = await store().rows<{
      organization_id: string;
      project_id: string;
      payload: string;
    }>(
      `select organization_id, project_id, payload from spans where trace_id = '${traceId}'`,
    );

    expect(row?.organization_id).toBe(organizationId);
    expect(row?.project_id).toBe(projectId);
    // Not obeyed, and not thrown away either: it is somebody's data.
    for (const claimed of ["on_the_resource", "on_the_scope", "on_the_span"]) {
      expect(row?.payload).toContain(`org_${claimed}`);
      expect(row?.payload).toContain(`prj_${claimed}`);
    }
  });
});

describe("the environment a span was recorded in", () => {
  it("is discovered from the telemetry, with no declaration step anywhere", async () => {
    const traceId = "00001111222233334444555566667777";
    const response = await post(
      jsonExport(
        [jsonSpan({ traceId, spanId: "aaaabbbbccccdddd" })],
        [
          {
            key: "deployment.environment.name",
            value: { stringValue: "staging" },
          },
        ],
      ),
    );
    expect(response.statusCode).toBe(200);

    const [row] = await store().rows<{ environment: string }>(
      `select environment from spans where trace_id = '${traceId}'`,
    );
    expect(row?.environment).toBe("staging");
  });

  /**
   * The rejection is reported the way OTLP says to report one — a 200 carrying
   * a count of rejected spans and a message — rather than as an error status.
   * The specification is explicit that rejected data must not be retried, and
   * an exporter told "500" will retry it forever.
   */
  it("cannot start with the prefix egma keeps for itself, and says so in the export response", async () => {
    const traceId = "99998888777766665555444433332222";
    const response = await post(
      jsonExport(
        [jsonSpan({ traceId, spanId: "9999888877776666" })],
        [
          {
            key: "deployment.environment.name",
            value: { stringValue: "egma-internal" },
          },
        ],
      ),
    );

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      partialSuccess: {
        rejectedSpans: "1",
        errorMessage: expect.stringContaining("reserved prefix"),
      },
    });

    const [row] = await store().rows<{ n: number }>(
      `select count() as n from spans where trace_id = '${traceId}'`,
    );
    expect(row?.n).toBe(0);
  });
});

describe("a span that named itself nothing", () => {
  it("is rejected rather than given an id egma made up", async () => {
    const good = jsonSpan({
      traceId: "12121212121212121212121212121212",
      spanId: "1212121212121212",
    });
    const response = await post(
      jsonExport([good, jsonSpan({ traceId: "", spanId: "" })]),
    );

    expect(response.statusCode).toBe(200);
    const answered = response.json() as {
      partialSuccess?: { rejectedSpans: string; errorMessage: string };
    };
    expect(answered.partialSuccess?.rejectedSpans).toBe("1");
    expect(answered.partialSuccess?.errorMessage).toContain("mints neither");

    // The good one still landed: a batch is not thrown away over one bad span.
    expect(
      (
        await store().rows<{ n: number }>(
          "select count() as n from spans where trace_id = " +
            "'12121212121212121212121212121212'",
        )
      )[0]?.n,
    ).toBe(1);
  });
});

/**
 * A duration that cannot be added to anything.
 *
 * `duration_ns` is a `UInt64`, but every read that works out when a trace ended
 * adds it to a start time in signed 64-bit arithmetic — so a count past Int64's
 * ceiling comes back negative and the trace ends before it begins. Nearly three
 * centuries of nanoseconds is a broken clock rather than a long call, and an
 * exporter sending `0` for a start and a real timestamp for an end reaches it,
 * so it is clamped at the door where the number is still explainable. Nothing is
 * lost: the two timestamps it was measured from are in the payload as they
 * arrived.
 */
describe("a span that says it ran for longer than Int64 holds", () => {
  it("is stored with its duration clamped rather than wrapped", async () => {
    const traceId = "13131313131313131313131313131313";
    const response = await post(
      jsonExport([
        jsonSpan({
          traceId,
          spanId: "1313131313131313",
          startTimeUnixNano: "0",
          // The largest thing a UInt64 holds, which is what an exporter with a
          // zeroed clock at one end produces.
          endTimeUnixNano: "18446744073709551615",
        }),
      ]),
    );
    expect(response.statusCode, response.body).toBe(200);

    const [row] = await store().rows<{ duration_ns: string; ends: string }>(
      `select toString(duration_ns) as duration_ns,
              toString(toInt64(duration_ns)) as ends
       from spans where trace_id = '${traceId}'`,
    );
    expect(row?.duration_ns).toBe("9223372036854775807");
    // And the signed reading of it is the same number, rather than a negative
    // one, which is the whole point of clamping where it is clamped.
    expect(row?.ends).toBe("9223372036854775807");
  });
});

describe("a body the door cannot read", () => {
  it("is refused with a reason, rather than accepted and lost", async () => {
    const notProtobuf = await post(Buffer.from([0xff, 0xff, 0xff, 0xff]), {
      "content-type": "application/x-protobuf",
    });
    expect(notProtobuf.statusCode).toBe(400);

    const notJson = await post("{ this is not json");
    expect(notJson.statusCode).toBe(400);
    expect((notJson.json() as { message: string }).message).toContain("JSON");

    const notAnExport = await post(JSON.stringify([{ resourceSpans: [] }]));
    expect(notAnExport.statusCode).toBe(400);

    const wrongShape = await post(JSON.stringify({ resourceSpans: "lots" }));
    expect(wrongShape.statusCode).toBe(400);
  });

  /**
   * The specification says a refusal is a `google.rpc.Status` in the encoding
   * the request arrived in. An exporter that sent protobuf parses protobuf
   * back, and handing it a JSON object means the only thing it can report is
   * the number 400 — the reason never reaches whoever has to fix it.
   */
  it("is refused in the specification's own message, in the encoding it arrived in", async () => {
    const response = await post(Buffer.from([0xff, 0xff, 0xff, 0xff]), {
      "content-type": "application/x-protobuf",
    });

    expect(response.statusCode).toBe(400);
    expect(response.headers["content-type"]).toContain("application/x-protobuf");

    const status = RPC_STATUS.toObject(RPC_STATUS.decode(response.rawPayload), {
      defaults: false,
    }) as { code?: number; message?: string };
    // INVALID_ARGUMENT, which is what a body that is not the message it claims
    // to be is.
    expect(status.code).toBe(3);
    expect(status.message).toContain("ExportTraceServiceRequest");
  });

  it("is refused when it arrives in an encoding OTLP does not define", async () => {
    const response = await post(jsonExport([jsonSpan()]), {
      "content-type": "text/csv",
    });
    expect(response.statusCode).toBe(415);
    // No encoding was named that egma could answer in, so the refusal is JSON,
    // which is what somebody reading a `curl` sees.
    expect(response.json()).toEqual({
      code: 3,
      message: expect.stringContaining("application/x-protobuf"),
    });
  });
});

describe("a compressed export", () => {
  it("is read, because that is how most exporters are configured", async () => {
    const traceId = "55556666777788889999000011112222";
    const body = EXPORT_TRACE_SERVICE_REQUEST.encode(
      EXPORT_TRACE_SERVICE_REQUEST.fromObject({
        resourceSpans: [
          {
            resource: { attributes: [] },
            scopeSpans: [
              {
                scope: { name: "livekit-agents" },
                spans: [
                  {
                    traceId: Buffer.from(traceId, "hex"),
                    spanId: Buffer.from("5555666677778888", "hex"),
                    name: "user_turn",
                    startTimeUnixNano: "1785693880281989804",
                    endTimeUnixNano: "1785693881281989804",
                  },
                ],
              },
            ],
          },
        ],
      }),
    ).finish();

    const response = await post(gzipSync(Buffer.from(body)), {
      "content-type": "application/x-protobuf",
      "content-encoding": "gzip",
    });
    expect(response.statusCode).toBe(200);
    expect(
      EXPORT_TRACE_SERVICE_RESPONSE.toObject(
        EXPORT_TRACE_SERVICE_RESPONSE.decode(response.rawPayload),
        { defaults: false },
      ),
    ).toEqual({});

    const [row] = await store().rows<{ kind: string }>(
      `select kind from spans where trace_id = '${traceId}'`,
    );
    expect(row?.kind).toBe("turn:human");
  });

  it("is refused when the compression is one egma cannot undo", async () => {
    const response = await post(jsonExport([jsonSpan()]), {
      "content-encoding": "br",
    });
    expect(response.statusCode).toBe(400);
    expect((response.json() as { message: string }).message).toContain("gzip");
  });
});

describe("an export carrying nothing", () => {
  it("is a perfectly good request and stores no rows", async () => {
    const before = (
      await store().rows<{ n: number }>("select count() as n from spans")
    )[0]?.n;

    const response = await post(JSON.stringify({}));
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({});

    expect(
      (await store().rows<{ n: number }>("select count() as n from spans"))[0]?.n,
    ).toBe(before);
  });
});

/**
 * What a client sends and what egma has to hold are not the same size.
 *
 * Every row carries its resource and its scope verbatim, which is what makes a
 * span readable on its own — and it means one enormous resource shared by two
 * thousand spans is one small request and gigabytes of rows. Both caps are
 * reported the way OTLP says to report data that must not be retried, so an
 * exporter is told how much was refused rather than left to believe all of it
 * landed.
 */
describe("an export asking for more than egma turns into rows", () => {
  it("stores what fits and reports the rest, when one fat resource rides every span", async () => {
    const traceId = "cafe0000cafe0000cafe0000cafe0000";
    const spans = 100;
    const fat = "r".repeat(1024 * 1024);

    const response = await post(
      jsonExport(
        Array.from({ length: spans }, (_, index) =>
          jsonSpan({
            traceId,
            spanId: `cafe0000${index.toString(16).padStart(8, "0")}`,
          }),
        ),
        [{ key: "lk.big", value: { stringValue: fat } }],
      ),
    );

    expect(response.statusCode).toBe(200);
    const answered = response.json() as {
      partialSuccess?: { rejectedSpans: string; errorMessage: string };
    };

    const rejected = Number(answered.partialSuccess?.rejectedSpans ?? 0);
    expect(rejected).toBeGreaterThan(0);
    expect(rejected).toBeLessThan(spans);
    expect(answered.partialSuccess?.errorMessage).toContain("MiB of rows");

    const [row] = await store().rows<{ n: number }>(
      `select count() as n from spans where trace_id = '${traceId}'`,
    );
    // Nothing vanished between the two numbers: what was stored and what was
    // refused are the whole of what arrived.
    expect((row?.n ?? 0) + rejected).toBe(spans);
  });

  it("stores what fits and reports the rest, when there are simply too many spans", async () => {
    const traceId = "beef0000beef0000beef0000beef0000";
    const spans = 10_005;

    const response = await post(
      jsonExport(
        Array.from({ length: spans }, (_, index) =>
          jsonSpan({
            traceId,
            spanId: `beef0000${index.toString(16).padStart(8, "0")}`,
            attributes: [],
          }),
        ),
      ),
    );

    expect(response.statusCode).toBe(200);
    const answered = response.json() as {
      partialSuccess?: { rejectedSpans: string; errorMessage: string };
    };
    expect(answered.partialSuccess?.rejectedSpans).toBe("5");
    expect(answered.partialSuccess?.errorMessage).toContain("10,000");

    const [row] = await store().rows<{ n: number }>(
      `select count() as n from spans where trace_id = '${traceId}'`,
    );
    expect(row?.n).toBe(10_000);
  });
});

/**
 * A `bytes` attribute is the one value the two encodings could disagree about,
 * because protobuf carries raw bytes and JSON carries base64. They are read as
 * the same base64 text here, so a span means the same thing whichever way its
 * exporter is configured.
 */
describe("an attribute carrying bytes", () => {
  const raw = Buffer.from([0x00, 0x01, 0xfe, 0xff]);
  const asBase64 = raw.toString("base64");

  it("lands as base64 text, and does not throw, in the JSON encoding", async () => {
    const traceId = "b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1";
    const response = await post(
      jsonExport([
        jsonSpan({
          traceId,
          spanId: "b1b1b1b1b1b1b1b1",
          name: "function_tool",
          attributes: [
            { key: "lk.function_tool.name", value: { stringValue: "lookup" } },
            {
              key: "lk.function_tool.arguments",
              value: { bytesValue: asBase64 },
            },
          ],
        }),
      ]),
    );
    expect(response.statusCode).toBe(200);

    const [row] = await store().rows<{
      tool_arguments: string;
      payload: string;
    }>(
      `select tool_arguments, payload from spans where trace_id = '${traceId}'`,
    );
    expect(row?.tool_arguments).toBe(asBase64);
    expect(row?.payload).toContain(asBase64);
  });

  it("lands as the same base64 text in the protobuf encoding", async () => {
    const traceId = "b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2";
    const body = EXPORT_TRACE_SERVICE_REQUEST.encode(
      EXPORT_TRACE_SERVICE_REQUEST.fromObject({
        resourceSpans: [
          {
            resource: { attributes: [] },
            scopeSpans: [
              {
                scope: { name: "livekit-agents" },
                spans: [
                  {
                    traceId: Buffer.from(traceId, "hex"),
                    spanId: Buffer.from("b2b2b2b2b2b2b2b2", "hex"),
                    name: "function_tool",
                    startTimeUnixNano: "1785693880281989804",
                    endTimeUnixNano: "1785693881281989804",
                    attributes: [
                      {
                        key: "lk.function_tool.name",
                        value: { stringValue: "lookup" },
                      },
                      {
                        key: "lk.function_tool.arguments",
                        value: { bytesValue: raw },
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      }),
    ).finish();

    const response = await post(Buffer.from(body), {
      "content-type": "application/x-protobuf",
    });
    expect(response.statusCode).toBe(200);

    const [row] = await store().rows<{
      tool_arguments: string;
      payload: string;
    }>(
      `select tool_arguments, payload from spans where trace_id = '${traceId}'`,
    );
    expect(row?.tool_arguments).toBe(asBase64);
    expect(row?.payload).toContain(asBase64);
  });
});

describe("an id shouted in uppercase hex", () => {
  /**
   * The JSON mapping says lowercase and every exporter obeys, but a
   * hand-written client that writes its hex in capitals means the same trace —
   * and storing the two spellings apart would cut one conversation in half.
   */
  it("is the same id, stored the one way egma writes them", async () => {
    const response = await post(
      jsonExport([
        jsonSpan({
          traceId: "AABBCCDDEEFF00112233445566778899",
          spanId: "AABBCCDDEEFF0011",
        }),
      ]),
    );
    expect(response.statusCode).toBe(200);

    const [row] = await store().rows<{ span_id: string }>(
      "select span_id from spans where trace_id = " +
        "'aabbccddeeff00112233445566778899'",
    );
    expect(row?.span_id).toBe("aabbccddeeff0011");
  });
});

describe("a span whose parent is not an id", () => {
  /**
   * The parent is normalised to empty, which is how a root is recognised — so a
   * span with a malformed parent reads as a second root rather than as the
   * child of something that is not there. What arrived is still in the payload,
   * and the nesting ticket treats a span whose parent is not in the trace as
   * top-level under the real root. Documented rather than refused: the span
   * itself is perfectly good telemetry.
   */
  it("is stored as a root, with what arrived kept in the payload", async () => {
    const traceId = "d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1";
    const response = await post(
      jsonExport([
        jsonSpan({
          traceId,
          spanId: "d1d1d1d1d1d1d1d1",
          parentSpanId: "not-a-span-id",
        }),
      ]),
    );
    expect(response.statusCode).toBe(200);

    const [row] = await store().rows<{
      parent_span_id: string;
      payload: string;
    }>(
      `select parent_span_id, payload from spans where trace_id = '${traceId}'`,
    );
    expect(row?.parent_span_id).toBe("");
    expect(row?.payload).toContain("not-a-span-id");
  });
});

describe("a request carrying no credential at all", () => {
  /**
   * The body is the expensive part of an export, and reading it for somebody
   * who named nobody is how an unauthenticated flood costs a server the memory
   * of every request in flight. So the credential is looked for before a byte
   * is read — which is visible from outside precisely here: a body over the
   * limit is answered as an unauthenticated request rather than as one that was
   * read far enough to be too large.
   */
  it("is refused before its body is read at all", async () => {
    const enormous = Buffer.alloc(21 * 1024 * 1024, "x");

    const anonymous = await api.app.inject({
      method: "POST",
      url: OTLP_TRACES_PATH,
      headers: { "content-type": "application/json" },
      payload: enormous,
    });
    expect(anonymous.statusCode).toBe(401);

    // And the limit it was not measured against is real: the same body with a
    // key on it is read, and stops at the cap.
    const credentialed = await post(enormous);
    expect(credentialed.statusCode).toBe(413);
  });
});

describe("the role the key's holder acts at", () => {
  let viewerSecret: string;
  let viewerOrganizationId: string;

  beforeAll(async () => {
    const created = await api.app.inject({
      method: "POST",
      url: "/api/signup",
      payload: {
        email: "vic@initech.example",
        password: "a-long-enough-password",
        organizationName: "Initech",
      },
    });
    expect(created.statusCode).toBe(201);
    viewerOrganizationId = (
      created.json() as { organization: { id: string } }
    ).organization.id;

    const minted = await api.app.inject({
      method: "POST",
      url: "/api/keys",
      headers: { cookie: cookiesFrom(created.headers["set-cookie"]) },
      payload: { name: "the read-only terminal" },
    });
    expect(minted.statusCode).toBe(201);
    viewerSecret = (minted.json() as { secret: string }).secret;
  });

  /**
   * A key acts at the role its creator holds now, so demoting somebody reaches
   * every key they ever minted on its next request. A read-only credential that
   * could still file spans into the organization would be read-only in name
   * only.
   */
  it("refuses a viewer's key, and writes nothing for it", async () => {
    await api.database.sql(
      "update membership set role = $1 where organization_id = $2",
      ["viewer", viewerOrganizationId],
    );

    const traceId = "0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e";
    const response = await api.app.inject({
      method: "POST",
      url: OTLP_TRACES_PATH,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${viewerSecret}`,
      },
      payload: jsonExport([jsonSpan({ traceId, spanId: "0e0e0e0e0e0e0e0e" })]),
    });

    expect(response.statusCode).toBe(403);
    // PERMISSION_DENIED, as the specification's Status writes one.
    expect(response.json()).toMatchObject({ code: 7 });

    const [row] = await store().rows<{ n: number }>(
      `select count() as n from spans where trace_id = '${traceId}'`,
    );
    expect(row?.n).toBe(0);
  });

  it("takes the same key's export once its holder is a member again", async () => {
    await api.database.sql(
      "update membership set role = $1 where organization_id = $2",
      ["member", viewerOrganizationId],
    );

    const traceId = "0e0e0e0e0e0e0e0e0e0e0e0e0e0e1111";
    const response = await api.app.inject({
      method: "POST",
      url: OTLP_TRACES_PATH,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${viewerSecret}`,
      },
      payload: jsonExport([jsonSpan({ traceId, spanId: "0e0e0e0e0e0e1111" })]),
    });

    expect(response.statusCode).toBe(200);

    const [row] = await store().rows<{ organization_id: string }>(
      `select organization_id from spans where trace_id = '${traceId}'`,
    );
    expect(row?.organization_id).toBe(viewerOrganizationId);
  });
});

describe("a batch the trace store will never take", () => {
  /**
   * The specification's rule is the whole of the design here: rejected data
   * must not be retried, and a 5xx is read by every exporter as *try again
   * later*. So a store that has looked at these rows and refused them — a
   * constraint they violate, a column they no longer fit — is answered as a
   * rejection, which stops the retry loop and says why. A store that is merely
   * unreachable is the opposite case and stays an error, because those rows
   * would land perfectly well a minute from now.
   */
  it("is answered as a rejection rather than as an error an exporter will retry", async () => {
    const traceId = "f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0";
    await store().command(
      "alter table spans add constraint takes_nothing check length(span_id) < 0",
    );

    try {
      const response = await post(
        jsonExport([jsonSpan({ traceId, spanId: "f0f0f0f0f0f0f0f0" })]),
      );

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        partialSuccess: {
          rejectedSpans: "1",
          errorMessage: expect.stringContaining("the trace store refused"),
        },
      });
    } finally {
      await store().command(
        "alter table spans drop constraint takes_nothing",
      );
    }

    const [row] = await store().rows<{ n: number }>(
      `select count() as n from spans where trace_id = '${traceId}'`,
    );
    expect(row?.n).toBe(0);

    // And the door still works: the refusal was about those rows.
    const after = await post(
      jsonExport([jsonSpan({ traceId, spanId: "f0f0f0f0f0f0f0f0" })]),
    );
    expect(after.statusCode).toBe(200);
    expect(after.json()).toEqual({});
  });
});
