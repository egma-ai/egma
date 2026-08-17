import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";

import { WebSocketServer, type WebSocket } from "ws";

/**
 * Strict local servers standing where the providers stand.
 *
 * **Strict is the whole point.** A permissive stand-in would accept whatever
 * the gateway sent and prove nothing about what it sent; these refuse anything
 * that is not exactly the native request the real provider would demand — the
 * path, the method, the authorization the gateway is supposed to have injected
 * — and they keep what arrived, so a test can read it back and say what
 * crossed. The gateway is a black box to every test in this suite: nothing
 * reaches inside it, and everything asserted is either what a caller saw or
 * what a provider received.
 *
 * The sentinel values below are fake by construction. No test in this
 * repository ever holds a real provider key, and the scanning test proves that
 * the strings a real deployment would hold in these places never appear
 * anywhere a record, a log or a response can be read.
 */

/** What a provider is told to expect. Fake, and obviously fake on sight. */
export const EGMA_PROVIDER_KEY = {
  deepgram: "sentinel-egma-deepgram-key-Ku7Rb3",
  openai: "sentinel-egma-openai-key-Zq2Mv9",
  cartesia: "sentinel-egma-cartesia-key-Wp5Tj1",
} as const;

/** What a caller might send that must never reach a provider. */
export const CALLER_PROVIDER_KEY = "sentinel-caller-provider-key-Do-Not-Forward";

/**
 * One organization's inference key, as a test holds it — a real one, issued in
 * the Egma Cloud stand-in the gateway asks about it.
 */
export const GATEWAY_SECRET = "egma_ik_sentinel-inference-credential-Hs8Nc4";

/**
 * The key hosted Egma signs its own gateway credentials with, as this
 * deployment's secret store holds it. Never on a wire; only a signature made
 * with it is.
 */
export const INTERNAL_KEY = "sentinel-internal-gateway-signing-Yb4Fk8";

export type SeenHttp = {
  readonly method: string;
  readonly path: string;
  readonly query: URLSearchParams;
  readonly headers: Readonly<Record<string, string>>;
  /** When the first byte of the body arrived, relative to the request's start. */
  bodyFirstByteMs: number | undefined;
  bodyEndedMs: number | undefined;
  body: string;
};

export type HttpUpstream = {
  readonly origin: string;
  readonly seen: SeenHttp[];
  /** How many times anything at all connected. Proves there was no retry. */
  readonly attempts: () => number;
  stop(): Promise<void>;
};

export type HttpUpstreamPlan = {
  /** The one path this provider answers, exactly. */
  readonly path: string;
  readonly expectAuthorization: string;
  /**
   * What it answers with. `chunks` go out one at a time with `gapMs` between
   * them, which is what lets a test see that the caller had the first one long
   * before the last one existed.
   */
  readonly status?: number;
  readonly chunks?: readonly string[];
  readonly gapMs?: number;
  readonly headers?: Readonly<Record<string, string>>;
  /** Hold the answer back this long, to prove a bound is really finite. */
  readonly silentForMs?: number;
  /**
   * Break the connection after this many chunks have gone out, so the body
   * fails *after* its headers arrived.
   *
   * The failure a relay is most likely to get wrong: the status line said
   * `200`, the caller is already reading, and then the provider dies. There is
   * no status to report it with and no `flush` to notice it in.
   */
  readonly breakAfterChunks?: number;
};

export async function startHttpUpstream(plan: HttpUpstreamPlan): Promise<HttpUpstream> {
  const seen: SeenHttp[] = [];
  let attempts = 0;
  /** Deliberately delayed answers, so a stop does not wait one out. */
  const timers = new Set<ReturnType<typeof setTimeout>>();

  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    attempts += 1;
    const startedAt = Date.now();
    const url = new URL(request.url ?? "/", "http://upstream");
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(request.headers)) {
      if (typeof value === "string") headers[name] = value;
    }
    const record: SeenHttp = {
      method: request.method ?? "",
      path: url.pathname,
      query: url.searchParams,
      headers,
      bodyFirstByteMs: undefined,
      bodyEndedMs: undefined,
      body: "",
    };
    seen.push(record);

    request.on("data", (chunk: Buffer) => {
      record.bodyFirstByteMs ??= Date.now() - startedAt;
      record.body += chunk.toString("utf8");
    });

    request.on("end", () => {
      record.bodyEndedMs = Date.now() - startedAt;

      if (url.pathname !== plan.path) {
        response.writeHead(404).end("no such path here");
        return;
      }
      if (headers["authorization"] !== plan.expectAuthorization) {
        response.writeHead(401, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "this is not the authorization this provider takes" }));
        return;
      }

      const answer = (): void => {
        response.writeHead(plan.status ?? 200, {
          "content-type": "text/event-stream",
          "x-request-id": "upstream-request-id-1",
          ...(plan.headers ?? {}),
        });
        const chunks = plan.chunks ?? ["done"];
        let index = 0;
        const push = (): void => {
          if (plan.breakAfterChunks !== undefined && index >= plan.breakAfterChunks) {
            response.socket?.destroy();
            return;
          }
          if (index >= chunks.length) {
            response.end();
            return;
          }
          response.write(chunks[index]);
          index += 1;
          setTimeout(push, plan.gapMs ?? 0);
        };
        push();
      };

      if (plan.silentForMs !== undefined) timers.add(setTimeout(answer, plan.silentForMs));
      else answer();
    });
  });

  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    seen,
    attempts: () => attempts,
    stop: () =>
      new Promise<void>((done) => {
        for (const timer of timers) clearTimeout(timer);
        timers.clear();
        server.closeAllConnections();
        server.close(() => done());
      }),
  };
}

export type SeenSocket = {
  readonly path: string;
  readonly query: URLSearchParams;
  readonly headers: Readonly<Record<string, string>>;
  readonly protocols: readonly string[];
  readonly frames: (string | Buffer)[];
  closedWith: { code: number; reason: string } | undefined;
  /** The socket itself, so a test can make the provider do something. */
  socket: WebSocket | undefined;
};

export type SocketUpstream = {
  readonly origin: string;
  readonly seen: SeenSocket[];
  readonly attempts: () => number;
  /** Resolves once a connection has been accepted. */
  readonly opened: () => Promise<SeenSocket>;
  /**
   * Stop and start reading, so a test can be a peer that is not keeping up.
   *
   * A slow provider is not a rare thing to be — a socket whose consumer is
   * paused is what any overloaded far end looks like from here — and it is the
   * only way to ask what a relay does when one side outruns the other.
   */
  readonly stopReading: () => void;
  readonly startReading: () => void;
  stop(): Promise<void>;
};

export type SocketUpstreamPlan = {
  readonly path: string;
  /** Where this provider takes its own authorization, and what it must be. */
  readonly expect:
    | { readonly at: "header"; readonly name: string; readonly value: string }
    | { readonly at: "query"; readonly name: string; readonly value: string };
  /** Echo every frame back, so a test can watch order survive the crossing. */
  readonly echo?: boolean;
  /** Hold the handshake back this long, to prove a bound is really finite. */
  readonly silentForMs?: number;
  /** Refuse the handshake with this status, to prove a refusal is not retried. */
  readonly refuseWith?: number;
  /** Select this subprotocol when the caller offers it. */
  readonly selectProtocol?: string;
};

export async function startSocketUpstream(plan: SocketUpstreamPlan): Promise<SocketUpstream> {
  const seen: SeenSocket[] = [];
  let attempts = 0;
  let announce: (record: SeenSocket) => void = () => {};
  let firstOpen = new Promise<SeenSocket>((resolve) => {
    announce = resolve;
  });

  const sockets = new WebSocketServer({
    noServer: true,
    ...(plan.selectProtocol === undefined
      ? {}
      : {
          handleProtocols: (offered: Set<string>) =>
            offered.has(plan.selectProtocol as string) ? (plan.selectProtocol as string) : false,
        }),
  });

  const server: Server = createServer((_request, response) => {
    response.writeHead(426).end("this address is a websocket address");
  });

  /**
   * Raw sockets that were upgraded away from the HTTP server, and timers that
   * have not fired. Node's own connection tracking loses both, so a stop that
   * did not hold them would wait out a deliberately silent handshake.
   */
  const raw = new Set<Duplex>();
  const timers = new Set<ReturnType<typeof setTimeout>>();

  server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    attempts += 1;
    raw.add(socket);
    socket.on("close", () => raw.delete(socket));
    const url = new URL(request.url ?? "/", "http://upstream");
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(request.headers)) {
      if (typeof value === "string") headers[name] = value;
    }
    const protocols = (headers["sec-websocket-protocol"] ?? "")
      .split(",")
      .map((one) => one.trim())
      .filter((one) => one !== "");

    const refuse = (status: number, why: string): void => {
      socket.write(`HTTP/1.1 ${status} ${why}\r\nconnection: close\r\n\r\n`);
      socket.destroy();
    };

    if (plan.refuseWith !== undefined) {
      refuse(plan.refuseWith, "refused on purpose");
      return;
    }
    if (url.pathname !== plan.path) {
      refuse(404, "no such path here");
      return;
    }
    const offered =
      plan.expect.at === "header"
        ? (headers[plan.expect.name] ?? "")
        : (url.searchParams.get(plan.expect.name) ?? "");
    if (offered !== plan.expect.value) {
      refuse(401, "this is not the authorization this provider takes");
      return;
    }

    const record: SeenSocket = {
      path: url.pathname,
      query: url.searchParams,
      headers,
      protocols,
      frames: [],
      closedWith: undefined,
      socket: undefined,
    };

    const accept = (): void => {
      sockets.handleUpgrade(request, socket, head, (accepted: WebSocket) => {
        record.socket = accepted;
        seen.push(record);
        announce(record);
        accepted.on("message", (data: Buffer, isBinary: boolean) => {
          record.frames.push(isBinary ? Buffer.from(data) : data.toString("utf8"));
          if (plan.echo === true) accepted.send(data, { binary: isBinary });
        });
        accepted.on("close", (code: number, reason: Buffer) => {
          record.closedWith = { code, reason: reason.toString() };
        });
      });
    };

    if (plan.silentForMs !== undefined) timers.add(setTimeout(accept, plan.silentForMs));
    else accept();
  });

  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    seen,
    attempts: () => attempts,
    opened: () => firstOpen,
    stopReading: () => {
      for (const record of seen) record.socket?.pause();
    },
    startReading: () => {
      for (const record of seen) record.socket?.resume();
    },
    stop: () =>
      new Promise<void>((done) => {
        for (const timer of timers) clearTimeout(timer);
        timers.clear();
        for (const record of seen) record.socket?.terminate();
        for (const socket of raw) socket.destroy();
        raw.clear();
        server.closeAllConnections();
        server.close(() => done());
        firstOpen = new Promise<SeenSocket>((resolve) => {
          announce = resolve;
        });
      }),
  };
}
