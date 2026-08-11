/**
 * A gate in front of the real Retell that forwards reads and refuses the rest.
 *
 * It is what makes "read-only" a property of a run rather than a promise about
 * the code: a request to create, update or delete never leaves this machine,
 * whatever the CLI asks for. The account these checks run against belongs to
 * somebody and the agents on it answer real telephone numbers, so this is the
 * one piece of smoke-check machinery that is shared rather than copied — two
 * allow-lists would eventually differ, and the day they differed is the day one
 * of them would be wrong.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { RETELL_API } from "../../src/retell/client.ts";

/** Exactly what a check is allowed to ask Retell for. */
export const ALLOWED: readonly { method: string; path: RegExp }[] = [
  { method: "POST", path: /^\/v2\/list-agents$/u },
  { method: "GET", path: /^\/get-agent\/[^/]+$/u },
  { method: "GET", path: /^\/get-chat-agent\/[^/]+$/u },
  { method: "GET", path: /^\/get-retell-llm\/[^/]+$/u },
  { method: "GET", path: /^\/get-conversation-flow\/[^/]+$/u },
  // The account's telephone numbers, and one number's own document. Both are
  // reads, and both are what the phone path is built on: which numbers Retell
  // routes to the agent under test, confirmed at the number's own address
  // immediately before egma writes a connection it will really dial.
  { method: "GET", path: /^\/list-phone-numbers$/u },
  { method: "GET", path: /^\/get-phone-number\/[^/]+$/u },
];

export type Gate = {
  readonly url: string;
  /** How many reads were forwarded, by path shape. */
  readonly forwarded: string[];
  /** Anything the gate turned away. One entry here fails the whole run. */
  readonly refused: string[];
  /** What Retell answered, exactly, keyed by path — for a byte-for-byte check. */
  answered(path: string): string | undefined;
  close(): Promise<void>;
};

export async function openGate(): Promise<Gate> {
  const forwarded: string[] = [];
  const refused: string[] = [];
  const answers = new Map<string, string>();

  const server: Server = createServer((incoming: IncomingMessage, outgoing: ServerResponse) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) chunks.push(chunk as Buffer);
      const raw = Buffer.concat(chunks).toString("utf8");

      const at = new URL(incoming.url ?? "/", "http://gate.invalid");
      const method = incoming.method ?? "GET";
      const allowed = ALLOWED.some(
        (rule) => rule.method === method && rule.path.test(at.pathname),
      );

      if (!allowed) {
        refused.push(`${method} ${at.pathname}`);
        outgoing.writeHead(403, { "content-type": "application/json" });
        outgoing.end(JSON.stringify({ error_message: "this check is read-only" }));
        return;
      }

      const answer = await fetch(`${RETELL_API}${at.pathname}${at.search}`, {
        method,
        headers: {
          authorization: incoming.headers.authorization ?? "",
          ...(raw === "" ? {} : { "content-type": "application/json" }),
        },
        ...(raw === "" ? {} : { body: raw }),
      });
      const body = await answer.text();

      // The shape, never the identifier: which reads were made is worth
      // printing, and whose agents they were is not.
      forwarded.push(`${method} ${at.pathname.replace(/^(\/get-[a-z-]+)\/.+$/u, "$1/…")}`);
      if (answer.ok) answers.set(at.pathname, body);

      outgoing.writeHead(answer.status, { "content-type": "application/json" });
      outgoing.end(body);
    })();
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${address.port}`,
    forwarded,
    refused,
    answered: (at) => answers.get(at),
    async close() {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}
