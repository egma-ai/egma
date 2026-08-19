/**
 * The API has one application-log path: Pino writes JSON to container
 * standard output, and the deployment collector reads it with filelog.
 *
 * Pino's OpenTelemetry instrumentation has two independent features. Log
 * correlation adds trace and span ids to that JSON line. Log sending adds a
 * second destination that sends the same line through the OpenTelemetry Logs
 * SDK. The second feature would duplicate the filelog path.
 *
 * This test loads the real preload module and records the configuration it
 * gives the instrumentation. The OpenTelemetry and PostHog implementations
 * are replaced because the interface under test is startup configuration,
 * not a live request to an observability backend.
 */

import { describe, expect, it, vi } from "vitest";

const observed = vi.hoisted(() => ({
  pinoConfigurations: [] as Array<Record<string, unknown>>,
  sdkConfigurations: [] as unknown[],
}));

vi.mock("node:module", () => ({ register: vi.fn() }));

vi.mock("@opentelemetry/sdk-node", () => ({
  NodeSDK: class {
    constructor(configuration: unknown) {
      observed.sdkConfigurations.push(configuration);
    }

    start(): void {}

    shutdown(): Promise<void> {
      return Promise.resolve();
    }
  },
}));

vi.mock("@opentelemetry/instrumentation-http", () => ({
  HttpInstrumentation: class {},
}));

vi.mock("@opentelemetry/instrumentation-undici", () => ({
  UndiciInstrumentation: class {},
}));

vi.mock("@opentelemetry/instrumentation-pg", () => ({
  PgInstrumentation: class {},
}));

vi.mock("@opentelemetry/instrumentation-pino", () => ({
  PinoInstrumentation: class {
    constructor(configuration: Record<string, unknown>) {
      observed.pinoConfigurations.push(configuration);
    }
  },
}));

vi.mock("posthog-node", () => ({
  PostHog: class {
    shutdown(): Promise<void> {
      return Promise.resolve();
    }
  },
}));

describe("API platform telemetry", () => {
  it("keeps trace correlation without sending the stdout line through OTLP Logs", async () => {
    const names = [
      "EGMA_TELEMETRY",
      "EGMA_TELEMETRY_OTLP_ENDPOINT",
      "EGMA_POSTHOG_KEY",
      "OTEL_EXPORTER_OTLP_ENDPOINT",
      "OTEL_SERVICE_NAME",
    ] as const;
    const previous = new Map(names.map((name) => [name, process.env[name]]));
    const once = vi
      .spyOn(process, "once")
      .mockImplementation((() => process) as typeof process.once);

    try {
      process.env.EGMA_TELEMETRY = "on";
      process.env.EGMA_TELEMETRY_OTLP_ENDPOINT = "http://collector:4318";
      process.env.EGMA_POSTHOG_KEY = "phc_test";
      delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
      delete process.env.OTEL_SERVICE_NAME;

      await import("../src/telemetry.ts");

      expect(observed.sdkConfigurations).toHaveLength(1);
      expect(observed.pinoConfigurations).toEqual([{ disableLogSending: true }]);
      expect(observed.pinoConfigurations[0]).not.toHaveProperty("disableLogCorrelation");
    } finally {
      once.mockRestore();
      for (const name of names) {
        const value = previous.get(name);
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
});
