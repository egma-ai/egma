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

/**
 * The one Egma exporter in this process, shared by both verbs.
 *
 * `monitor` and `simulation` send the same thing to the same door: this
 * worker's OpenTelemetry spans, over OTLP, with the project API key on them.
 * They differ in one fact — a simulation stamps the room it runs in on every
 * span, so Egma can file the agent's POV under the simulation that room
 * belongs to.
 *
 * **Why the room name rides two ways at once.** A resource is fixed when a
 * tracer provider is built, and this SDK does not always build one: a worker
 * that already has OpenTelemetry set up hands it a provider that exists, and
 * that provider must keep working. So the room name goes on twice — as a
 * resource attribute where this SDK builds the provider, and as a span
 * attribute on every span through LiveKit's own `setTracerProvider` metadata
 * seam, which works on any provider whoever built it. Egma's door reads the
 * resource first and falls back to the spans when every span in a resource
 * agrees.
 *
 * **One job per process.** The room this process exports under is decided by
 * the first job that asks, because a resource cannot be rewritten and the
 * metadata processor goes on once. LiveKit runs one job per process, and a
 * second job asking for different settings is refused here rather than filed
 * under the first job's name.
 */

const TRACE_PATH = "/v1/traces";
const PROJECT_KEY_PATTERN = /^egma_sk_[A-Za-z0-9_-]{43}$/u;
const UNCONFIGURED_TRACER_PROVIDER = new ProxyTracerProvider().getDelegate();

/**
 * What Egma files a simulation's agent POV under: the room's name.
 *
 * Egma's own attribute, in Egma's own namespace, so it can never collide with
 * a semantic convention or a framework's own key. A resource without it is
 * production traffic and takes the path it always took.
 */
export const PROVIDER_REFERENCE = "egma.provider_reference";

/**
 * How long a simulation's spans may sit in the buffer: one second.
 *
 * Short because somebody is waiting. A simulation is graded the moment the
 * agent's POV is complete, so the tail of the conversation has to land within
 * a second or two of the persona leaving. Production is not waited on the same
 * way and keeps the library's own default.
 */
export const SIMULATION_BATCH_MILLIS = 1_000;

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

export type ExportState = {
  readonly verb: string;
  readonly endpoint: string;
  readonly apiKeyDigest: Buffer;
  readonly roomName: string;
  readonly providerReference: string;
  readonly provider: TracerProvider;
  readonly processor: BatchSpanProcessor;
  readonly registerSpanProcessor: (processor: SpanProcessor) => void;
};

let state: ExportState | undefined;
let contextsWithFlush = new WeakSet<object>();

/**
 * The mutable seam for a tracer provider that another integration already
 * installed. OpenTelemetry JS 2.x cannot add processors to a provider after
 * construction, so the provider must have been built around a fan-out
 * processor and this callback must add to that exact fan-out.
 */
export type ExistingTelemetry = {
  readonly provider: TracerProvider;
  readonly registerSpanProcessor: (processor: SpanProcessor) => void;
  readonly createCloudSpanProcessor?: CreateCloudSpanProcessor;
};

export type ExportOptions = {
  /** Egma API origin. Defaults to `EGMA_URL`. */
  readonly endpoint?: string;
  /** Egma project API key. Defaults to `EGMA_API_KEY`. */
  readonly apiKey?: string;
  readonly existingTelemetry?: ExistingTelemetry;
};

/**
 * Export this worker's spans to Egma, once per process.
 *
 * `providerReference` is the room a simulation runs in, or `""` for
 * production. Returns the processor, so a caller with a second moment worth
 * flushing at — a session closing — can ask for one.
 */
export function installExport(
  ctx: JobContext,
  options: ExportOptions,
  verb: string,
  providerReference: string,
): BatchSpanProcessor {
  const roomName = jobRoomName(ctx, verb);
  const sharedTelemetry = sharedLiveKitTelemetry();
  if (sharedTelemetry === undefined) {
    throw new Error(
      `${verb} requires a supported @livekit/agents version (>=1.5.5 <2) that exposes the shared telemetry seam Egma needs.`,
    );
  }

  const addShutdownCallback = contextShutdownCallback(ctx, verb);
  const endpoint = traceEndpoint(setting(options.endpoint, "EGMA_URL", verb), verb);
  const apiKey = projectKey(setting(options.apiKey, "EGMA_API_KEY", verb), verb);
  const apiKeyDigest = createHash("sha256").update(apiKey).digest();

  if (state === undefined) {
    state = configureExport(
      endpoint,
      apiKey,
      apiKeyDigest,
      roomName,
      providerReference,
      jobAgentName(ctx),
      verb,
      sharedTelemetry,
      options.existingTelemetry,
    );
  } else if (
    state.endpoint !== endpoint ||
    !timingSafeEqual(state.apiKeyDigest, apiKeyDigest)
  ) {
    throw new Error(
      `${verb} is already configured with different settings in this process. Restart the worker after changing EGMA_URL or EGMA_API_KEY.`,
    );
  } else if (state.roomName !== roomName || state.verb !== verb) {
    // Neither room is quoted. A provider's resource is fixed when it is
    // built, so what a reader has to act on is the arrangement rather than
    // which two rooms collided, and an error that names a customer's rooms
    // is one more place they can travel to.
    throw new Error(
      `${verb} is already configured for a different LiveKit job in this process. Restart the worker so each LiveKit job keeps its own room and its own trace metadata: a provider's resource is fixed when it is built, so LiveKit must run one job per process.`,
    );
  } else if (
    options.existingTelemetry !== undefined &&
    state.provider !== options.existingTelemetry.provider
  ) {
    throw new Error(
      `${verb} is already configured with a different OpenTelemetry tracer provider in this process. Restart the worker after changing tracing setup.`,
    );
  }

  registerShutdownFlush(ctx, addShutdownCallback, state.processor);
  return state.processor;
}

/** Send whatever is buffered now, and never let the failure stop the job. */
export async function flushNow(
  processor: BatchSpanProcessor,
  why: string,
): Promise<void> {
  try {
    await processor.forceFlush();
  } catch {
    console.warn(
      `Egma: could not flush every buffered span at ${why}.`,
    );
  }
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

function jobRoomName(ctx: JobContext, verb: string): string {
  const roomName = ctx?.job?.room?.name;
  if (typeof roomName !== "string") {
    throw new Error(
      `${verb} needs the LiveKit JobContext this job was given.`,
    );
  }
  return roomName;
}

function contextShutdownCallback(
  ctx: JobContext,
  verb: string,
): (callback: () => Promise<void>) => void {
  const callback = ctx?.addShutdownCallback;
  if (typeof callback !== "function") {
    throw new Error(
      `${verb} needs the LiveKit JobContext this job was given.`,
    );
  }
  return callback.bind(ctx);
}

function jobAgentName(ctx: JobContext): string {
  const agentName = ctx?.job?.agentName;
  return typeof agentName === "string" ? agentName : "";
}

function setting(
  explicit: string | undefined,
  environmentName: string,
  verb: string,
): string {
  const value = explicit ?? process.env[environmentName];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(
      `${verb} needs ${environmentName}. Set it or pass the matching option.`,
    );
  }
  return value.trim();
}

export function projectKey(value: string, verb = "Egma"): string {
  if (!PROJECT_KEY_PATTERN.test(value)) {
    throw new Error(`${verb} received an invalid EGMA_API_KEY.`);
  }
  return value;
}

export function traceEndpoint(value: string, verb = "Egma"): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw invalidEndpoint(verb);
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
    throw invalidEndpoint(verb);
  }

  const basePath = parsed.pathname.replace(/\/+$/u, "");
  parsed.pathname = basePath.endsWith(TRACE_PATH)
    ? basePath
    : `${basePath}${TRACE_PATH}`;
  return parsed.toString();
}

function invalidEndpoint(verb: string): Error {
  return new Error(
    `${verb} needs EGMA_URL to be a valid HTTP or HTTPS API URL.`,
  );
}

function configureExport(
  endpoint: string,
  apiKey: string,
  apiKeyDigest: Buffer,
  roomName: string,
  providerReference: string,
  agentName: string,
  verb: string,
  sharedTelemetry: SharedLiveKitTelemetry,
  suppliedTelemetry: ExistingTelemetry | undefined,
): ExportState {
  const existingTelemetry = compatibleExistingTelemetry(
    sharedTelemetry.tracer.getProvider(),
    trace.getTracerProvider(),
    suppliedTelemetry,
    verb,
  );

  let processor: BatchSpanProcessor | undefined;
  try {
    const exporter = new OTLPTraceExporter({
      url: endpoint,
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    processor =
      providerReference === ""
        ? new BatchSpanProcessor(exporter)
        : new BatchSpanProcessor(exporter, {
            scheduledDelayMillis: SIMULATION_BATCH_MILLIS,
          });
    const ownedFanout = new sharedTelemetry.FanoutSpanProcessor();
    let provider: TracerProvider;
    let registerSpanProcessor: (added: SpanProcessor) => void;
    let createCloudSpanProcessor =
      existingTelemetry?.createCloudSpanProcessor;

    if (existingTelemetry === undefined) {
      const ownedProvider = new NodeTracerProvider({
        resource: defaultResource().merge(
          resourceFromAttributes({
            [ATTR_SERVICE_NAME]: "livekit-agents",
            // A resource this SDK builds can carry the reference, and that
            // is the copy Egma's door reads first.
            ...(providerReference === ""
              ? {}
              : { [PROVIDER_REFERENCE]: providerReference }),
          }),
        ),
        spanProcessors: [processor, ownedFanout],
      });
      ownedProvider.register();
      provider = ownedProvider;
      registerSpanProcessor = (added) => ownedFanout.add(added);
      createCloudSpanProcessor = ({ url, headers, exporter: supplied }) =>
        new BatchSpanProcessor(
          supplied ?? new OTLPTraceExporter({ url, headers }),
        );
    } else {
      provider = existingTelemetry.provider;
      registerSpanProcessor = existingTelemetry.registerSpanProcessor;
      registerSpanProcessor(processor);
    }
    sharedTelemetry.setTracerProvider(provider, {
      metadata: {
        "session.id": roomName,
        // The copy that works whoever built the provider: LiveKit stamps
        // this on every span it starts.
        ...(providerReference === ""
          ? {}
          : { [PROVIDER_REFERENCE]: providerReference }),
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
      verb,
      endpoint,
      apiKeyDigest,
      roomName,
      providerReference,
      provider,
      processor,
      registerSpanProcessor,
    };
  } catch {
    void processor?.shutdown().catch(() => undefined);
    throw new Error(
      `${verb} could not configure the Egma exporter. Check EGMA_URL, EGMA_API_KEY, and the worker's OpenTelemetry setup.`,
    );
  }
}

function compatibleExistingTelemetry(
  liveKitProvider: TracerProvider,
  globalProvider: TracerProvider,
  supplied: ExistingTelemetry | undefined,
  verb: string,
): ExistingTelemetry | undefined {
  const configured = [liveKitProvider, globalProvider]
    .map(configuredProvider)
    .filter((provider): provider is TracerProvider => provider !== undefined);
  const distinct = [...new Set(configured)];

  if (distinct.length === 0) {
    if (supplied === undefined) return undefined;
    throw incompatibleProvider(verb);
  }
  if (
    distinct.length > 1 ||
    supplied === undefined ||
    distinct[0] !== supplied.provider
  ) {
    throw incompatibleProvider(verb);
  }
  return supplied;
}

function incompatibleProvider(verb: string): Error {
  return new Error(
    `${verb} found an existing OpenTelemetry tracer provider that it cannot safely extend. Pass existingTelemetry with that provider and its span-processor registrar, or call ${verb} before custom tracing setup.`,
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
    await flushNow(processor, "job shutdown");
  });
  contextsWithFlush.add(ctx);
}

/** @internal Test-only access; not exported from the package root. */
export function exportStateForTests(): ExportState | undefined {
  return state;
}

/** @internal Test-only reset; not exported from the package root. */
export function resetExportForTests(): void {
  state = undefined;
  contextsWithFlush = new WeakSet<object>();
}
