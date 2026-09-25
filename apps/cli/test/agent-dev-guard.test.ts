/**
 * The guard `egma agent dev` puts in front of the bot's local starter: it
 * refuses any request without the current secret header and forwards the rest,
 * header stripped, to the local port.
 */

import { createServer, request as httpRequest, type IncomingMessage, type Server } from "node:http";
import { connect, createServer as createNetServer, type AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import {
  DEV_SECRET_HEADER,
  startGuard,
  type Guard,
  type GuardEvent,
} from "../src/dev/guard.ts";

const SECRET = "c2VjcmV0LXZhbHVlLWZvci10aGUtZ3VhcmQtdGVzdHMtMzI";

type Seen = {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingMessage["headers"];
  readonly rawHeaders: readonly string[];
  readonly body: string;
};

const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});

async function starter(
  answer: (seen: Seen, response: import("node:http").ServerResponse) => void = (_seen, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ dailyRoom: "https://example.daily.co/room" }));
  },
): Promise<{ readonly port: number; readonly seen: Seen[]; readonly server: Server }> {
  const seen: Seen[] = [];
  const server = createServer((incoming, outgoing) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("end", () => {
      const one: Seen = {
        method: incoming.method ?? "",
        url: incoming.url ?? "",
        headers: incoming.headers,
        rawHeaders: incoming.rawHeaders,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      seen.push(one);
      answer(one, outgoing);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return { port: (server.address() as AddressInfo).port, seen, server };
}

async function guardOn(port: number, events: GuardEvent[] = []): Promise<Guard> {
  const guard = await startGuard({ secret: SECRET, targetPort: port, onEvent: (event) => events.push(event) });
  closers.push(() => guard.close());
  return guard;
}

type Answer = { readonly status: number; readonly headers: IncomingMessage["headers"]; readonly body: string };

function send(
  guard: Guard,
  options: {
    readonly method?: string;
    readonly path?: string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly body?: string | readonly string[];
  } = {},
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      {
        host: "127.0.0.1",
        port: guard.port,
        method: options.method ?? "POST",
        path: options.path ?? "/start",
        headers: options.headers ?? {},
      },
      (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
        incoming.on("end", () =>
          resolve({
            status: incoming.statusCode ?? 0,
            headers: incoming.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    outgoing.on("error", reject);
    const parts = options.body === undefined ? [] : typeof options.body === "string" ? [options.body] : options.body;
    for (const part of parts) outgoing.write(part);
    outgoing.end();
  });
}

const REFUSAL = '{"error":"egma agent dev refused a request without its secret header"}';

describe("the egma agent dev guard", () => {
  it("listens on 127.0.0.1 only", async () => {
    const local = await starter();
    const guard = await guardOn(local.port);

    expect(guard.url).toBe(`http://127.0.0.1:${guard.port}`);
  });

  it("refuses a request without the secret header, and forwards nothing", async () => {
    const local = await starter();
    const events: GuardEvent[] = [];
    const guard = await guardOn(local.port, events);

    const answer = await send(guard, { body: '{"createDailyRoom":true}' });

    expect(answer.status).toBe(401);
    expect(answer.body).toBe(REFUSAL);
    expect(answer.headers["content-type"]).toContain("application/json");
    expect(local.seen).toHaveLength(0);
    expect(events).toEqual([{ kind: "refused", method: "POST", path: "/start" }]);
  });

  it.each([
    ["a wrong secret", `${SECRET.slice(0, -1)}x`],
    ["a shorter secret", SECRET.slice(0, 10)],
    ["a longer secret", `${SECRET}${SECRET}`],
    ["an empty secret", ""],
  ])("refuses %s", async (_name, offered) => {
    const local = await starter();
    const guard = await guardOn(local.port);

    const answer = await send(guard, { headers: { [DEV_SECRET_HEADER]: offered } });

    expect(answer.status).toBe(401);
    expect(answer.body).toBe(REFUSAL);
    expect(local.seen).toHaveLength(0);
  });

  it("refuses the secret sent twice", async () => {
    const local = await starter();
    const guard = await guardOn(local.port);

    const statusLine = await new Promise<string>((resolve, reject) => {
      const socket = connect(guard.port, "127.0.0.1", () => {
        socket.write(
          "POST /start HTTP/1.1\r\nHost: 127.0.0.1\r\n" +
            `${DEV_SECRET_HEADER}: ${SECRET}\r\n${DEV_SECRET_HEADER}: ${SECRET}\r\n` +
            "Content-Length: 0\r\nConnection: close\r\n\r\n",
        );
      });
      socket.setEncoding("utf8");
      let text = "";
      socket.on("data", (chunk: string) => {
        text += chunk;
      });
      socket.on("end", () => resolve(text.split("\r\n")[0] ?? ""));
      socket.on("error", reject);
    });

    expect(statusLine).toBe("HTTP/1.1 401 Unauthorized");
    expect(local.seen).toHaveLength(0);
  });

  it("forwards method, path, query, headers and body with the secret header stripped", async () => {
    const local = await starter();
    const events: GuardEvent[] = [];
    const guard = await guardOn(local.port, events);
    const body = JSON.stringify({
      createDailyRoom: true,
      dailyRoomProperties: { exp: 1_790_000_000, eject_at_room_exp: true },
      body: { tenant: "lakeside", egma: { simulation_id: "sim_01K5TB2H8Y4P7QCWF9XKMD6RZP" } },
      transport: "daily",
    });

    const answer = await send(guard, {
      path: "/start?mode=test&x=1",
      headers: {
        [DEV_SECRET_HEADER]: SECRET,
        "Content-Type": "application/json",
        "X-Customer-Header": "kept",
      },
      body,
    });

    expect(answer.status).toBe(200);
    expect(JSON.parse(answer.body)).toEqual({ dailyRoom: "https://example.daily.co/room" });
    expect(local.seen).toHaveLength(1);
    const seen = local.seen[0]!;
    expect(seen.method).toBe("POST");
    expect(seen.url).toBe("/start?mode=test&x=1");
    expect(seen.body).toBe(body);
    expect(seen.headers["content-type"]).toBe("application/json");
    expect(seen.headers["x-customer-header"]).toBe("kept");
    expect(seen.headers).not.toHaveProperty("x-egma-dev-secret");
    expect(seen.rawHeaders.join("\n")).not.toContain(SECRET);
    expect(events).toEqual([{ kind: "forwarded", method: "POST", path: "/start", status: 200 }]);
  });

  it("accepts the header name in any case", async () => {
    const local = await starter();
    const guard = await guardOn(local.port);

    const answer = await send(guard, { headers: { "x-egma-dev-secret": SECRET } });

    expect(answer.status).toBe(200);
    expect(local.seen[0]?.headers).not.toHaveProperty("x-egma-dev-secret");
  });

  it("forwards other methods and a chunked body", async () => {
    const local = await starter((seen, response) => {
      response.writeHead(202, { "content-type": "text/plain", "x-starter": "yes" });
      response.end(`${seen.method} ${seen.body.length}`);
    });
    const guard = await guardOn(local.port);

    const answer = await send(guard, {
      method: "PUT",
      path: "/anything",
      headers: { [DEV_SECRET_HEADER]: SECRET },
      body: ["first half, ", "second half"],
    });

    expect(answer.status).toBe(202);
    expect(answer.headers["x-starter"]).toBe("yes");
    expect(answer.body).toBe("PUT 23");
    expect(local.seen[0]?.body).toBe("first half, second half");
  });

  it("streams the starter's answer as it arrives", async () => {
    let finish: (() => void) | undefined;
    const local = await starter((_seen, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.write("first ");
      finish = () => response.end("second");
    });
    const guard = await guardOn(local.port);

    const first = await new Promise<string>((resolve, reject) => {
      const outgoing = httpRequest(
        { host: "127.0.0.1", port: guard.port, method: "GET", path: "/stream", headers: { [DEV_SECRET_HEADER]: SECRET } },
        (incoming) => {
          incoming.setEncoding("utf8");
          let text = "";
          incoming.on("data", (chunk: string) => {
            text += chunk;
            if (text === "first ") {
              resolve(text);
              finish?.();
            }
          });
        },
      );
      outgoing.on("error", reject);
      outgoing.end();
    });

    expect(first).toBe("first ");
  });

  it("answers 502 and says so when nothing listens on the local port", async () => {
    const local = await starter();
    const port = local.port;
    await closers.pop()?.();
    const events: GuardEvent[] = [];
    const guard = await guardOn(port, events);

    const answer = await send(guard, { headers: { [DEV_SECRET_HEADER]: SECRET } });

    expect(answer.status).toBe(502);
    expect(JSON.parse(answer.body)).toEqual({
      error: `egma agent dev could not reach your bot's starter on port ${port}: nothing is listening there`,
    });
    expect(events).toEqual([
      { kind: "unreachable", method: "POST", path: "/start", cause: "nothing is listening there" },
    ]);
  });

  it("keeps serving after a caller goes away in the middle of an answer", async () => {
    let seenAbort = false;
    const local = await starter((seen, response) => {
      if (seen.url === "/slow") {
        response.writeHead(200, { "content-type": "text/plain" });
        response.write("partial ");
        response.on("close", () => {
          seenAbort = true;
        });
        return;
      }
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("fine");
    });
    const guard = await guardOn(local.port);

    await new Promise<void>((resolve, reject) => {
      const outgoing = httpRequest(
        { host: "127.0.0.1", port: guard.port, method: "GET", path: "/slow", headers: { [DEV_SECRET_HEADER]: SECRET } },
        (incoming) => {
          incoming.once("data", () => {
            outgoing.destroy();
            resolve();
          });
        },
      );
      outgoing.on("error", () => undefined);
      outgoing.on("close", () => resolve());
      outgoing.end();
      setTimeout(() => reject(new Error("no first chunk")), 5_000);
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const next = await send(guard, { method: "GET", path: "/next", headers: { [DEV_SECRET_HEADER]: SECRET } });

    expect(seenAbort).toBe(true);
    expect(next.status).toBe(200);
    expect(next.body).toBe("fine");
  });

  /** Send raw bytes to the guard and read the whole answer. */
  function raw(guard: Guard, bytes: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const socket = connect(guard.port, "127.0.0.1", () => socket.write(bytes));
      socket.setEncoding("utf8");
      let text = "";
      socket.on("data", (chunk: string) => {
        text += chunk;
      });
      socket.on("end", () => resolve(text));
      socket.on("error", reject);
    });
  }

  it("keeps Host and Content-Length when a Connection header names them", async () => {
    const local = await starter();
    const guard = await guardOn(local.port);

    const answer = await raw(
      guard,
      "POST /start HTTP/1.1\r\nHost: fixture.trycloudflare.com\r\n" +
        `${DEV_SECRET_HEADER}: ${SECRET}\r\nConnection: close, content-length, host, x-drop-me\r\n` +
        "X-Drop-Me: gone\r\nContent-Length: 3\r\n\r\nabc",
    );

    expect(answer.split("\r\n")[0]).toBe("HTTP/1.1 200 OK");
    expect(local.seen).toHaveLength(1);
    expect(local.seen[0]?.body).toBe("abc");
    expect(local.seen[0]?.headers["content-length"]).toBe("3");
    expect(local.seen[0]?.headers["host"]).toBe("fixture.trycloudflare.com");
    expect(local.seen[0]?.headers).not.toHaveProperty("x-drop-me");
  });

  it("forwards a chunked body as a body, never as a second request", async () => {
    const local = await starter();
    const guard = await guardOn(local.port);
    const smuggled = "GET /smuggled HTTP/1.1\r\nHost: x\r\n\r\n";

    const answer = await raw(
      guard,
      "GET /start HTTP/1.1\r\nHost: x\r\n" +
        `${DEV_SECRET_HEADER}: ${SECRET}\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n` +
        `${smuggled.length.toString(16)}\r\n${smuggled}\r\n0\r\n\r\n`,
    );
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(answer.split("\r\n")[0]).toBe("HTTP/1.1 200 OK");
    expect(local.seen.map((one) => one.url)).toEqual(["/start"]);
    expect(local.seen[0]?.body).toBe(smuggled);
  });

  it("opens one upstream connection per request", async () => {
    const local = await starter();
    const guard = await guardOn(local.port);

    await send(guard, { headers: { [DEV_SECRET_HEADER]: SECRET } });

    expect(local.seen[0]?.headers["connection"]).toBe("close");
  });

  it("answers with the standard reason phrase, not the starter's", async () => {
    const starterSocket = createNetServer((socket) => {
      socket.once("data", () => {
        socket.end("HTTP/1.1 201 Whatever The Starter Says\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok");
      });
    });
    await new Promise<void>((resolve) => starterSocket.listen(0, "127.0.0.1", resolve));
    closers.push(() => new Promise<void>((resolve) => starterSocket.close(() => resolve())));
    const guard = await guardOn((starterSocket.address() as AddressInfo).port);

    const answer = await raw(guard, `GET / HTTP/1.1\r\nHost: x\r\n${DEV_SECRET_HEADER}: ${SECRET}\r\nConnection: close\r\n\r\n`);

    expect(answer.split("\r\n")[0]).toBe("HTTP/1.1 201 Created");
    expect(answer.endsWith("ok")).toBe(true);
  });

  it("closes, and refuses new connections after that", async () => {
    const local = await starter();
    const guard = await guardOn(local.port);
    await guard.close();

    await expect(send(guard, { headers: { [DEV_SECRET_HEADER]: SECRET } })).rejects.toThrow();
  });
});
