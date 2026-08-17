import { WebSocket } from "ws";

import { startLocalGateway, type LocalGateway } from "../../src/host/node.ts";
import type { Route } from "../../src/routes.ts";
import { makeLog } from "../../src/record.ts";
import type { Verifier } from "../../src/verify.ts";
import { startEgmaCloudDoor, type EgmaCloudDoor } from "./egma-cloud.ts";
import {
  CALLER_PROVIDER_KEY,
  EGMA_PROVIDER_KEY,
  GATEWAY_SECRET,
  INTERNAL_KEY,
  startProviderUpstream,
  startSocketUpstream,
  type HttpUpstreamPlan,
  type ProviderUpstream,
  type SocketUpstream,
  type SocketUpstreamPlan,
} from "./upstreams.ts";

export { CALLER_PROVIDER_KEY, EGMA_PROVIDER_KEY, GATEWAY_SECRET, INTERNAL_KEY };

/**
 * One gateway, its providers, and everything that was written down.
 *
 * A world is built per test file rather than per test, and each test names the
 * upstream behavior it needs — a provider that streams slowly, one that refuses
 * a handshake, one that never answers. Nothing here reaches inside the gateway:
 * the tests drive it over real HTTP and real WebSockets and read the strict
 * servers on the other side, which is the same seam a simulator uses.
 */

export const ORGANIZATION = "org_01K3XQ7M4E8YB2FVN0H9TZQWER";
export const INFERENCE_KEY_ID = "ifk_01K3XQ7M4E8YB2FVN0H9TZQWES";

export type World = {
  readonly origin: string;
  /** Every line the gateway wrote, parsed. */
  readonly lines: Record<string, unknown>[];
  /** Every line the gateway wrote, as text — what a scan reads. */
  readonly raw: string[];
  stop(): Promise<void>;
};

export type WorldPlan = {
  /**
   * OpenAI's chat completions, which is the plan almost every test means when
   * it says "openai" — the one HTTP row that existed before this provider had
   * three of them.
   */
  readonly openai?: HttpUpstreamPlan;
  /** OpenAI's speech synthesis, on the same address. */
  readonly openaiSpeech?: HttpUpstreamPlan;
  /** OpenAI's realtime transcription socket, on the same address. */
  readonly openaiRealtime?: SocketUpstreamPlan;
  readonly deepgram?: SocketUpstreamPlan;
  readonly cartesia?: SocketUpstreamPlan;
  readonly settings?: Readonly<Record<string, string>>;
  /**
   * A verifier of the test's own, for the few cases that are about the seam
   * rather than about either shipped answer. Everything else runs the real
   * one — hosted Egma's signature, and an inference key asked about at the
   * Egma Cloud stand-in over a real socket.
   */
  readonly verifier?: Verifier;
};

export const DEEPGRAM_PLAN: SocketUpstreamPlan = {
  path: "/v1/listen",
  expect: { at: "header", name: "authorization", value: `Token ${EGMA_PROVIDER_KEY.deepgram}` },
  echo: true,
};

export const CARTESIA_PLAN: SocketUpstreamPlan = {
  path: "/tts/websocket",
  expect: { at: "query", name: "api_key", value: EGMA_PROVIDER_KEY.cartesia },
  echo: true,
};

export const OPENAI_PLAN: HttpUpstreamPlan = {
  path: "/v1/chat/completions",
  expectAuthorization: `Bearer ${EGMA_PROVIDER_KEY.openai}`,
  chunks: ['data: {"choices":[{"delta":{"content":"hello"}}]}\n\n', "data: [DONE]\n\n"],
};

/**
 * OpenAI's speech synthesis, which answers raw PCM in pieces.
 *
 * Two chunks with a gap, like the completion above and for the same reason: a
 * speaking leg must have the first audio long before the last of it exists, and
 * one chunk would prove nothing about when it arrived.
 */
export const OPENAI_SPEECH_PLAN: HttpUpstreamPlan = {
  path: "/v1/audio/speech",
  expectAuthorization: `Bearer ${EGMA_PROVIDER_KEY.openai}`,
  chunks: ["first-pcm-frame", "second-pcm-frame"],
  headers: { "content-type": "audio/pcm" },
};

/** OpenAI's realtime transcription socket, on OpenAI's own address. */
export const OPENAI_REALTIME_PLAN: SocketUpstreamPlan = {
  path: "/v1/realtime",
  expect: {
    at: "header",
    name: "authorization",
    value: `Bearer ${EGMA_PROVIDER_KEY.openai}`,
  },
  echo: true,
};

export type Standing = {
  readonly world: World;
  /** Where inference keys really live, as far as the gateway is concerned. */
  readonly cloud: EgmaCloudDoor;
  /**
   * OpenAI: three routes on one address, because that is how the provider is
   * really arranged. `seen` and `attempts` are its HTTP side; `sockets`,
   * `socketAttempts` and `opened` are its realtime transcription socket.
   */
  readonly openai: ProviderUpstream;
  readonly deepgram: SocketUpstream;
  readonly cartesia: SocketUpstream;
};

export async function standUp(plan: WorldPlan = {}): Promise<Standing> {
  const openai = await startProviderUpstream({
    http: [plan.openai ?? OPENAI_PLAN, plan.openaiSpeech ?? OPENAI_SPEECH_PLAN],
    socket: plan.openaiRealtime ?? OPENAI_REALTIME_PLAN,
  });
  const deepgram = await startSocketUpstream(plan.deepgram ?? DEEPGRAM_PLAN);
  const cartesia = await startSocketUpstream(plan.cartesia ?? CARTESIA_PLAN);
  const cloud = await startEgmaCloudDoor();
  cloud.issue(GATEWAY_SECRET, ORGANIZATION, INFERENCE_KEY_ID);

  const raw: string[] = [];
  const lines: Record<string, unknown>[] = [];
  const log = makeLog("DEBUG", (line) => {
    raw.push(line);
    lines.push(JSON.parse(line) as Record<string, unknown>);
  });

  let gateway: LocalGateway;
  try {
    gateway = await startLocalGateway(
      {
        EGMA_GATEWAY_INTERNAL_KEY: INTERNAL_KEY,
        EGMA_GATEWAY_VALIDATION_URL: cloud.validationUrl,
        EGMA_GATEWAY_DEEPGRAM_KEY: EGMA_PROVIDER_KEY.deepgram,
        EGMA_GATEWAY_OPENAI_KEY: EGMA_PROVIDER_KEY.openai,
        EGMA_GATEWAY_CARTESIA_KEY: EGMA_PROVIDER_KEY.cartesia,
        EGMA_GATEWAY_DEEPGRAM_HOME: deepgram.origin,
        EGMA_GATEWAY_OPENAI_HOME: openai.origin,
        EGMA_GATEWAY_CARTESIA_HOME: cartesia.origin,
        ...(plan.settings ?? {}),
      },
      { log, ...(plan.verifier === undefined ? {} : { verifier: plan.verifier }) },
    );
  } catch (fault) {
    await Promise.all([openai.stop(), deepgram.stop(), cartesia.stop(), cloud.stop()]);
    throw fault;
  }

  return {
    world: {
      origin: gateway.origin,
      lines,
      raw,
      stop: async () => {
        await gateway.stop();
        await Promise.all([
          openai.stop(),
          deepgram.stop(),
          cartesia.stop(),
          cloud.stop(),
        ]);
      },
    },
    cloud,
    openai,
    deepgram,
    cartesia,
  };
}

/** The records the gateway wrote, in order. */
export function records(world: World): Record<string, unknown>[] {
  return world.lines.filter((line) => line["message"] === "relayed");
}

/** Wait for something that has to become true, without a fixed sleep. */
export async function eventually<T>(
  read: () => T | undefined,
  within = 5_000,
): Promise<T> {
  const until = Date.now() + within;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > until) throw new Error("it never happened");
    await new Promise((wait) => setTimeout(wait, 10));
  }
}

/** Open a relayed socket the way a provider adapter would. */
export function openSocket(
  world: World,
  path: string,
  options: {
    readonly headers?: Record<string, string>;
    readonly protocols?: string[];
  } = {},
): WebSocket {
  return new WebSocket(
    `${world.origin.replace(/^http/, "ws")}${path}`,
    options.protocols ?? [],
    { headers: options.headers ?? {} },
  );
}

/** What a socket did: the frames it received, and how it was closed. */
export type SocketWatch = {
  readonly frames: (string | Buffer)[];
  closed: { code: number; reason: string } | undefined;
  failed: unknown;
  readonly opened: Promise<void>;
};

export function watch(socket: WebSocket): SocketWatch {
  const frames: (string | Buffer)[] = [];
  const state: SocketWatch = {
    frames,
    closed: undefined,
    failed: undefined,
    opened: new Promise<void>((resolve, reject) => {
      socket.on("open", () => resolve());
      socket.on("error", (error) => reject(error));
    }),
  };
  socket.on("message", (data: Buffer, isBinary: boolean) => {
    frames.push(isBinary ? Buffer.from(data) : data.toString("utf8"));
  });
  socket.on("close", (code: number, reason: Buffer) => {
    state.closed = { code, reason: reason.toString() };
  });
  socket.on("error", (error) => {
    state.failed = error;
  });
  return state;
}

/**
 * What one route's provider saw, whichever provider and transport that is.
 *
 * **The seam that makes a table-driven suite possible.** Every route has a
 * strict stand-in behind it, but they are not the same object: two are
 * socket-only, one provider carries both transports, and each keeps its own
 * record of what arrived. A test that wants to say "every shipped route
 * reaches its provider's own path" has to be able to ask that question once
 * rather than five times, so this is where the shapes are made one shape.
 */
export type ProviderView = {
  /** How many times this route's provider was reached on this transport. */
  readonly attempts: () => number;
  /** What arrived last, or `undefined` where nothing has. */
  readonly last: () => Seen | undefined;
};

export type Seen = {
  readonly path: string;
  readonly query: URLSearchParams;
  readonly headers: Readonly<Record<string, string>>;
};

export function providerOf(standing: Standing, route: Route): ProviderView {
  if (route.transport === "socket") {
    const upstream =
      route.provider === "deepgram"
        ? standing.deepgram
        : route.provider === "cartesia"
          ? standing.cartesia
          : undefined;
    if (upstream !== undefined) {
      return { attempts: upstream.attempts, last: () => upstream.seen.at(-1) };
    }
    return {
      attempts: standing.openai.socketAttempts,
      last: () => standing.openai.sockets.at(-1),
    };
  }
  return { attempts: standing.openai.attempts, last: () => standing.openai.seen.at(-1) };
}

/**
 * Open one shipped route the way the provider's own adapter would, and settle
 * once the provider has answered.
 *
 * A socket route is opened and closed politely; an HTTP route is asked with the
 * one method it carries and its answer is drained. Nothing here knows which
 * provider it is talking to — that is the point.
 */
export async function reach(
  standing: Standing,
  route: Route,
  options: { readonly headers?: Record<string, string>; readonly query?: string } = {},
): Promise<void> {
  const headers = options.headers ?? { "egma-inference-key": GATEWAY_SECRET };
  const query = options.query ?? "";
  if (route.transport === "socket") {
    const socket = openSocket(standing.world, `${route.path}${query}`, { headers });
    const watching = watch(socket);
    await watching.opened;
    socket.close(1000, "done");
    await eventually(() => (watching.closed === undefined ? undefined : true));
    return;
  }
  const answered = await fetch(`${standing.world.origin}${route.path}${query}`, {
    method: route.method,
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ model: "a-small-model", input: "two words" }),
  });
  await answered.text();
}

/**
 * A world in which one route's provider behaves as a test needs it to.
 *
 * **Written from the route rather than from a remembered slot name**, so a
 * table-driven test can ask every HTTP row the same question without knowing
 * which provider is behind it or what its stand-in is called here.
 */
export function withUpstream(
  route: Route,
  behaviour: Omit<HttpUpstreamPlan, "path" | "expectAuthorization">,
): WorldPlan {
  if (route.provider !== "openai" || route.transport !== "http") {
    throw new Error(
      `this world stands one HTTP provider up, and ${route.provider}/${route.job} is not it; give the route its own stand-in before driving it here`,
    );
  }
  const plan: HttpUpstreamPlan = {
    path: route.upstreamPath,
    expectAuthorization: `Bearer ${EGMA_PROVIDER_KEY.openai}`,
    ...behaviour,
  };
  return route.job === "llm" ? { openai: plan } : { openaiSpeech: plan };
}

/** The same, for a socket row: which stand-in it is, and how it behaves. */
export function withSocketUpstream(
  route: Route,
  behaviour: Omit<SocketUpstreamPlan, "path" | "expect">,
): WorldPlan {
  const expect: SocketUpstreamPlan["expect"] =
    route.credential.at === "header"
      ? {
          at: "header",
          name: route.credential.name,
          value: `${route.credential.scheme} ${EGMA_PROVIDER_KEY[route.provider]}`,
        }
      : { at: "query", name: route.credential.name, value: EGMA_PROVIDER_KEY[route.provider] };
  const plan: SocketUpstreamPlan = { path: route.upstreamPath, expect, ...behaviour };
  return route.provider === "deepgram"
    ? { deepgram: plan }
    : route.provider === "cartesia"
      ? { cartesia: plan }
      : { openaiRealtime: plan };
}

/** Which stand-in carries one socket route, so a test can read what it saw. */
export function socketUpstreamOf(standing: Standing, route: Route): SocketUpstream {
  if (route.provider === "deepgram") return standing.deepgram;
  if (route.provider === "cartesia") return standing.cartesia;
  return {
    origin: standing.openai.origin,
    seen: standing.openai.sockets,
    attempts: standing.openai.socketAttempts,
    opened: standing.openai.opened,
    stopReading: standing.openai.stopReading,
    startReading: standing.openai.startReading,
    stop: standing.openai.stop,
  };
}
