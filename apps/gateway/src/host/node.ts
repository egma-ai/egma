import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Duplex as NodeDuplex } from "node:stream";

import { WebSocket, WebSocketServer } from "ws";

import { type Environment, loadConfig } from "../config.ts";
import { type GatewayHost, handle } from "../gateway.ts";
import { makeLog } from "../record.ts";
import {
  type Duplex,
  type Frame,
  type SocketHost,
  UpstreamHandshakeRefused,
} from "../socket.ts";
import { deployedVerifier } from "../verify.ts";

/**
 * The local host: the same application, on a developer's machine.
 *
 * **What this is for, and what it is not.** It is how somebody runs the Egma
 * model gateway without a Cloudflare account — to read a log line, to point a
 * simulator at it, and to let the deterministic suite drive the real relay over
 * real sockets against strict local provider servers. It is not a supported
 * production deployment: Egma operates the gateway, the deployed host is the
 * Worker beside this file, and a customer-operated deployment is deliberately
 * out of scope.
 *
 * It is also the one file in `src/` allowed to import Node, which is why it is
 * the only one in this directory. Everything above it is web-platform code that
 * runs unchanged on both hosts.
 */

/** A `ws` socket, as the relay wants to see it. */
function asDuplex(socket: WebSocket): Duplex {
  return {
    send: (frame: Frame) => socket.send(frame),
    close: (code?: number, reason?: string) => socket.close(code, reason),
    onMessage: (handler) =>
      socket.on("message", (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
        const flat = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as Buffer);
        handler(
          isBinary
            ? flat.buffer.slice(flat.byteOffset, flat.byteOffset + flat.byteLength)
            : flat.toString("utf8"),
        );
      }),
    onClose: (handler) => socket.on("close", (code: number, reason: Buffer) => handler(code, reason.toString())),
    onError: (handler) => socket.on("error", (error: Error) => handler(error)),
    bufferedBytes: () => socket.bufferedAmount,
    // Real read flow control: pausing stops taking frames off the wire, the
    // peer's own socket fills, and the peer discovers it cannot write.
    pauseReading: () => socket.pause(),
    resumeReading: () => socket.resume(),
  };
}

/**
 * The request, as the web platform sees it.
 *
 * The body is a stream rather than a buffer, deliberately: this host must not
 * be the reason a request stops streaming, because then the suite would be
 * proving early streaming about a host that is not the deployed one.
 */
function asRequest(
  node: IncomingMessage,
  origin: string,
  abort: AbortController = new AbortController(),
): Request {
  const headers = new Headers();
  for (let index = 0; index < node.rawHeaders.length; index += 2) {
    const name = node.rawHeaders[index];
    const value = node.rawHeaders[index + 1];
    if (name !== undefined && value !== undefined) headers.append(name, value);
  }
  const hasBody = node.method !== "GET" && node.method !== "HEAD";
  node.on("aborted", () => abort.abort());
  node.on("close", () => {
    if (!node.readableEnded) abort.abort();
  });
  return new Request(new URL(node.url ?? "/", origin), {
    method: node.method ?? "GET",
    headers,
    ...(hasBody
      ? {
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              node.on("data", (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
              node.on("end", () => {
                try {
                  controller.close();
                } catch {
                  // Already closed by an abort; nothing to do.
                }
              });
              node.on("error", (error) => controller.error(error));
            },
          }),
          duplex: "half",
        }
      : {}),
    signal: abort.signal,
  } as RequestInit);
}

async function writeResponse(response: Response, node: ServerResponse): Promise<void> {
  const headers: Record<string, string | string[]> = {};
  for (const [name, value] of response.headers) headers[name] = value;
  node.writeHead(response.status, headers);
  if (response.body === null) {
    node.end();
    return;
  }
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      // Flushed per chunk, so that a token the provider sent is a token the
      // caller has. Node buffers otherwise and the whole early-streaming
      // property would be true of the relay and false of what a caller sees.
      node.write(value);
    }
    node.end();
  } catch {
    /**
     * The answer stopped part-way, and this must not look like it finished.
     *
     * Ending the response here writes the terminating chunk, and the caller's
     * client then reports a complete body that is missing its second half — a
     * truncated model answer delivered as a whole one, with a `200` on it.
     * Destroying the connection leaves the chunked stream unterminated, which
     * is what tells the caller the truth.
     */
    node.destroy();
  }
}

export type LocalGateway = {
  readonly origin: string;
  readonly port: number;
  stop(): Promise<void>;
};

export function startLocalGateway(
  environment: Environment,
  overrides: Partial<Pick<GatewayHost, "log" | "verifier">> = {},
): Promise<LocalGateway> {
  const config = loadConfig(environment);
  const log = overrides.log ?? makeLog(config.logLevel);
  const verifier = overrides.verifier ?? deployedVerifier(config);
  const port = Number(environment["EGMA_GATEWAY_PORT"] ?? 0);

  const origin = (): string => `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  /**
   * The raw sockets that were upgraded away from the HTTP server.
   *
   * Node's own `closeAllConnections` no longer knows about a connection once it
   * has been handed to an upgrade handler, so a stop that did not track these
   * would wait forever for a relayed socket to end on its own.
   */
  const upgraded = new Set<NodeDuplex>();

  const server: Server = createServer((node, out) => {
    // The caller hanging up mid-answer is the response ending before it was
    // written out. There is no request body left to notice it on — the caller
    // finished sending long ago — so this is what says they left.
    const gone = new AbortController();
    out.on("close", () => {
      if (!out.writableFinished) gone.abort();
    });
    const request = asRequest(node, origin(), gone);
    void handle(request, {
      config,
      verifier,
      log,
      socketHostFor: () => nodeSocketHost(undefined).host,
      waitUntil: (work) => void work.catch(() => undefined),
    })
      .then((response) => writeResponse(response, out))
      .catch(() => {
        if (!out.headersSent) out.writeHead(500, { "content-type": "application/json" });
        out.end(JSON.stringify({ error: { code: "gateway_fault", message: "the gateway failed" } }));
      });
  });

  server.on("upgrade", (node, socket, head) => {
    const raw = socket as NodeDuplex;
    upgraded.add(raw);
    /**
     * The caller's own socket going away is the caller going away.
     *
     * On an upgrade there is no request body whose end could say so, and the
     * relay needs to know during the provider's handshake — that is the one
     * window where nothing else is watching.
     *
     * **`end` and `error`, not only `close`.** A caller that walks away during
     * the handshake leaves this socket half-open: the peer's `FIN` arrives as
     * `end`, and `close` does not fire until this side is destroyed too — which
     * is exactly what nothing is going to do while the relay is still waiting
     * on a provider. Listening only for `close` therefore hears the caller
     * leave at the moment it has stopped mattering.
     */
    const gone = new AbortController();
    for (const said of ["end", "error", "close"] as const) {
      raw.on(said, () => {
        if (said === "close") upgraded.delete(raw);
        gone.abort();
      });
    }
    const made = nodeSocketHost({ node, socket: raw, head });
    void handle(asRequest(node, origin(), gone), {
      config,
      verifier,
      log,
      socketHostFor: () => made.host,
      waitUntil: (work) => void work.catch(() => undefined),
    })
      .then((response) => {
        // Whether the handshake happened is the host's own fact rather than
        // something read back out of a response: Node refuses to build a `101`
        // at all, so the relay's answer cannot carry that news the way it does
        // on Cloudflare. A refused upgrade is an ordinary HTTP answer written
        // onto the raw socket.
        if (made.accepted()) return;
        void refuseUpgrade(raw, response);
      })
      .catch(() => raw.destroy());
  });

  return new Promise<LocalGateway>((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const bound = server.address() as { port: number };
      resolve({
        origin: `http://127.0.0.1:${bound.port}`,
        port: bound.port,
        stop: () =>
          new Promise<void>((done) => {
            for (const raw of upgraded) raw.destroy();
            upgraded.clear();
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}

async function refuseUpgrade(socket: NodeDuplex, response: Response): Promise<void> {
  const body = await response.text();
  socket.write(
    `HTTP/1.1 ${response.status} ${response.statusText || "Refused"}\r\n` +
      `content-type: application/json; charset=utf-8\r\n` +
      `content-length: ${Buffer.byteLength(body)}\r\n` +
      `connection: close\r\n\r\n${body}`,
  );
  socket.end();
}

function nodeSocketHost(
  upgrade: { node: IncomingMessage; socket: NodeDuplex; head: Buffer } | undefined,
): { host: SocketHost; accepted: () => boolean } {
  let handshaken = false;
  const host: SocketHost = {
    async connectUpstream(url, headers, protocols) {
      const asked: Record<string, string> = {};
      for (const [name, value] of headers) {
        if (name.toLowerCase() === "sec-websocket-protocol") continue;
        asked[name] = value;
      }
      const socket = new WebSocket(url.toString().replace(/^http/, "ws"), [...protocols], {
        headers: asked,
      });
      return await new Promise((resolve, reject) => {
        const answered = new Headers();
        socket.on("upgrade", (message: IncomingMessage) => {
          for (const [name, value] of Object.entries(message.headers)) {
            if (typeof value === "string") answered.append(name, value);
          }
        });
        socket.on("unexpected-response", (_request, message: IncomingMessage) => {
          message.resume();
          reject(
            new UpstreamHandshakeRefused(
              message.statusCode ?? null,
              "the provider did not complete the handshake",
            ),
          );
        });
        socket.on("error", (error: Error) => reject(error));
        socket.on("open", () => {
          resolve({
            socket: asDuplex(socket),
            protocol: socket.protocol === "" ? null : socket.protocol,
            headers: answered,
          });
        });
      });
    },

    acceptClient(protocol) {
      if (upgrade === undefined) throw new Error("this request did not arrive as an upgrade");
      handshaken = true;
      const server = new WebSocketServer({
        noServer: true,
        // **Always supplied, including when the answer is "none".** Left out,
        // this library selects the caller's first requested subprotocol on its
        // own — which would hand the caller back a subprotocol the provider
        // never agreed to, out of a list this gateway deliberately did not
        // forward. `false` is its word for selecting none, and the deployed
        // host says the same thing by omitting the header.
        handleProtocols: () => protocol ?? false,
      });
      let accepted: WebSocket | undefined;
      const ready = new Promise<WebSocket>((resolve) => {
        server.handleUpgrade(upgrade.node, upgrade.socket, upgrade.head, (socket) => {
          accepted = socket;
          resolve(socket);
        });
      });

      /**
       * The relay wires its handlers straight away and `ws` completes the
       * handshake on a later tick, so what it is handed is a socket that queues
       * what it is asked to do until the real one exists. The queue is this
       * one turn of the loop long — it is not a buffer between the two ends of
       * the exchange, which never both exist before both are open.
       */
      const queued: (() => void)[] = [];
      const onceReady = (work: (socket: WebSocket) => void): void => {
        if (accepted !== undefined) {
          work(accepted);
          return;
        }
        queued.push(() => work(accepted as WebSocket));
      };
      void ready.then(() => {
        for (const work of queued.splice(0)) work();
      });

      return {
        socket: {
          send: (frame: Frame) => onceReady((socket) => socket.send(frame)),
          close: (code?: number, reason?: string) =>
            onceReady((socket) => socket.close(code, reason)),
          onMessage: (handler) => onceReady((socket) => asDuplex(socket).onMessage(handler)),
          onClose: (handler) => onceReady((socket) => asDuplex(socket).onClose(handler)),
          onError: (handler) => onceReady((socket) => asDuplex(socket).onError(handler)),
          // Nothing is buffered before the socket exists, because nothing has
          // been asked of it that this turn of the loop has not already run.
          bufferedBytes: () => accepted?.bufferedAmount ?? 0,
          pauseReading: () => onceReady((socket) => socket.pause()),
          resumeReading: () => onceReady((socket) => socket.resume()),
        },
        // Node cannot build a `101`, and nothing reads this one: the upgrade
        // handler above knows the handshake happened because it asked.
        response: new Response(null, { status: 200 }),
      };
    },
  };
  return { host, accepted: () => handshaken };
}

/** `node dist/host/node.js` — the documented way to run this locally. */
if (process.argv[1] !== undefined && process.argv[1].endsWith("node.js")) {
  startLocalGateway(process.env)
    .then((running) => {
      process.stdout.write(
        `${JSON.stringify({ message: "the Egma model gateway is listening", origin: running.origin })}\n`,
      );
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
