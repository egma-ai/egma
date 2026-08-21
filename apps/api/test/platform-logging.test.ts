import { afterEach, describe, expect, it } from "vitest";

import { createApi, type TestApi } from "./support/api.ts";

let api: TestApi;

afterEach(async () => {
  await api?.close();
});

describe("platform logging", () => {
  it("writes one safe structured request record and keeps fallback email content out", async () => {
    const lines: string[] = [];
    api = await createApi("platform_logging", {
      defaultEmailSender: true,
      logTo: { write: (line) => lines.push(line) },
      traceStore: true,
    });

    const email = "private-recipient@example.com";
    await api.app.inject({
      method: "POST",
      url: "/api/signup",
      payload: {
        email,
        password: "a-long-enough-password",
        organizationName: "Acme",
      },
    });
    await api.app.inject({
      method: "POST",
      url: "/api/password-reset",
      payload: { email },
    });
    await api.app.inject({
      method: "GET",
      url: "/v1/agents?private_token=must-not-reach-the-log",
    });

    const beforeHealth = lines.filter((line) =>
      line.includes('"otel.event.name":"egma.http.server.request.finished"'),
    ).length;
    expect((await api.app.inject("/health")).statusCode).toBe(200);

    const records = lines.map(
      (line) => JSON.parse(line) as Record<string, unknown>,
    );
    const requests = records.filter(
      (record) =>
        record["otel.event.name"] === "egma.http.server.request.finished",
    );
    const platformRequest = requests.find(
      (record) => record["http.route"] === "/v1/agents",
    );

    expect(platformRequest).toMatchObject({
      level: 30,
      "otel.event.name": "egma.http.server.request.finished",
      "egma.log_schema_version": 1,
      body: "HTTP request finished",
      "http.request.method": "GET",
      "http.route": "/v1/agents",
      "http.response.status_code": 401,
      duration_ms: expect.any(Number),
    });
    expect(
      requests.filter((record) => record["http.route"] === "/v1/agents"),
    ).toHaveLength(1);
    expect(
      lines.filter((line) =>
        line.includes('"otel.event.name":"egma.http.server.request.finished"'),
      ),
    ).toHaveLength(beforeHealth);
    expect(records).toContainEqual(
      expect.objectContaining({
        "otel.event.name": "egma.email.delivery.skipped",
        "egma.log_schema_version": 1,
      }),
    );

    const privateValue = "customer-value-must-not-reach-docker";
    api.app.log.error(
      {
        err: new Error(privateValue),
        req: { body: privateValue },
        res: { payload: privateValue },
        details: [{ email: privateValue }],
      },
      "safe serializer proof",
    );
    const privacyRecord = JSON.parse(lines.at(-1) ?? "{}") as Record<
      string,
      unknown
    >;
    expect(privacyRecord).toMatchObject({
      level: 50,
      err: {
        type: "Error",
        message: "[redacted]",
        stack: "",
      },
      msg: "safe serializer proof",
      req: {},
      res: {},
    });
    expect(privacyRecord).not.toHaveProperty("details");
    expect(JSON.stringify(privacyRecord)).not.toContain(privateValue);
    expect(lines.join("\n")).not.toContain(email);
    expect(lines.join("\n")).not.toContain("must-not-reach-the-log");
    expect(lines.join("\n")).not.toContain("token=");
  });
});
