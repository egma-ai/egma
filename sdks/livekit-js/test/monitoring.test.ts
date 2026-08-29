import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";

import {
  ProxyTracerProvider,
  context as otelContext,
  trace,
  type Context,
  type Span,
} from "@opentelemetry/api";
import {
  NodeTracerProvider,
  type ReadableSpan,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-node";
import { telemetry, type JobContext } from "@livekit/agents";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  monitorLiveKit,
  monitoringStateForTests,
  projectKey,
  resetMonitoringForTests,
  traceEndpoint,
} from "../src/monitoring.ts";

const PROJECT_KEY = `egma_sk_${"a".repeat(43)}`;

type StubContext = {
  job: { room: { name: string }; agentName: string };
  callbacks: Array<() => Promise<void>>;
  addShutdownCallback(callback: () => Promise<void>): void;
};

function context(
  roomName = "production-room",
  agentName = "appointment-agent",
): StubContext {
  return {
    job: { room: { name: roomName }, agentName },
    callbacks: [],
    addShutdownCallback(callback) {
      this.callbacks.push(callback);
    },
  };
}

function asJobContext(value: StubContext): JobContext {
  return value as unknown as JobContext;
}

function unusedProviders() {
  const liveKit = new ProxyTracerProvider();
  const global = new ProxyTracerProvider();
  telemetry.setTracerProvider(liveKit);
  vi.spyOn(NodeTracerProvider.prototype, "register").mockImplementation(
    () => undefined,
  );
  return { liveKit, global };
}

afterEach(() => {
  resetMonitoringForTests();
  telemetry.setTracerProvider(new ProxyTracerProvider());
  otelContext.disable();
  trace.disable();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("monitorLiveKit", () => {
  it.each([
    ["voice", "egma-sim-sim_123"],
    ["chat", "egma-sim-chat-sim_123"],
  ])(
    "suppresses an Egma %s simulation from the room name alone",
    (_modality, roomName) => {
      const warning = vi
        .spyOn(console, "warn")
        .mockImplementation(() => undefined);
      const ctx = context(roomName);
      const forbiddenSignal = () => {
        throw new Error("monitorLiveKit read a non-room simulation signal");
      };
      Object.defineProperty(ctx.job, "metadata", { get: forbiddenSignal });
      Object.defineProperty(ctx.job.room, "metadata", {
        get: forbiddenSignal,
      });
      Object.defineProperty(ctx, "simulationContext", {
        value: forbiddenSignal,
      });

      monitorLiveKit(asJobContext(ctx));

      expect(ctx.callbacks).toHaveLength(0);
      expect(monitoringStateForTests()).toBeUndefined();
      expect(warning).toHaveBeenCalledWith(
        expect.stringContaining("not exported"),
      );
    },
  );

  it("ignores dispatch metadata and LiveKit's simulation context in a production room", () => {
    const { global } = unusedProviders();
    vi.spyOn(trace, "getTracerProvider").mockReturnValue(global);
    const ctx = context();
    const forbiddenSignal = () => {
      throw new Error("monitorLiveKit read a non-room simulation signal");
    };
    Object.defineProperty(ctx.job, "metadata", { get: forbiddenSignal });
    Object.defineProperty(ctx, "simulationContext", {
      value: forbiddenSignal,
    });

    monitorLiveKit(asJobContext(ctx), {
      endpoint: "https://api.egma.ai",
      apiKey: PROJECT_KEY,
    });

    expect(ctx.callbacks).toHaveLength(1);
    expect(monitoringStateForTests()).toBeDefined();
  });

  it("uses the exact OTLP endpoint and reuses one job's process exporter", () => {
    const { global } = unusedProviders();
    vi.spyOn(trace, "getTracerProvider").mockReturnValue(global);
    vi.stubEnv("EGMA_URL", "https://api.egma.ai/");
    vi.stubEnv("EGMA_API_KEY", PROJECT_KEY);
    const first = context();

    monitorLiveKit(asJobContext(first));
    monitorLiveKit(asJobContext(first));

    expect(monitoringStateForTests()?.endpoint).toBe(
      "https://api.egma.ai/v1/traces",
    );
    expect(first.callbacks).toHaveLength(1);
    expect(monitoringStateForTests()?.roomName).toBe("production-room");
    expect(telemetry.tracer.getProvider()).toBe(
      monitoringStateForTests()?.provider,
    );
  });

  it("refuses a different job in the same process without exposing either room", () => {
    const { global } = unusedProviders();
    vi.spyOn(trace, "getTracerProvider").mockReturnValue(global);
    const firstRoom = "private-first-room";
    const secondRoom = "private-second-room";
    monitorLiveKit(asJobContext(context(firstRoom)), {
      endpoint: "https://api.egma.ai",
      apiKey: PROJECT_KEY,
    });

    let message = "";
    try {
      monitorLiveKit(asJobContext(context(secondRoom)), {
        endpoint: "https://api.egma.ai",
        apiKey: PROJECT_KEY,
      });
    } catch (error) {
      message = String(error);
    }

    expect(message).toContain("different job");
    expect(message).toContain("Restart");
    expect(message).not.toContain(firstRoom);
    expect(message).not.toContain(secondRoom);
  });

  it("lets LiveKit Cloud add its processors to the shared provider", () => {
    const { global } = unusedProviders();
    vi.spyOn(trace, "getTracerProvider").mockReturnValue(global);
    const ended: ReadableSpan[] = [];
    const cloudProcessor: SpanProcessor = {
      onStart(_span: Span, _parentContext: Context) {},
      onEnd(span: ReadableSpan) {
        ended.push(span);
      },
      async forceFlush() {},
      async shutdown() {},
    };

    monitorLiveKit(asJobContext(context()), {
      endpoint: "https://api.egma.ai",
      apiKey: PROJECT_KEY,
    });
    const state = monitoringStateForTests();
    state?.liveKitFanout.add(cloudProcessor);
    const provider = state?.provider;
    provider?.getTracer("proof").startSpan("shared").end();

    expect(ended.map((span) => span.name)).toEqual(["shared"]);
    expect(ended[0]?.attributes).toMatchObject({
      "session.id": "production-room",
      "lk.agent_name": "appointment-agent",
    });
  });

  it("omits an empty LiveKit agent name from span metadata", () => {
    const { global } = unusedProviders();
    vi.spyOn(trace, "getTracerProvider").mockReturnValue(global);
    const ended: ReadableSpan[] = [];
    const observer: SpanProcessor = {
      onStart(_span: Span, _parentContext: Context) {},
      onEnd(span: ReadableSpan) {
        ended.push(span);
      },
      async forceFlush() {},
      async shutdown() {},
    };

    monitorLiveKit(asJobContext(context("production-room", "")), {
      endpoint: "https://api.egma.ai",
      apiKey: PROJECT_KEY,
    });
    const configured = monitoringStateForTests();
    configured?.liveKitFanout.add(observer);
    configured?.provider.getTracer("proof").startSpan("shared").end();

    expect(ended[0]?.attributes["session.id"]).toBe("production-room");
    expect(ended[0]?.attributes).not.toHaveProperty("lk.agent_name");
  });

  it("refuses to erase tracing that another integration already configured", () => {
    const provider = new NodeTracerProvider();
    vi.spyOn(telemetry.tracer, "getProvider").mockReturnValue(provider);
    vi.spyOn(trace, "getTracerProvider").mockReturnValue(provider);

    expect(() =>
      monitorLiveKit(asJobContext(context()), {
        endpoint: "https://api.egma.ai",
        apiKey: PROJECT_KEY,
      }),
    ).toThrow(/existing OpenTelemetry tracer provider/u);
  });

  it("detects a real provider behind OpenTelemetry's global proxy", async () => {
    trace.disable();
    const provider = new NodeTracerProvider();
    provider.register();
    const globalProvider = trace.getTracerProvider();
    telemetry.setTracerProvider(globalProvider);

    expect(globalProvider).toBeInstanceOf(ProxyTracerProvider);
    expect((globalProvider as ProxyTracerProvider).getDelegate()).toBe(provider);
    expect(() =>
      monitorLiveKit(asJobContext(context()), {
        endpoint: "https://api.egma.ai",
        apiKey: PROJECT_KEY,
      }),
    ).toThrow(/existing OpenTelemetry tracer provider/u);

    await provider.shutdown();
  });

  it("requires a worker restart when process settings change", () => {
    const { global } = unusedProviders();
    vi.spyOn(trace, "getTracerProvider").mockReturnValue(global);
    const firstKey = `egma_sk_${"a".repeat(43)}`;
    const secondKey = `egma_sk_${"b".repeat(43)}`;
    monitorLiveKit(asJobContext(context()), {
      endpoint: "https://api.egma.ai",
      apiKey: firstKey,
    });

    let message = "";
    try {
      monitorLiveKit(asJobContext(context()), {
        endpoint: "https://api.egma.ai",
        apiKey: secondKey,
      });
    } catch (error) {
      message = String(error);
    }

    expect(message).toContain("Restart");
    expect(message).not.toContain(firstKey);
    expect(message).not.toContain(secondKey);
  });

  it("names a wrong context instead of leaking an internal type error", () => {
    expect(() =>
      monitorLiveKit({} as JobContext, {
        endpoint: "https://api.egma.ai",
        apiKey: PROJECT_KEY,
      }),
    ).toThrow(/JobContext/u);
  });

  it("makes a failed shutdown flush safe and does not repeat its error or key", async () => {
    const { global } = unusedProviders();
    vi.spyOn(trace, "getTracerProvider").mockReturnValue(global);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const ctx = context();

    monitorLiveKit(asJobContext(ctx), {
      endpoint: "https://api.egma.ai",
      apiKey: PROJECT_KEY,
    });
    const leakedFailure = `collector rejected ${PROJECT_KEY}`;
    vi.spyOn(
      monitoringStateForTests()!.processor,
      "forceFlush",
    ).mockRejectedValue(new Error(leakedFailure));

    await expect(ctx.callbacks[0]!()).resolves.toBeUndefined();

    const output = warning.mock.calls.flat().join(" ");
    expect(output).toContain("could not flush every buffered span");
    expect(output).not.toContain(PROJECT_KEY);
    expect(output).not.toContain(leakedFailure);
  });
});

describe("configuration", () => {
  it.each([
    "ftp://api.egma.ai",
    "https://user:pass@api.egma.ai",
    "https://api.egma.ai?key=value",
    "https://api.egma.ai#fragment",
    "not a URL",
  ])("rejects the invalid endpoint %s", (endpoint) => {
    expect(() => traceEndpoint(endpoint)).toThrow(/valid HTTP or HTTPS/u);
  });

  it("does not append the trace path twice", () => {
    expect(traceEndpoint("https://api.egma.ai/v1/traces/")).toBe(
      "https://api.egma.ai/v1/traces",
    );
  });

  it("validates a project key without repeating it", () => {
    const secret = "egma_sk_do_not_repeat";
    let message = "";
    try {
      projectKey(secret);
    } catch (error) {
      message = String(error);
    }
    expect(message).toContain("invalid EGMA_API_KEY");
    expect(message).not.toContain(secret);
  });
});

describe("the public helper and real exporter", () => {
  it("flushes a LiveKit tracer span as authenticated OTLP protobuf", async () => {
    let server: Server | undefined;
    const received = new Promise<{
      method: string | undefined;
      path: string;
      authorization: string | undefined;
      contentType: string | undefined;
      body: Buffer;
    }>((resolve) => {
      server = createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
          resolve({
            method: request.method,
            path: request.url ?? "",
            authorization: request.headers.authorization,
            contentType: request.headers["content-type"],
            body: Buffer.concat(chunks),
          });
          response.writeHead(200, { "content-type": "application/x-protobuf" });
          response.end();
        });
      });
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const address = server?.address();
    if (address === null || address === undefined || typeof address === "string") {
      throw new Error("test collector has no TCP address");
    }
    const endpoint = `http://127.0.0.1:${String(address.port)}/v1/traces`;

    try {
      const probe = spawn(process.execPath, ["test/public-helper-probe.mjs"], {
        cwd: new URL("..", import.meta.url),
        env: {
          ...process.env,
          EGMA_TEST_ENDPOINT: endpoint,
          EGMA_TEST_PROJECT_KEY: PROJECT_KEY,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      probe.stdout.setEncoding("utf8");
      probe.stderr.setEncoding("utf8");
      probe.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      probe.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      const completed = new Promise<void>((resolve, reject) => {
        probe.on("error", reject);
        probe.on("exit", (code, signal) => {
          if (code === 0) {
            resolve();
            return;
          }
          reject(
            new Error(
              `public helper probe failed (${String(code ?? signal)}): ${stderr}`,
            ),
          );
        });
      });
      const [request] = await Promise.all([received, completed]);

      expect(stdout).toContain("public helper flush complete");
      expect(request.method).toBe("POST");
      expect(request.path).toBe("/v1/traces");
      expect(request.authorization).toBe(`Bearer ${PROJECT_KEY}`);
      expect(request.contentType).toContain("application/x-protobuf");
      expect(request.body.byteLength).toBeGreaterThan(0);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server?.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
