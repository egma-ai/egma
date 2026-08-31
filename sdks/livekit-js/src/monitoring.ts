import { createHash, timingSafeEqual } from "node:crypto";

import {
  ProxyTracerProvider,
  trace,
  type Attributes,
  type TracerProvider,
} from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import {
  defaultResource,
  resourceFromAttributes,
} from "@opentelemetry/resources";
import {
  BatchSpanProcessor,
  NodeTracerProvider,
  type SpanExporter,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-node";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { telemetry, type JobContext } from "@livekit/agents";

const TRACE_PATH = "/v1/traces";
const SIMULATION_ROOM_PREFIX = "egma-sim-";
const PROJECT_KEY_PATTERN = /^egma_sk_[A-Za-z0-9_-]{43}$/u;
const UNCONFIGURED_TRACER_PROVIDER = new ProxyTracerProvider().getDelegate();

type CloudSpanProcessorOptions = {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly exporter?: SpanExporter;
};

type CreateCloudSpanProcessor = (
  options: CloudSpanProcessorOptions,
) => SpanProcessor;

type MutableFanoutSpanProcessor = SpanProcessor & {
  add(processor: SpanProcessor): void;
};

type SharedLiveKitTelemetry = {
  readonly FanoutSpanProcessor: new () => MutableFanoutSpanProcessor;
  readonly tracer: typeof telemetry.tracer & {
    getProvider(): TracerProvider;
  };
  readonly setTracerProvider: (
    provider: TracerProvider,
    options?: {
      readonly metadata?: Attributes;
      readonly registerSpanProcessor?: (processor: SpanProcessor) => void;
      readonly createCloudSpanProcessor?: CreateCloudSpanProcessor;
    },
  ) => void;
};

type MonitoringState = {
  readonly endpoint: string;
  readonly apiKeyDigest: Buffer;
  readonly roomName: string;
  readonly provider: TracerProvider;
  readonly processor: BatchSpanProcessor;
  readonly registerSpanProcessor: (processor: SpanProcessor) => void;
};

let state: MonitoringState | undefined;
let contextsWithFlush = new WeakSet<object>();

export type MonitorLiveKitOptions = {
  /** Egma API origin. Defaults to `EGMA_URL`. */
  readonly endpoint?: string;
  /** Egma project API key. Defaults to `EGMA_API_KEY`. */
  readonly apiKey?: string;
  /**
   * The mutable seam for a tracer provider that another integration already
   * installed. OpenTelemetry JS 2.x cannot add processors to a provider after
   * construction, so the provider must have been built around a fan-out
   * processor and this callback must add to that exact fan-out.
   */
  readonly existingTelemetry?: ExistingTelemetry;
};

export type ExistingTelemetry = {
  readonly provider: TracerProvider;
  readonly registerSpanProcessor: (processor: SpanProcessor) => void;
  readonly createCloudSpanProcessor?: CreateCloudSpanProcessor;
};

/**
 * Send this LiveKit worker's production spans to Egma.
 *
 * Call this as the first statement of the job entrypoint, before
 * `AgentSession.start`. Repeated calls for the same job reuse one process-wide
 * exporter. Each job gets one final flush callback.
 */
export function monitorLiveKit(
  ctx: JobContext,
  options: MonitorLiveKitOptions = {},
): void {
  const roomName = jobRoomName(ctx);
  if (roomName.startsWith(SIMULATION_ROOM_PREFIX)) {
    console.warn(
      `Egma: ${JSON.stringify(roomName)} is an Egma simulation room, so its spans are not exported to production Monitoring.`,
    );
    return;
  }

  const sharedTelemetry = sharedLiveKitTelemetry();
  if (sharedTelemetry === undefined) {
    throw new Error(
      "LiveKit production monitoring requires @livekit/agents>=1.5.5 <1.8 because older releases do not expose the shared telemetry seam Egma needs.",
    );
  }

  const addShutdownCallback = contextShutdownCallback(ctx);
  const endpoint = traceEndpoint(setting(options.endpoint, "EGMA_URL"));
  const apiKey = projectKey(setting(options.apiKey, "EGMA_API_KEY"));
  const apiKeyDigest = createHash("sha256").update(apiKey).digest();

  if (state === undefined) {
    state = configureMonitoring(
      endpoint,
      apiKey,
      apiKeyDigest,
      roomName,
      jobAgentName(ctx),
      sharedTelemetry,
      options.existingTelemetry,
    );
  } else if (
    state.endpoint !== endpoint ||
    !timingSafeEqual(state.apiKeyDigest, apiKeyDigest)
  ) {
    throw new Error(
      "LiveKit monitoring is already configured with different settings in this process. Restart the worker after changing EGMA_URL or EGMA_API_KEY.",
    );
  } else if (state.roomName !== roomName) {
    throw new Error(
      "LiveKit monitoring is already configured for a different job in this process. Restart the worker so each LiveKit job keeps its own trace metadata.",
    );
  } else if (
    options.existingTelemetry !== undefined &&
    state.provider !== options.existingTelemetry.provider
  ) {
    throw new Error(
      "LiveKit monitoring is already configured with a different OpenTelemetry tracer provider in this process. Restart the worker after changing tracing setup.",
    );
  }

  registerShutdownFlush(ctx, addShutdownCallback, state.processor);
}

function sharedLiveKitTelemetry(): SharedLiveKitTelemetry | undefined {
  const candidate = telemetry as unknown as {
    readonly FanoutSpanProcessor?: unknown;
    readonly setTracerProvider?: unknown;
    readonly tracer?: { readonly getProvider?: unknown };
  };
  if (
    typeof candidate.FanoutSpanProcessor !== "function" ||
    typeof candidate.setTracerProvider !== "function" ||
    typeof candidate.tracer?.getProvider !== "function"
  ) {
    return undefined;
  }
  return telemetry as unknown as SharedLiveKitTelemetry;
}

function jobRoomName(ctx: JobContext): string {
  const roomName = ctx?.job?.room?.name;
  if (typeof roomName !== "string") {
    throw new Error(
      "LiveKit monitoring setup needs the LiveKit JobContext passed to monitorLiveKit.",
    );
  }
  return roomName;
}

function contextShutdownCallback(
  ctx: JobContext,
): (callback: () => Promise<void>) => void {
  const callback = ctx?.addShutdownCallback;
  if (typeof callback !== "function") {
    throw new Error(
      "LiveKit monitoring setup needs the LiveKit JobContext passed to monitorLiveKit.",
    );
  }
  return callback.bind(ctx);
}

function jobAgentName(ctx: JobContext): string {
  const agentName = ctx?.job?.agentName;
  return typeof agentName === "string" ? agentName : "";
}

function setting(explicit: string | undefined, environmentName: string): string {
  const value = explicit ?? process.env[environmentName];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(
      `LiveKit monitoring setup needs ${environmentName}. Set it or pass the matching monitorLiveKit option.`,
    );
  }
  return value.trim();
}

export function projectKey(value: string): string {
  if (!PROJECT_KEY_PATTERN.test(value)) {
    throw new Error(
      "LiveKit monitoring setup received an invalid EGMA_API_KEY.",
    );
  }
  return value;
}

export function traceEndpoint(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw invalidEndpoint();
  }

  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.hostname === "" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    /\s/u.test(value)
  ) {
    throw invalidEndpoint();
  }

  const basePath = parsed.pathname.replace(/\/+$/u, "");
  parsed.pathname = basePath.endsWith(TRACE_PATH)
    ? basePath
    : `${basePath}${TRACE_PATH}`;
  return parsed.toString();
}

function invalidEndpoint(): Error {
  return new Error(
    "LiveKit monitoring setup needs EGMA_URL to be a valid HTTP or HTTPS API URL.",
  );
}

function configureMonitoring(
  endpoint: string,
  apiKey: string,
  apiKeyDigest: Buffer,
  roomName: string,
  agentName: string,
  sharedTelemetry: SharedLiveKitTelemetry,
  suppliedTelemetry: ExistingTelemetry | undefined,
): MonitoringState {
  const existingTelemetry = compatibleExistingTelemetry(
    sharedTelemetry.tracer.getProvider(),
    trace.getTracerProvider(),
    suppliedTelemetry,
  );

  let processor: BatchSpanProcessor | undefined;
  try {
    const exporter = new OTLPTraceExporter({
      url: endpoint,
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    processor = new BatchSpanProcessor(exporter);
    const ownedFanout = new sharedTelemetry.FanoutSpanProcessor();
    let provider: TracerProvider;
    let registerSpanProcessor: (added: SpanProcessor) => void;
    let createCloudSpanProcessor =
      existingTelemetry?.createCloudSpanProcessor;

    if (existingTelemetry === undefined) {
      const ownedProvider = new NodeTracerProvider({
        resource: defaultResource().merge(
          resourceFromAttributes({ [ATTR_SERVICE_NAME]: "livekit-agents" }),
        ),
        spanProcessors: [processor, ownedFanout],
      });
      ownedProvider.register();
      provider = ownedProvider;
      registerSpanProcessor = (added) => ownedFanout.add(added);
      createCloudSpanProcessor = ({ url, headers, exporter }) =>
        new BatchSpanProcessor(
          exporter ?? new OTLPTraceExporter({ url, headers }),
        );
    } else {
      provider = existingTelemetry.provider;
      registerSpanProcessor = existingTelemetry.registerSpanProcessor;
      registerSpanProcessor(processor);
    }
    sharedTelemetry.setTracerProvider(provider, {
      metadata: {
        "session.id": roomName,
        ...(agentName === ""
          ? {}
          : { [telemetry.traceTypes.ATTR_AGENT_NAME]: agentName }),
      },
      registerSpanProcessor,
      ...(createCloudSpanProcessor === undefined
        ? {}
        : {
            createCloudSpanProcessor,
          }),
    });

    return {
      endpoint,
      apiKeyDigest,
      roomName,
      provider,
      processor,
      registerSpanProcessor,
    };
  } catch {
    void processor?.shutdown().catch(() => undefined);
    throw new Error(
      "LiveKit monitoring could not configure the Egma exporter. Check EGMA_URL, EGMA_API_KEY, and the worker's OpenTelemetry setup.",
    );
  }
}

function compatibleExistingTelemetry(
  liveKitProvider: TracerProvider,
  globalProvider: TracerProvider,
  supplied: ExistingTelemetry | undefined,
): ExistingTelemetry | undefined {
  const configured = [liveKitProvider, globalProvider]
    .map(configuredProvider)
    .filter((provider): provider is TracerProvider => provider !== undefined);
  const distinct = [...new Set(configured)];

  if (distinct.length === 0) {
    if (supplied === undefined) return undefined;
    throw incompatibleProvider();
  }
  if (
    distinct.length > 1 ||
    supplied === undefined ||
    distinct[0] !== supplied.provider
  ) {
    throw incompatibleProvider();
  }
  return supplied;
}

function incompatibleProvider(): Error {
  return new Error(
    "LiveKit monitoring found an existing OpenTelemetry tracer provider that it cannot safely extend. Pass existingTelemetry with that provider and its span-processor registrar, or call monitorLiveKit before custom tracing setup.",
  );
}

function configuredProvider(
  provider: TracerProvider,
): TracerProvider | undefined {
  if (!(provider instanceof ProxyTracerProvider)) return provider;
  const delegate = provider.getDelegate();
  return delegate === UNCONFIGURED_TRACER_PROVIDER ? undefined : delegate;
}

function registerShutdownFlush(
  ctx: JobContext,
  addShutdownCallback: (callback: () => Promise<void>) => void,
  processor: BatchSpanProcessor,
): void {
  if (contextsWithFlush.has(ctx)) return;

  addShutdownCallback(async () => {
    try {
      await processor.forceFlush();
    } catch {
      console.warn(
        "Egma: LiveKit monitoring could not flush every buffered span before this job stopped.",
      );
    }
  });
  contextsWithFlush.add(ctx);
}

/** @internal Test-only access; not exported from the package root. */
export function monitoringStateForTests(): MonitoringState | undefined {
  return state;
}

/** @internal Test-only reset; not exported from the package root. */
export function resetMonitoringForTests(): void {
  state = undefined;
  contextsWithFlush = new WeakSet<object>();
}
