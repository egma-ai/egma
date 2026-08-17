import { WebSocket } from "ws";

import { startLocalGateway, type LocalGateway } from "../../src/host/node.ts";
import { makeLog } from "../../src/record.ts";
import type { Verifier } from "../../src/verify.ts";
import { startEgmaCloudDoor, type EgmaCloudDoor } from "./egma-cloud.ts";
import {
  CALLER_PROVIDER_KEY,
  EGMA_PROVIDER_KEY,
  GATEWAY_SECRET,
  INTERNAL_KEY,
  startHttpUpstream,
  startSocketUpstream,
  type HttpUpstream,
  type HttpUpstreamPlan,
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
  readonly openai?: HttpUpstreamPlan;
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

export type Standing = {
  readonly world: World;
  /** Where inference keys really live, as far as the gateway is concerned. */
  readonly cloud: EgmaCloudDoor;
  readonly openai: HttpUpstream;
  readonly deepgram: SocketUpstream;
  readonly cartesia: SocketUpstream;
};

export async function standUp(plan: WorldPlan = {}): Promise<Standing> {
  const openai = await startHttpUpstream(plan.openai ?? OPENAI_PLAN);
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
