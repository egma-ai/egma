import { createHash, timingSafeEqual } from "node:crypto";

import {
  ProxyTracerProvider,
  trace,
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
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-node";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { telemetry, type JobContext } from "@livekit/agents";

const TRACE_PATH = "/v1/traces";
const SIMULATION_ROOM_PREFIX = "egma-sim-";
const PROJECT_KEY_PATTERN = /^egma_sk_[A-Za-z0-9_-]{43}$/u;
const UNCONFIGURED_TRACER_PROVIDER = new ProxyTracerProvider().getDelegate();

type MonitoringState = {
  readonly endpoint: string;
  readonly apiKeyDigest: Buffer;
  readonly roomName: string;
  readonly provider: NodeTracerProvider;
  readonly processor: BatchSpanProcessor;
  readonly liveKitFanout: telemetry.FanoutSpanProcessor;
};

let state: MonitoringState | undefined;
let contextsWithFlush = new WeakSet<object>();

export type MonitorLiveKitOptions = {
  /** Egma API origin. Defaults to `EGMA_URL`. */
  readonly endpoint?: string;
  /** Egma project API key. Defaults to `EGMA_API_KEY`. */
  readonly apiKey?: string;
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
  }

  registerShutdownFlush(ctx, addShutdownCallback, state.processor);
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
): MonitoringState {
  refuseExistingProvider(
    telemetry.tracer.getProvider(),
    trace.getTracerProvider(),
  );

  let processor: BatchSpanProcessor | undefined;
  try {
    const exporter = new OTLPTraceExporter({
      url: endpoint,
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    processor = new BatchSpanProcessor(exporter);
    const liveKitFanout = new telemetry.FanoutSpanProcessor();
    const provider = new NodeTracerProvider({
      resource: defaultResource().merge(
        resourceFromAttributes({ [ATTR_SERVICE_NAME]: "livekit-agents" }),
      ),
      spanProcessors: [processor, liveKitFanout],
    });

    provider.register();
    telemetry.setTracerProvider(provider, {
      metadata: {
        "session.id": roomName,
        ...(agentName === ""
          ? {}
          : { [telemetry.traceTypes.ATTR_AGENT_NAME]: agentName }),
      },
      registerSpanProcessor: (added: SpanProcessor) => {
        liveKitFanout.add(added);
      },
    });

    return {
      endpoint,
      apiKeyDigest,
      roomName,
      provider,
      processor,
      liveKitFanout,
    };
  } catch {
    void processor?.shutdown().catch(() => undefined);
    throw new Error(
      "LiveKit monitoring could not configure the Egma exporter. Check EGMA_URL, EGMA_API_KEY, and the worker's OpenTelemetry setup.",
    );
  }
}

function refuseExistingProvider(
  liveKitProvider: TracerProvider,
  globalProvider: TracerProvider,
): void {
  if (
    isUnconfiguredProxyProvider(liveKitProvider) &&
    isUnconfiguredProxyProvider(globalProvider)
  ) {
    return;
  }

  throw new Error(
    "LiveKit monitoring found an existing OpenTelemetry tracer provider that it cannot safely extend. Call monitorLiveKit before custom tracing setup so Egma and LiveKit Cloud can share one provider.",
  );
}

function isUnconfiguredProxyProvider(provider: TracerProvider): boolean {
  return (
    provider instanceof ProxyTracerProvider &&
    provider.getDelegate() === UNCONFIGURED_TRACER_PROVIDER
  );
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
