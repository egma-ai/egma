import type { Config } from "./config.ts";
import { relayHttp } from "./relay-http.ts";
import { relaySocket, SocketRefused } from "./relay-socket.ts";
import {
  type Log,
  operationalRecord,
  refusalResponse,
  type StatusClass,
} from "./record.ts";
import { newRequestId } from "./request-id.ts";
import { HEALTH_PATH, matchRoute, type Route } from "./routes.ts";
import type { SocketHost } from "./socket.ts";
import { isAuthenticated, type Verifier } from "./verify.ts";
import { identityIntrusion, offeredCredential, providerModel } from "./wire.ts";

/**
 * One request through the Egma model gateway, from the door to the record.
 *
 * The order below is the specification's order and it is load-bearing at every
 * step: the route is fixed before anything is read out of the request, the
 * organization is derived from the credential before anything is sent, and the
 * caller's provider authorization is gone before the upstream address exists.
 * A step moved is a rule broken — validating the route after authentication
 * would tell an unauthenticated caller which routes exist, and deriving the
 * organization anywhere but from the verifier would put it within reach of a
 * header.
 *
 * **What this handler never does.** It does not choose a model, translate a
 * protocol, fall back to another provider, retry after output, cache an answer,
 * or keep a payload. Every one of those would make a completed simulation mean
 * something other than what the user selected, which is the whole reason
 * managed model access is allowed to exist at all.
 */

export type GatewayHost = {
  readonly config: Config;
  readonly verifier: Verifier;
  readonly log: Log;
  /** Made per request, because a socket host holds that request's own upgrade. */
  socketHostFor(request: Request): SocketHost;
  /** Keeps the record-writing alive after the response has gone. */
  waitUntil(work: Promise<unknown>): void;
  /**
   * Which build of the application answered, where the host knows.
   *
   * On the health check and nowhere else. A deployment that is rolling one
   * version out beside another needs to be able to see which one served a
   * request — otherwise a canary is a percentage nobody can observe and a
   * rollback is a claim nobody can check.
   */
  readonly version?: string | undefined;
};

/**
 * Built per request rather than once.
 *
 * A Worker's global scope runs before any request exists and is not allowed to
 * do work — the runtime refuses a module that builds a response there, which is
 * the sort of thing that is only ever discovered at deploy time. Nothing in the
 * gateway is built at module scope for that reason.
 */
function healthy(version: string | undefined): Response {
  return new Response(JSON.stringify({ status: "ok", ...(version === undefined ? {} : { version }) }), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

export async function handle(request: Request, host: GatewayHost): Promise<Response> {
  const requestId = newRequestId();
  const startedAt = new Date();
  const url = new URL(request.url);
  const upgrading = (request.headers.get("upgrade") ?? "").toLowerCase() === "websocket";

  const write = (
    statusClass: StatusClass,
    about: Parameters<typeof operationalRecord>[0] = {},
  ): void => {
    host.log.info("relayed", {
      ...operationalRecord({
        requestId,
        startedAt: startedAt.toISOString(),
        endedAt: new Date().toISOString(),
        statusClass,
        bytesToProvider: 0,
        bytesFromProvider: 0,
        totalMs: Date.now() - startedAt.getTime(),
        ...about,
      }),
    });
  };

  const matched = matchRoute(url.pathname, request.method, upgrading);

  if (matched.kind === "health") {
    // No record: a health check is the deployment asking the gateway whether it
    // is alive, and it carries no organization to file an answer under.
    if (request.method !== "GET") {
      return refusalResponse({
        status: 405,
        code: "method_not_allowed",
        message: `${HEALTH_PATH} answers GET`,
      });
    }
    return healthy(host.version);
  }

  if (matched.kind === "no-such-route") {
    write("refused");
    return refusalResponse({
      status: 404,
      code: "no_such_route",
      message:
        "the Egma model gateway carries only its shipped provider and model-job routes, and this is not one",
    });
  }

  if (matched.kind === "wrong-method") {
    write("refused");
    return refusalResponse({
      status: 405,
      code: "method_not_allowed",
      message: `this route answers ${matched.allowed}`,
    });
  }

  if (matched.kind === "wrong-transport") {
    write("refused", { provider: matched.route.provider, job: matched.route.job });
    return refusalResponse({
      status: 400,
      code: "wrong_transport",
      message:
        matched.route.transport === "socket"
          ? "this route is a WebSocket route and this request did not ask to upgrade"
          : "this route is an HTTP route and cannot be upgraded",
    });
  }

  const route: Route = matched.route;

  /**
   * The organization cannot be named from outside authentication, and a caller
   * who tried is told so.
   *
   * Refused rather than ignored, and before authentication rather than after:
   * a request built to override an identity is a request whose author believes
   * it worked, and the expensive version of this failure is the one where they
   * go on believing it.
   */
  const intrusion = identityIntrusion(url, request.headers);
  if (intrusion !== null) {
    write("refused", { provider: route.provider, job: route.job });
    return refusalResponse({
      status: 400,
      code: "organization_cannot_be_named",
      message:
        `the ${intrusion.at} "${intrusion.name}" is in egma's own namespace; the organization a ` +
        "connection acts in comes from its gateway credential and from nowhere else",
    });
  }

  const verified = await host.verifier.verify(offeredCredential(url, request.headers, route));
  if (!isAuthenticated(verified)) {
    write("refused", { provider: route.provider, job: route.job });
    return refusalResponse({
      status: 401,
      code: verified.refused === "absent" ? "no_gateway_credential" : "gateway_credential_refused",
      message:
        verified.refused === "absent"
          ? "this connection carried no Egma inference credential"
          : "this Egma inference credential does not authorize the Egma model gateway",
    });
  }

  const who = {
    organizationId: verified.organizationId,
    inferenceKeyId: verified.inferenceKeyId,
    provider: route.provider,
    job: route.job,
    ...(providerModel(url, route) === undefined
      ? {}
      : { providerModelId: providerModel(url, route) as string }),
  };

  if (route.transport === "socket") {
    let relay;
    try {
      relay = await relaySocket(host.socketHostFor(request), request, route, host.config);
    } catch (error) {
      if (error instanceof SocketRefused) {
        write(error.statusClass, who);
        return refusalResponse({ status: error.status, code: error.code, message: error.message });
      }
      write("provider-failed", who);
      return refusalResponse({
        status: 502,
        code: "provider_unreachable",
        message: "the provider could not be reached",
      });
    }
    host.waitUntil(
      relay.finished.then((outcome) => {
        write(outcome.statusClass, {
          ...who,
          ...(outcome.upstreamRequestId === undefined
            ? {}
            : { upstreamRequestId: outcome.upstreamRequestId }),
          bytesToProvider: outcome.bytesToProvider,
          bytesFromProvider: outcome.bytesFromProvider,
          openMs: outcome.openMs,
          ...(outcome.firstOutputMs === undefined ? {} : { firstOutputMs: outcome.firstOutputMs }),
        });
      }),
    );
    return relay.response;
  }

  const outcome = await relayHttp(request, route, host.config);
  host.waitUntil(
    outcome.finished.then(() => {
      write(outcome.statusClass, {
        ...who,
        ...(outcome.upstreamRequestId === undefined
          ? {}
          : { upstreamRequestId: outcome.upstreamRequestId }),
        bytesToProvider: 0,
        bytesFromProvider: outcome.bytesFromProvider(),
        openMs: outcome.openMs,
        ...(outcome.firstOutputMs === undefined ? {} : { firstOutputMs: outcome.firstOutputMs }),
      });
    }),
  );
  return outcome.response;
}
