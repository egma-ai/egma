import { gzipSync } from "node:zlib";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { OTLP_TRACES_PATH } from "../src/routes/traces.ts";
import {
  EXPORT_TRACE_SERVICE_REQUEST,
  EXPORT_TRACE_SERVICE_RESPONSE,
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
    const [row] = await store().rows<{
      organization_id: string;
      project_id: string;
    }>(
      "select organization_id, project_id from spans where trace_id = " +
        "'112233445566778899aabbccddeeff00' limit 1",
    );
    expect(row).toEqual({ organization_id: organizationId, project_id: projectId });
  });
});

describe("a payload that names a customer", () => {
  /**
   * A client can send whatever attributes it likes. Which account its
   * telemetry lands in is not one of them — the request's own claim is not
   * refused and not obeyed, it is simply never consulted.
   */
  it("is stored verbatim and changes nothing about whose it is", async () => {
    const traceId = "aaaabbbbccccddddeeeeffff00001111";
    const response = await post(
      jsonExport(
        [jsonSpan({ traceId, spanId: "1111222233334444" })],
        [
          { key: "organization_id", value: { stringValue: "org_somebody_else" } },
          { key: "project_id", value: { stringValue: "prj_somebody_else" } },
          {
            key: "egma.organization_id",
            value: { stringValue: "org_somebody_else" },
          },
        ],
      ),
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
    expect(row?.payload).toContain("org_somebody_else");
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

describe("a body the door cannot read", () => {
  it("is refused with a reason, rather than accepted and lost", async () => {
    const notProtobuf = await post(Buffer.from([0xff, 0xff, 0xff, 0xff]), {
      "content-type": "application/x-protobuf",
    });
    expect(notProtobuf.statusCode).toBe(400);
    expect(notProtobuf.json()).toMatchObject({ error: "not_otlp" });

    const notJson = await post("{ this is not json");
    expect(notJson.statusCode).toBe(400);

    const notAnExport = await post(JSON.stringify([{ resourceSpans: [] }]));
    expect(notAnExport.statusCode).toBe(400);

    const wrongShape = await post(JSON.stringify({ resourceSpans: "lots" }));
    expect(wrongShape.statusCode).toBe(400);
  });

  it("is refused when it arrives in an encoding OTLP does not define", async () => {
    const response = await post(jsonExport([jsonSpan()]), {
      "content-type": "text/csv",
    });
    expect(response.statusCode).toBe(415);
    expect(response.json()).toMatchObject({ error: "unsupported_encoding" });
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
