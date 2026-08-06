/**
 * The fixture platform: egma's public HTTP API, faked, for tests to run against.
 *
 * The CLI speaks the public API and nothing else. That is the seam this stands
 * in at — so the whole of a flow runs in CI with no database, no browser and no
 * platform, and the same CLI binary runs unchanged against a real instance.
 *
 * It is built as a list of route groups because it is going to grow: login is
 * the first group, and agents, connections and tests are groups beside it. Each
 * group owns its own state and its own controls, and the server here owns only
 * the plumbing — matching a request, reading a body, and recording what was
 * asked.
 *
 * Every request is recorded in order. The records are what a test asserts on
 * when it wants to know what the CLI actually said, rather than inferring it
 * from what came back.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export type FixtureRequest = {
  readonly method: string;
  readonly url: URL;
  readonly headers: Record<string, string | undefined>;
  /** The body, when it arrived as JSON. */
  readonly body: Record<string, unknown> | null;
  /** The body, when it arrived form-encoded, as RFC 8628's token call does. */
  readonly form: URLSearchParams | null;
};

export type FixtureAnswer = {
  readonly status: number;
  readonly body?: unknown;
  readonly text?: string;
  readonly contentType?: string;
};

export type Route = {
  readonly method: string;
  readonly path: string;
  handle(request: FixtureRequest): FixtureAnswer;
};

export type RouteGroup = {
  readonly name: string;
  readonly routes: readonly Route[];
};

/** One request, as the fixture saw it. */
export type Observation = {
  readonly seq: number;
  readonly method: string;
  readonly path: string;
  readonly status: number;
};

export type FixturePlatform = {
  /** The address the CLI is pointed at. */
  readonly url: string;
  readonly records: readonly Observation[];
  close(): Promise<void>;
};

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export async function startFixturePlatform(
  groupsFor: (origin: () => string) => readonly RouteGroup[],
): Promise<FixturePlatform & { readonly server: Server }> {
  let url = "";
  const groups = groupsFor(() => url);
  const routes = groups.flatMap((group) => group.routes);
  const records: Observation[] = [];

  const server = createServer((incoming: IncomingMessage, outgoing: ServerResponse) => {
    void (async () => {
      const at = new URL(incoming.url ?? "/", url === "" ? "http://fixture" : url);
      const raw = await readBody(incoming);
      const type = incoming.headers["content-type"] ?? "";

      const route = routes.find(
        (candidate) => candidate.method === incoming.method && candidate.path === at.pathname,
      );

      const answer: FixtureAnswer =
        route === undefined
          ? { status: 404, body: { error: "not_found", message: `nothing serves ${at.pathname}` } }
          : route.handle({
              method: incoming.method ?? "GET",
              url: at,
              headers: incoming.headers as Record<string, string | undefined>,
              body:
                type.includes("application/json") && raw !== ""
                  ? (JSON.parse(raw) as Record<string, unknown>)
                  : null,
              form: type.includes("application/x-www-form-urlencoded")
                ? new URLSearchParams(raw)
                : null,
            });

      records.push({
        seq: records.length,
        method: incoming.method ?? "GET",
        path: at.pathname,
        status: answer.status,
      });

      const payload =
        answer.text ?? JSON.stringify(answer.body ?? {});
      outgoing.writeHead(answer.status, {
        "content-type": answer.contentType ?? "application/json",
        "cache-control": "no-store",
      });
      outgoing.end(payload);
    })();
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  url = `http://127.0.0.1:${address.port}`;

  return {
    url,
    records,
    server,
    async close() {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}
