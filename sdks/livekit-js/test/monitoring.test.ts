import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";

import {
  ProxyTracerProvider,
  context as otelContext,
  trace,
  type Context,
  type Span,
  type TracerProvider,
} from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import {
  NodeTracerProvider,
  type ReadableSpan,
  type SpanExporter,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-node";
import { telemetry, type JobContext } from "@livekit/agents";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@livekit/agents", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@livekit/agents")>();
  return {
    ...actual,
    telemetry: {
      ...actual.telemetry,
      setTracerProvider: vi.fn(actual.telemetry.setTracerProvider),
    },
  };
});

import {
  monitorLiveKit,
  monitoringStateForTests,
  projectKey,
  resetMonitoringForTests,
  traceEndpoint,
} from "../src/monitoring.ts";

const PROJECT_KEY = `egma_sk_${"a".repeat(43)}`;

type CompatibleFanoutSpanProcessor = SpanProcessor & {
  add(processor: SpanProcessor): void;
};

type CompatibleCloudSpanProcessorFactory = (options: {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly exporter?: SpanExporter;
}) => SpanProcessor;

const compatibleTelemetry = telemetry as unknown as {
  readonly FanoutSpanProcessor?: new () => CompatibleFanoutSpanProcessor;
  readonly tracer: typeof telemetry.tracer & {
    getProvider: () => TracerProvider;
  };
  readonly setTracerProvider: (
    provider: TracerProvider,
    options?: {
      readonly createCloudSpanProcessor?: CompatibleCloudSpanProcessorFactory;
    },
  ) => void;
};

const SUPPORTS_SHARED_TELEMETRY =
  typeof compatibleTelemetry.FanoutSpanProcessor === "function" &&
  typeof compatibleTelemetry.tracer.getProvider === "function";

function setLiveKitTracerProvider(provider: TracerProvider): void {
  compatibleTelemetry.setTracerProvider(provider);
}

function liveKitTracerProvider(): TracerProvider | undefined {
  return typeof compatibleTelemetry.tracer.getProvider === "function"
    ? compatibleTelemetry.tracer.getProvider()
    : undefined;
}

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
  setLiveKitTracerProvider(liveKit);
  vi.spyOn(NodeTracerProvider.prototype, "register").mockImplementation(
    () => undefined,
  );
  return { liveKit, global };
}

afterEach(() => {
  resetMonitoringForTests();
  setLiveKitTracerProvider(new ProxyTracerProvider());
  otelContext.disable();
  trace.disable();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("simulation monitoring separation", () => {
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
});

describe.runIf(SUPPORTS_SHARED_TELEMETRY)("monitorLiveKit", () => {
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
    expect(liveKitTracerProvider()).toBe(monitoringStateForTests()?.provider);
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
    state?.registerSpanProcessor(cloudProcessor);
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
    configured?.registerSpanProcessor(observer);
    configured?.provider.getTracer("proof").startSpan("shared").end();

    expect(ended[0]?.attributes["session.id"]).toBe("production-room");
    expect(ended[0]?.attributes).not.toHaveProperty("lk.agent_name");
  });

  it("refuses to erase tracing that another integration already configured", () => {
    const provider = new NodeTracerProvider();
    vi.spyOn(compatibleTelemetry.tracer, "getProvider").mockReturnValue(
      provider,
    );
    vi.spyOn(trace, "getTracerProvider").mockReturnValue(provider);

    expect(() =>
      monitorLiveKit(asJobContext(context()), {
        endpoint: "https://api.egma.ai",
        apiKey: PROJECT_KEY,
      }),
    ).toThrow(/existing OpenTelemetry tracer provider/u);
  });

  it("adds Egma beside compatible existing telemetry", async () => {
    trace.disable();
    vi.stubEnv("LIVEKIT_API_KEY", "devkey");
    vi.stubEnv(
      "LIVEKIT_API_SECRET",
      "secretsecretsecretsecretsecretsecret",
    );
    const exported = vi
      .spyOn(OTLPTraceExporter.prototype, "export")
      .mockImplementation((_spans, callback) => callback({ code: 0 }));
    const existingSpans: ReadableSpan[] = [];
    const cloudSpans: ReadableSpan[] = [];
    const existingProcessor: SpanProcessor = {
      onStart(_span: Span, _parentContext: Context) {},
      onEnd(span: ReadableSpan) {
        existingSpans.push(span);
      },
      async forceFlush() {},
      async shutdown() {},
    };
    const cloudProcessor: SpanProcessor = {
      onStart(_span: Span, _parentContext: Context) {},
      onEnd(span: ReadableSpan) {
        cloudSpans.push(span);
      },
      async forceFlush() {},
      async shutdown() {},
    };
    const createCloudSpanProcessor = vi.fn(() => cloudProcessor);
    const FanoutSpanProcessor = compatibleTelemetry.FanoutSpanProcessor!;
    const fanout = new FanoutSpanProcessor();
    fanout.add(existingProcessor);
    const provider = new NodeTracerProvider({ spanProcessors: [fanout] });
    provider.register();
    const registerSpanProcessor = (processor: SpanProcessor) =>
      fanout.add(processor);

    monitorLiveKit(asJobContext(context()), {
      endpoint: "https://api.egma.ai",
      apiKey: PROJECT_KEY,
      existingTelemetry: {
        provider,
        registerSpanProcessor,
        createCloudSpanProcessor,
      },
    });
    await telemetry.setupCloudTracer({
      roomId: "cloud-room-id",
      jobId: "cloud-job-id",
      cloudHostname: "example.livekit.cloud",
      enableTraces: true,
      enableLogs: false,
    });
    provider.getTracer("proof").startSpan("shared-existing").end();
    await provider.forceFlush();

    expect(monitoringStateForTests()?.provider).toBe(provider);
    expect(liveKitTracerProvider()).toBe(provider);
    expect(existingSpans.map((span) => span.name)).toEqual([
      "shared-existing",
    ]);
    expect(existingSpans[0]?.attributes).toMatchObject({
      "session.id": "production-room",
      "lk.agent_name": "appointment-agent",
    });
    expect(createCloudSpanProcessor).toHaveBeenCalledOnce();
    expect(cloudSpans.map((span) => span.name)).toEqual([
      "shared-existing",
    ]);
    expect(exported).toHaveBeenCalledOnce();

    await provider.shutdown();
  });

  it("detects a real provider behind OpenTelemetry's global proxy", async () => {
    trace.disable();
    const provider = new NodeTracerProvider();
    provider.register();
    const globalProvider = trace.getTracerProvider();
    setLiveKitTracerProvider(globalProvider);

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

  it("keeps Egma and LiveKit Cloud export active on its owned provider", async () => {
    trace.disable();
    vi.stubEnv("LIVEKIT_API_KEY", "devkey");
    vi.stubEnv(
      "LIVEKIT_API_SECRET",
      "secretsecretsecretsecretsecretsecret",
    );
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const exported = vi
      .spyOn(OTLPTraceExporter.prototype, "export")
      .mockImplementation((_spans, callback) => callback({ code: 0 }));

    monitorLiveKit(asJobContext(context()), {
      endpoint: "https://api.egma.ai",
      apiKey: PROJECT_KEY,
    });
    await telemetry.setupCloudTracer({
      roomId: "cloud-room-id",
      jobId: "cloud-job-id",
      cloudHostname: "example.livekit.cloud",
      enableTraces: true,
      enableLogs: false,
    });
    const provider = monitoringStateForTests()?.provider;
    provider?.getTracer("proof").startSpan("shared-owned").end();
    await (provider as NodeTracerProvider | undefined)?.forceFlush();

    expect(exported).toHaveBeenCalledTimes(2);
    expect(warning).not.toHaveBeenCalledWith(
      expect.stringContaining("LiveKit Cloud tracing is disabled"),
    );

    await (provider as NodeTracerProvider | undefined)?.shutdown();
  });

  it("keeps LiveKit's supplied cloud upload gate on its owned provider", async () => {
    const { global } = unusedProviders();
    vi.spyOn(trace, "getTracerProvider").mockReturnValue(global);
    const setTracerProvider = vi.mocked(
      compatibleTelemetry.setTracerProvider,
    );
    setTracerProvider.mockClear();
    vi.spyOn(OTLPTraceExporter.prototype, "export").mockImplementation(
      (_spans, callback) => callback({ code: 0 }),
    );

    monitorLiveKit(asJobContext(context()), {
      endpoint: "https://api.egma.ai",
      apiKey: PROJECT_KEY,
    });
    const options = setTracerProvider.mock.calls.at(-1)?.[1];
    const createCloudSpanProcessor = options?.createCloudSpanProcessor;
    if (createCloudSpanProcessor === undefined) {
      throw new Error("monitorLiveKit did not provide a cloud processor factory");
    }
    const exportThroughGate = vi.fn<SpanExporter["export"]>(
      (_spans, callback) => callback({ code: 0 }),
    );
    const uploadGate: SpanExporter = {
      export: exportThroughGate,
      async shutdown() {},
    };
    const cloudProcessor = createCloudSpanProcessor({
      url: "https://example.livekit.cloud/observability/traces/otlp/v0",
      headers: { authorization: "Bearer livekit" },
      exporter: uploadGate,
    });
    const provider = new NodeTracerProvider({
      spanProcessors: [cloudProcessor],
    });
    provider.getTracer("proof").startSpan("gated-cloud-span").end();
    await provider.forceFlush();

    expect(exportThroughGate).toHaveBeenCalledOnce();

    await provider.shutdown();
  });
});

describe.runIf(!SUPPORTS_SHARED_TELEMETRY)(
  "monitorLiveKit without LiveKit shared telemetry",
  () => {
    it("keeps an Egma simulation inert before checking telemetry support", () => {
      const warning = vi
        .spyOn(console, "warn")
        .mockImplementation(() => undefined);
      const ctx = context("egma-sim-legacy");

      expect(() => monitorLiveKit(asJobContext(ctx))).not.toThrow();
      expect(ctx.callbacks).toHaveLength(0);
      expect(warning).toHaveBeenCalledWith(
        expect.stringContaining("not exported"),
      );
    });

    it("names the minimum LiveKit version for production monitoring", () => {
      expect(() => monitorLiveKit(asJobContext(context()))).toThrow(
        /@livekit\/agents>=1\.5\.5/u,
      );
    });
  },
);

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
  it.runIf(SUPPORTS_SHARED_TELEMETRY)("flushes a LiveKit tracer span as authenticated OTLP protobuf", async () => {
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
