import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

/**
 * A strict local stand-in for the one door Egma Cloud opens to inference keys.
 *
 * The gateway keeps no key store: it asks the deployment that minted the key
 * whether the key is still good and whose it is. That ask is the seam, so the
 * tests drive the real verifier against a real HTTP server over a real socket
 * rather than against a hand-written verifier — which would prove the interface
 * and not the behavior.
 *
 * **Strict on purpose.** It refuses anything that is not the contract: the
 * wrong method, a body, a credential in a slot the gateway does not use. If the
 * gateway ever starts sending a simulation's details along with the ask, this
 * server is what notices — because "content-free validation" is a promise the
 * product makes and a promise nobody can keep by intending to.
 */

export type EgmaCloudDoor = {
  readonly origin: string;
  readonly validationUrl: string;
  /** Every ask that arrived, in order. What a content-free claim is read from. */
  readonly asks: ValidationAsk[];
  /** Make one more key good, as creating one in Egma Cloud would. */
  issue(secret: string, organizationId: string, inferenceKeyId: string): void;
  /** Stop one working, as revoking it in Egma Cloud would. */
  revoke(secret: string): void;
  /** Answer nothing at all, as an Egma Cloud that is down would. */
  goDown(): void;
  comeBack(): void;
  stop(): Promise<void>;
};

export type ValidationAsk = {
  readonly method: string;
  readonly path: string;
  readonly credential: string | null;
  readonly body: string;
  readonly headers: Readonly<Record<string, string>>;
};

export const VALIDATION_PATH = "/v1/inference-keys/validation";

export async function startEgmaCloudDoor(): Promise<EgmaCloudDoor> {
  const asks: ValidationAsk[] = [];
  const good = new Map<string, { organizationId: string; inferenceKeyId: string }>();
  let down = false;

  const server: Server = createServer(
    (request: IncomingMessage, response: ServerResponse) => {
      let body = "";
      request.on("data", (chunk: Buffer) => {
        body += chunk.toString("utf8");
      });
      request.on("end", () => {
        const url = new URL(request.url ?? "/", "http://cloud");
        const headers: Record<string, string> = {};
        for (const [name, value] of Object.entries(request.headers)) {
          if (typeof value === "string") headers[name] = value;
        }
        asks.push({
          method: request.method ?? "",
          path: url.pathname,
          credential: headers["egma-inference-key"] ?? null,
          body,
          headers,
        });

        if (down) {
          // Not a refusal: a door that says nothing is a door that could not be
          // asked, and the gateway has to tell those two apart.
          response.destroy();
          return;
        }

        if (url.pathname !== VALIDATION_PATH || request.method !== "POST") {
          response.writeHead(404).end();
          return;
        }

        const offered = headers["egma-inference-key"] ?? "";
        const known = good.get(offered);
        if (known === undefined) {
          response
            .writeHead(401, { "content-type": "application/json" })
            .end(JSON.stringify({ error: "inference_key_refused" }));
          return;
        }

        response.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            organization_id: known.organizationId,
            inference_key_id: known.inferenceKeyId,
          }),
        );
      });
    },
  );

  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("the Egma Cloud stand-in did not take a port");
  }
  const origin = `http://127.0.0.1:${address.port}`;

  return {
    origin,
    validationUrl: `${origin}${VALIDATION_PATH}`,
    asks,
    issue(secret, organizationId, inferenceKeyId) {
      good.set(secret, { organizationId, inferenceKeyId });
    },
    revoke(secret) {
      good.delete(secret);
    },
    goDown() {
      down = true;
    },
    comeBack() {
      down = false;
    },
    stop: () =>
      new Promise<void>((stopped) => {
        server.closeAllConnections();
        server.close(() => stopped());
      }),
  };
}
