/**
 * One address the CLI can be pointed at, in front of a real egma.
 *
 * **What is real here is real, and what is not is named.** A whole egma runs
 * behind this — a real Postgres, a real ClickHouse, the real API — and every
 * request the CLI makes goes to it: the device flow, the key it mints, the door
 * that key opens. That is the half of the platform that has shipped.
 *
 * The agent, connection and test endpoints have not. Until they do there is
 * nothing at `/api/agents` or `/api/tests` on a real instance to answer — so
 * those paths, and only those, are served by the same fixture the offline
 * checks run against, standing at the same seam. The alternative was to stop
 * the end-to-end check at login, which would leave the whole walk unproven
 * against anything real at all.
 *
 * The seam between the two halves is one line of code and it is worth reading:
 * the key the real instance mints is handed to the fixture as one of its own,
 * caught on its way past. Nothing else crosses.
 *
 * When the public API serves agents and tests, this file is deleted and the
 * check is pointed straight at the instance. Nothing else about it changes.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import {
  startPlatform,
  type AgentControls,
  type Platform,
  type TestControls,
} from "../../test/support/fixture-platform/index.ts";

/** The paths the real instance does not serve yet, and the fixture does. */
const NOT_YET_ON_THE_REAL_API = ["/api/agents", "/api/tests", "/api/test-versions"];

export type HalfRealPlatform = {
  /** What the CLI is pointed at. */
  readonly url: string;
  /** The real egma behind it, for the harness's own requests. */
  readonly apiOrigin: string;
  /** What was registered, on the half that is a fixture. */
  readonly registered: AgentControls;
  /** What was pushed, on the half that is a fixture. */
  readonly tests: TestControls;
  /** Every key the real instance minted while this was up, in order. */
  readonly mintedKeys: readonly string[];
  /** Which requests went where, by path shape, for the run to print. */
  readonly served: { readonly real: number; readonly fixture: number };
  close(): Promise<void>;
};

function goesToTheFixture(pathname: string): boolean {
  return NOT_YET_ON_THE_REAL_API.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

/** The key the real instance has just minted, out of a token answer. */
function keyIn(body: string): string | null {
  try {
    const held = JSON.parse(body) as { access_token?: unknown };
    return typeof held.access_token === "string" && held.access_token !== ""
      ? held.access_token
      : null;
  } catch {
    return null;
  }
}

export async function startHalfRealPlatform(apiOrigin: string): Promise<HalfRealPlatform> {
  const fixture: Platform = await startPlatform();
  const mintedKeys: string[] = [];
  const served = { real: 0, fixture: 0 };

  const server: Server = createServer((incoming: IncomingMessage, outgoing: ServerResponse) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) chunks.push(chunk as Buffer);
      const raw = Buffer.concat(chunks);

      const at = new URL(incoming.url ?? "/", "http://front.invalid");
      const toFixture = goesToTheFixture(at.pathname);
      if (toFixture) served.fixture += 1;
      else served.real += 1;

      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (typeof value !== "string") continue;
        // The hop's own headers: forwarding them would describe a request that
        // is not the one being made.
        if (["host", "connection", "content-length"].includes(name)) continue;
        headers[name] = value;
      }

      const answer = await fetch(
        `${toFixture ? fixture.url : apiOrigin}${at.pathname}${at.search}`,
        {
          method: incoming.method ?? "GET",
          headers,
          ...(raw.length === 0 ? {} : { body: raw }),
        },
      );
      const body = await answer.text();

      // The one thing that crosses between the halves: a key the real instance
      // has just minted is a key the fixture must accept, because the machine
      // holding it is about to write with it.
      if (at.pathname === "/api/device/token" && answer.ok) {
        const key = keyIn(body);
        if (key !== null) {
          mintedKeys.push(key);
          fixture.signedInWith(key);
        }
      }

      // The status and the body come back whole; the headers do not. Both
      // halves answer JSON to a bearer key and nothing the CLI reads is in a
      // header, so what is forwarded is the one header that says how to read
      // the body. A flow that ever needs another will fail loudly here rather
      // than behave subtly differently through the hop than without it.
      outgoing.writeHead(answer.status, {
        "content-type": answer.headers.get("content-type") ?? "application/json",
        "cache-control": "no-store",
      });
      outgoing.end(body);
    })().catch(() => {
      outgoing.writeHead(502, { "content-type": "application/json" });
      outgoing.end(JSON.stringify({ error: "unreachable", message: "the instance did not answer" }));
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${address.port}`,
    apiOrigin,
    registered: fixture.registered,
    tests: fixture.tests,
    mintedKeys,
    served,
    async close() {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      await fixture.close();
    },
  };
}
