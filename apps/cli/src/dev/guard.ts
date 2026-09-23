/**
 * The guard in front of a bot's local starter during `egma agent dev`.
 *
 * It listens on 127.0.0.1 only; the tunnel is its one public door. A request
 * without the session's secret header is refused with 401. Every other request
 * is forwarded to the local port with the header removed: same method, path,
 * query, headers and body, and the starter's answer is streamed back as it
 * arrives.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

/** The header that carries the session's secret. */
export const DEV_SECRET_HEADER = "X-Egma-Dev-Secret";

const SECRET_HEADER_KEY = DEV_SECRET_HEADER.toLowerCase();

const REFUSAL_BODY = JSON.stringify({
  error: "egma agent dev refused a request without its secret header",
});

/** Headers that describe one connection, never the request itself. */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export type GuardEvent =
  | { readonly kind: "refused"; readonly method: string; readonly path: string }
  | {
      readonly kind: "forwarded";
      readonly method: string;
      readonly path: string;
      readonly status: number;
    }
  | {
      readonly kind: "unreachable";
      readonly method: string;
      readonly path: string;
      readonly cause: string;
    };

export type Guard = {
  /** The random local port the guard listens on. */
  readonly port: number;
  /** `http://127.0.0.1:<port>`, the address the tunnel points at. */
  readonly url: string;
  /** Stop listening and end every open connection. */
  close(): Promise<void>;
};

export type GuardOptions = {
  readonly secret: string;
  /** The bot starter's local port. */
  readonly targetPort: number;
  /** Told about every request, without its headers, query or body. */
  readonly onEvent?: (event: GuardEvent) => void;
};

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/** Compare digests so the time taken does not depend on where the texts differ. */
function holdsSecret(offered: string | string[] | undefined, expected: Buffer): boolean {
  if (typeof offered !== "string") return false;
  return timingSafeEqual(digest(offered), expected);
}

/** The path alone, so a query string never reaches the console. */
function pathOf(url: string | undefined): string {
  const raw = url ?? "/";
  const query = raw.indexOf("?");
  return query === -1 ? raw : raw.slice(0, query);
}

/** Raw header pairs, minus the secret, the hop-by-hop set, and what `Connection` names. */
function forwardedHeaders(rawHeaders: readonly string[], drop: ReadonlySet<string>): string[] {
  const named = new Set<string>();
  for (let at = 0; at + 1 < rawHeaders.length; at += 2) {
    if ((rawHeaders[at] as string).toLowerCase() === "connection") {
      for (const token of (rawHeaders[at + 1] as string).split(",")) {
        const name = token.trim().toLowerCase();
        if (name !== "") named.add(name);
      }
    }
  }
  const kept: string[] = [];
  for (let at = 0; at + 1 < rawHeaders.length; at += 2) {
    const name = rawHeaders[at] as string;
    const lower = name.toLowerCase();
    if (drop.has(lower) || HOP_BY_HOP.has(lower) || named.has(lower)) continue;
    kept.push(name, rawHeaders[at + 1] as string);
  }
  return kept;
}

function causeOf(error: NodeJS.ErrnoException): string {
  if (error.code === "ECONNREFUSED") return "nothing is listening there";
  if (error.code === "ECONNRESET") return "the starter closed the connection";
  return error.message;
}

function answerJson(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  response.end(body);
}

/** Start the guard on a random free port of 127.0.0.1. */
export async function startGuard(options: GuardOptions): Promise<Guard> {
  const expected = digest(options.secret);
  const dropFromRequest = new Set([SECRET_HEADER_KEY]);
  const tell = options.onEvent ?? (() => undefined);

  const forward = (incoming: IncomingMessage, outgoing: ServerResponse): void => {
    const method = incoming.method ?? "GET";
    const path = pathOf(incoming.url);
    const upstream = httpRequest({
      host: "127.0.0.1",
      port: options.targetPort,
      method,
      path: incoming.url ?? "/",
      headers: forwardedHeaders(incoming.rawHeaders, dropFromRequest),
    });

    upstream.on("response", (answer) => {
      const status = answer.statusCode ?? 502;
      outgoing.writeHead(
        status,
        answer.statusMessage,
        forwardedHeaders(answer.rawHeaders, new Set()),
      );
      answer.pipe(outgoing);
      answer.on("error", () => outgoing.destroy());
      tell({ kind: "forwarded", method, path, status });
    });

    upstream.on("error", (error: NodeJS.ErrnoException) => {
      incoming.unpipe(upstream);
      incoming.resume();
      // The caller is gone already; there is nobody to answer.
      if (outgoing.destroyed || outgoing.writableEnded) return;
      if (outgoing.headersSent) {
        outgoing.destroy(error);
        return;
      }
      const cause = causeOf(error);
      answerJson(
        outgoing,
        502,
        JSON.stringify({
          error: `egma agent dev could not reach your bot's starter on port ${String(options.targetPort)}: ${cause}`,
        }),
      );
      tell({ kind: "unreachable", method, path, cause });
    });

    // The caller went away before the answer finished: stop asking for it.
    outgoing.on("close", () => {
      if (!outgoing.writableFinished) upstream.destroy();
    });

    incoming.pipe(upstream);
  };

  const server = createServer((incoming, outgoing) => {
    const method = incoming.method ?? "GET";
    if (!holdsSecret(incoming.headers[SECRET_HEADER_KEY], expected)) {
      incoming.resume();
      answerJson(outgoing, 401, REFUSAL_BODY);
      tell({ kind: "refused", method, path: pathOf(incoming.url) });
      return;
    }
    forward(incoming, outgoing);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;

  let closing: Promise<void> | undefined;
  return {
    port,
    url: `http://127.0.0.1:${String(port)}`,
    close() {
      closing ??= new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      return closing;
    },
  };
}
