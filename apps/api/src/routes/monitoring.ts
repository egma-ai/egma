import {
  authorize,
  NotPermittedError,
  UnprocessableInputError,
} from "@egma/db";
import { monitoringOperations } from "@egma/platform-api/contract";
import {
  listAgents,
  type Fetch as RetellFetch,
  type RetellCredential,
  type RetellReach as RetellAccountReach,
} from "@egma/retell";
import type { FastifyInstance } from "fastify";

import type { SessionIdentityProvider } from "../auth/seam.ts";
import { actingIn, refuseActing } from "../http/acting.ts";
import { credentialed, requesterOf } from "../http/credentialed.ts";
import { registerPlatformOperation } from "../http/platform-operation.ts";
import type { RateLimit } from "../http/rate-limit.ts";
import { given, text } from "../http/reading.ts";
import {
  notPermitted,
  sendRefusal,
  unprocessable,
} from "../http/refusals.ts";
import type { RetellReach as RetellCallReach } from "../retell/api.ts";
import { replayRetellIngestionFailure } from "../retell-production-ingestion.ts";

export type MonitoringRoutesOptions = {
  readonly provider: SessionIdentityProvider;
  readonly rateLimit: RateLimit;
  readonly retellFetch?: RetellFetch | undefined;
  readonly retellReach?: Pick<RetellAccountReach, "url"> | undefined;
};

type Body = Record<string, unknown>;

function accountReach(options: MonitoringRoutesOptions): RetellAccountReach {
  return {
    ...(options.retellFetch === undefined
      ? {}
      : { fetchImpl: options.retellFetch }),
    ...(options.retellReach?.url === undefined
      ? {}
      : { url: options.retellReach.url }),
    signal: AbortSignal.timeout(15_000),
  };
}

function callReach(options: MonitoringRoutesOptions): RetellCallReach {
  return {
    ...(options.retellFetch === undefined
      ? {}
      : { fetchImpl: options.retellFetch }),
    ...(options.retellReach?.url === undefined
      ? {}
      : { url: options.retellReach.url }),
    signal: AbortSignal.timeout(15_000),
  };
}


async function acting(
  auth: ReturnType<typeof requesterOf>["auth"],
  projectId: string | undefined,
) {
  return actingIn(auth, projectId);
}

function apiKeyIn(body: Body): string | undefined {
  return given(text(body.apiKey));
}

function projectNamed(query: Body, body: Body): string | undefined {
  return given(text(query.projectId)) ?? given(text(body.projectId));
}



export async function monitoringRoutes(
  app: FastifyInstance,
  options: MonitoringRoutesOptions,
): Promise<void> {
  credentialed(app, {
    provider: options.provider,
    rateLimit: options.rateLimit,
  });


  /** Validate a key and return only Retell voice-agent identities. */
  registerPlatformOperation(app, monitoringOperations.discoverRetellVoiceAgents, async (request, reply) => {
    const { auth } = requesterOf(request);
    const body = (request.body ?? {}) as Body;
    const resolved = await acting(
      auth,
      projectNamed(request.query as Record<string, unknown>, body),
    );
    if (!("auth" in resolved)) return refuseActing(reply, resolved);
    authorize(resolved.auth, "configure_monitoring", {
      organizationId: resolved.auth.organizationId,
      projectId: resolved.auth.projectId,
    });

    const apiKey = apiKeyIn(body);
    if (apiKey === undefined) {
      return unprocessable(reply, "Enter a Retell API key.");
    }
    const credential: RetellCredential = { reveal: () => apiKey };
    const listed = await listAgents(credential, accountReach(options));
    if (listed.kind === "invalid-key") {
      return unprocessable(
        reply,
        "Retell rejected this API key. Check the key and its Agent Read permission.",
      );
    }
    if (listed.kind !== "agents") {
      return sendRefusal(
        reply,
        "provider_unavailable",
        "Retell did not answer the setup check. Try again.",
      );
    }
    return reply.send({
      agents: listed.agents
        .filter((agent) => agent.modality === "voice")
        .map((agent) => ({ id: agent.id, name: agent.name || agent.id }))
        .sort((left, right) => left.name.localeCompare(right.name)),
    });
  });



  registerPlatformOperation(
    app,
    monitoringOperations.replayMonitoringImportFailure,
    async (request, reply) => {
      const { auth } = requesterOf(request);
      const query = request.query as Record<string, unknown>;
      const { failureId } = request.params as { failureId: string };
      const resolved = await acting(auth, projectNamed(query, {}));
      if (!("auth" in resolved)) return refuseActing(reply, resolved);

      const replayed = await replayRetellIngestionFailure({
        auth: resolved.auth,
        failureId,
        reach: callReach(options),
        log: {
          info: (event) => request.log.info(event),
          warn: (event) => request.log.warn(event),
          error: (event) => request.log.error(event),
        },
      });
      if (replayed.kind === "not_found") {
        return sendRefusal(
          reply,
          "not_found",
          "There is no open Retell import failure with this id in this project.",
        );
      }
      if (replayed.kind === "busy") {
        // The agent is already waiting out its own retry clock, which this
        // retry would otherwise spend a provider request against. There is no
        // stored health state to say why any more, so the honest answer is the
        // wait itself and when it ends.
        if (replayed.reason === "backing_off") {
          return sendRefusal(
            reply,
            "too_many_requests",
            "This agent is waiting before it asks Retell again, until " +
              `${replayed.retryAt.toISOString()}. Try the retry after that.`,
          );
        }
        return sendRefusal(
          reply,
          "conflict",
          "This Retell import failure is already being retried. Refresh Monitoring in a moment.",
        );
      }
      if (replayed.kind === "lease_lost") {
        return sendRefusal(
          reply,
          "conflict",
          "This Retell import retry changed while it was running. Refresh Monitoring and try again.",
        );
      }
      if (replayed.kind === "still_failed") {
        return sendRefusal(
          reply,
          "conflict",
          "Retell still cannot provide a complete production transcript. The import failure remains open.",
        );
      }
      if (replayed.kind === "invalid_credential") {
        return unprocessable(
          reply,
          "Retell rejected the current API key. Update the Retell Monitoring setup and try again.",
        );
      }
      if (replayed.kind === "rate_limited") {
        return sendRefusal(
          reply,
          "too_many_requests",
          "Retell rate-limited this retry. Wait and try again.",
        );
      }
      if (replayed.kind === "provider_unavailable") {
        return sendRefusal(
          reply,
          "provider_unavailable",
          "Retell did not answer this retry. Try again.",
        );
      }
      return reply.send({
        monitoringImportFailure: {
          id: replayed.failureId,
          status: "resolved",
        },
        trace: { id: replayed.traceId, write: replayed.write },
      });
    },
  );


  app.setErrorHandler(async (error, _request, reply) => {
    if (error instanceof UnprocessableInputError) {
      return unprocessable(reply, error.message);
    }
    if (error instanceof NotPermittedError) {
      return notPermitted(
        reply,
        "Your role cannot change Monitoring setup in this project.",
      );
    }
    throw error;
  });
}
