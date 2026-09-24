import { createServer } from "node:http";

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
  exportStateForTests as monitoringStateForTests,
  installExport,
  projectKey,
  resetExportForTests as resetMonitoringForTests,
  traceEndpoint,
} from "../src/export.ts";
import { monitor } from "../src/monitoring.ts";

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

type HeldAnswer = {
  status: number;
  answer(): void;
};

async function localCollector(autoStatuses: number[] = []): Promise<{
  readonly endpoint: string;
  readonly requests: readonly Buffer[];
  readonly answerNext: (status?: number) => void;
  readonly waitForRequests: (count: number) => Promise<void>;
  readonly close: () => Promise<void>;
}> {
  const requests: Buffer[] = [];
  const answers: HeldAnswer[] = [];
  const waiting = new Set<() => void>();
  const server = createServer((request, response) => {
    const body: Buffer[] = [];
    request.on("data", (piece: Buffer) => body.push(piece));
    request.on("end", () => {
      requests.push(Buffer.concat(body));
      for (const ready of waiting) ready();
      waiting.clear();
      const held: HeldAnswer = {
        status: 200,
        answer() {
          response.writeHead(this.status, {
            "content-type": "application/x-protobuf",
            ...(this.status === 503 ? { "retry-after": "0" } : {}),
          });
          response.end();
        },
      };
      const status = autoStatuses.shift();
      if (status === undefined) {
        answers.push(held);
      } else {
        held.status = status;
        held.answer();
      }
    });
  });
  await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("the local OTLP collector did not take a port");
  }
  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    requests,
    answerNext(status = 200) {
      const held = answers.shift();
      if (held === undefined) throw new Error("no OTLP request is waiting");
      held.status = status;
      held.answer();
    },
    async waitForRequests(count) {
      while (requests.length < count) {
        await new Promise<void>((resolve) => waiting.add(resolve));
      }
    },
    close: async () => {
      for (const held of answers.splice(0)) held.answer();
      await new Promise<void>((closed) => server.close(() => closed()));
    },
  };
}

function carriesSpan(body: Buffer, name: string): boolean {
  return body.includes(Buffer.from(name));
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
  ])(
    "suppresses an Egma %s simulation from the room name alone",
    (_modality, roomName) => {
      const warning = vi
        .spyOn(console, "warn")
        .mockImplementation(() => undefined);
      const ctx = context(roomName);
      const forbiddenSignal = () => {
        throw new Error("egma.monitor read a non-room simulation signal");
      };
      Object.defineProperty(ctx.job, "metadata", { get: forbiddenSignal });
      Object.defineProperty(ctx.job.room, "metadata", {
        get: forbiddenSignal,
      });
      Object.defineProperty(ctx, "simulationContext", {
        value: forbiddenSignal,
      });

      monitor(asJobContext(ctx));

      expect(ctx.callbacks).toHaveLength(0);
      expect(monitoringStateForTests()).toBeUndefined();
      expect(warning).toHaveBeenCalledWith(
        expect.stringContaining("not exported"),
      );
    },
  );
});

describe.runIf(SUPPORTS_SHARED_TELEMETRY)("egma.monitor", () => {
  it("ignores dispatch metadata and LiveKit's simulation context in a production room", () => {
    const { global } = unusedProviders();
    vi.spyOn(trace, "getTracerProvider").mockReturnValue(global);
    const ctx = context();
    const forbiddenSignal = () => {
      throw new Error("egma.monitor read a non-room simulation signal");
    };
    Object.defineProperty(ctx.job, "metadata", { get: forbiddenSignal });
    Object.defineProperty(ctx, "simulationContext", {
      value: forbiddenSignal,
    });

    monitor(asJobContext(ctx), {
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

    monitor(asJobContext(first));
    monitor(asJobContext(first));

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
    monitor(asJobContext(context(firstRoom)), {
      endpoint: "https://api.egma.ai",
      apiKey: PROJECT_KEY,
    });

    let message = "";
    try {
      monitor(asJobContext(context(secondRoom)), {
        endpoint: "https://api.egma.ai",
        apiKey: PROJECT_KEY,
      });
    } catch (error) {
      message = String(error);
    }

    expect(message).toContain("a different LiveKit job in this process");
    expect(message).toContain("one job per process");
    expect(message).toContain("Restart");
    expect(message).not.toContain(firstRoom);
    expect(message).not.toContain(secondRoom);
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

    monitor(asJobContext(context()), {
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
      monitor(asJobContext(context()), {
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
    monitor(asJobContext(context()), {
      endpoint: "https://api.egma.ai",
      apiKey: firstKey,
    });

    let message = "";
    try {
      monitor(asJobContext(context()), {
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

    monitor(asJobContext(context()), {
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

    monitor(asJobContext(context()), {
      endpoint: "https://api.egma.ai",
      apiKey: PROJECT_KEY,
    });
    const options = setTracerProvider.mock.calls.at(-1)?.[1];
    const createCloudSpanProcessor = options?.createCloudSpanProcessor;
    if (createCloudSpanProcessor === undefined) {
      throw new Error("egma.monitor did not provide a cloud processor factory");
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

describe.runIf(SUPPORTS_SHARED_TELEMETRY)(
  "simulation evidence delivery",
  () => {
    function installedCollector(
      endpoint: string,
    ): { readonly processor: ReturnType<typeof installExport>; readonly provider: NodeTracerProvider } {
      const { global } = unusedProviders();
      vi.spyOn(trace, "getTracerProvider").mockReturnValue(global);
      const ctx = context("egma-sim-chat-delivery");
      const processor = installExport(
        asJobContext(ctx),
        { endpoint, apiKey: PROJECT_KEY },
        "simulation",
        ctx.job.room.name,
      );
      const provider = monitoringStateForTests()?.provider as NodeTracerProvider | undefined;
      if (provider === undefined) throw new Error("simulation exporter was not installed");
      return { processor, provider };
    }

    it("keeps later children but withholds the root after a permanent refusal", async () => {
      const collector = await localCollector([400, 200]);
      const { processor, provider } = installedCollector(collector.endpoint);
      const tracer = provider.getTracer("delivery-proof");

      tracer.startSpan("function_tool").end();
      await expect(processor.forceFlush()).rejects.toThrow();

      expect(carriesSpan(collector.requests[0]!, "function_tool")).toBe(true);

      tracer.startSpan("agent_turn").end();
      tracer.startSpan("agent_session").end();
      await expect(processor.forceFlush()).rejects.toThrow();

      expect(carriesSpan(collector.requests[1]!, "agent_turn")).toBe(true);
      expect(carriesSpan(collector.requests[1]!, "agent_session")).toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(collector.requests).toHaveLength(2);

      await provider.shutdown().catch(() => undefined);
      await collector.close();
    });
  },
);

describe("configuration", () => {
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
