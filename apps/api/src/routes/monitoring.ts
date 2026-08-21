import {
  authorize,
  configureLiveKitMonitoring,
  configureRetellMonitoring,
  listMonitoringSetups,
  NotPermittedError,
  removeMonitoringSetup,
  UnprocessableInputError,
  type MonitoringPlatform,
  type MonitoringSetup,
  type SelectedRetellAgent,
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
import {
  listTerminalCalls,
  type RetellReach as RetellCallReach,
} from "../retell/api.ts";
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

function described(setup: MonitoringSetup): Record<string, unknown> {
  return {
    id: setup.id,
    projectId: setup.projectId,
    agentPlatform: setup.agentPlatform,
    strategy: setup.strategy,
    credentialsHint: setup.credentialsHint,
    health: {
      state: setup.healthState,
      blockedUntil: setup.blockedUntil?.toISOString() ?? null,
      consecutiveFailures: setup.consecutiveFailures,
      lastErrorAt: setup.lastErrorAt?.toISOString() ?? null,
      lastRecoveredAt: setup.lastRecoveredAt?.toISOString() ?? null,
      lastReceivedAt: setup.lastReceivedAt?.toISOString() ?? null,
    },
    agents: setup.agents.map((agent) => ({
      id: agent.id,
      platformAgentId: agent.platformAgentId,
      platformAgentName: agent.platformAgentName,
      state: agent.state,
      scanKind: agent.scanKind,
      lastSuccessAt: agent.lastSuccessAt?.toISOString() ?? null,
      lastConversationAt: agent.lastCallReceivedAt?.toISOString() ?? null,
      lastErrorKind: agent.lastErrorKind,
      lastErrorAt: agent.lastErrorAt?.toISOString() ?? null,
      consecutiveFailures: agent.consecutiveFailures,
      failures: agent.failures.map((failure) => ({
        id: failure.id,
        providerCallId: failure.providerCallId,
        errorKind: failure.errorKind,
        attempts: failure.attempts,
        status: failure.status,
        lastAttemptAt: failure.lastAttemptAt.toISOString(),
        createdAt: failure.createdAt.toISOString(),
      })),
    })),
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

function selectedIn(body: Body): readonly SelectedRetellAgent[] | undefined {
  const raw = body["agents"];
  if (!Array.isArray(raw)) return undefined;
  const selected: SelectedRetellAgent[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      return undefined;
    }
    const held = item as Record<string, unknown>;
    const platformAgentId = text(held["id"]);
    const platformAgentName = text(held["name"]);
    if (platformAgentId === undefined || platformAgentName === undefined) {
      return undefined;
    }
    selected.push({ platformAgentId, platformAgentName });
  }
  return selected;
}

function platformIn(value: string): MonitoringPlatform | undefined {
  return value === "retell" || value === "livekit_agents" ? value : undefined;
}

export async function monitoringRoutes(
  app: FastifyInstance,
  options: MonitoringRoutesOptions,
): Promise<void> {
  credentialed(app, {
    provider: options.provider,
    rateLimit: options.rateLimit,
  });

  registerPlatformOperation(app, monitoringOperations.listMonitoringSources, async (request, reply) => {
    const { auth } = requesterOf(request);
    const query = request.query as Record<string, unknown>;
    const resolved = await acting(auth, projectNamed(query, {}));
    if (!("auth" in resolved)) return refuseActing(reply, resolved);
    const setups = await listMonitoringSetups(resolved.auth);
    return reply.send({ monitoringSources: setups.map(described) });
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

  registerPlatformOperation(app, monitoringOperations.configureRetellMonitoring, async (request, reply) => {
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
    const agents = selectedIn(body);
    if (apiKey === undefined || agents === undefined || agents.length === 0) {
      return unprocessable(
        reply,
        "Enter a Retell API key and select at least one voice agent.",
      );
    }
    const credential: RetellCredential = { reveal: () => apiKey };
    const discovered = await listAgents(credential, accountReach(options));
    if (discovered.kind === "invalid-key") {
      return unprocessable(
        reply,
        "Retell rejected this API key. Check the key and its Agent Read permission.",
      );
    }
    if (discovered.kind !== "agents") {
      return sendRefusal(
        reply,
        "provider_unavailable",
        "Retell did not answer the setup check. Try again.",
      );
    }
    const voiceAgents = new Map(
      discovered.agents
        .filter((agent) => agent.modality === "voice")
        .map((agent) => [agent.id, agent] as const),
    );
    const canonical: SelectedRetellAgent[] = [];
    for (const selected of agents) {
      const agent = voiceAgents.get(selected.platformAgentId);
      if (agent === undefined) {
        return unprocessable(
          reply,
          "One selected Retell voice agent is no longer available. Load the voice agents again.",
        );
      }
      canonical.push({
        platformAgentId: agent.id,
        platformAgentName: agent.name || agent.id,
      });
    }

    const now = new Date();
    const history = await listTerminalCalls(
      apiKey,
      {
        retellAgentId: canonical[0]?.platformAgentId ?? "",
        from: new Date(now.getTime() - 60_000),
        to: now,
        limit: 1,
      },
      callReach(options),
    );
    if (history.kind === "invalid-key") {
      return unprocessable(
        reply,
        "Retell rejected access to production transcript history. Give this key Monitor or History Read permission.",
      );
    }
    if (history.kind !== "calls") {
      return sendRefusal(
        reply,
        "provider_unavailable",
        "Retell did not answer the production transcript history setup check. Try again.",
      );
    }
    const configured = await configureRetellMonitoring(resolved.auth, {
      apiKey,
      agents: canonical,
    });
    return reply.send({ monitoringSource: described(configured) });
  });

  registerPlatformOperation(app, monitoringOperations.configureLiveKitMonitoring, async (request, reply) => {
    const { auth } = requesterOf(request);
    const body = (request.body ?? {}) as Body;
    const resolved = await acting(
      auth,
      projectNamed(request.query as Record<string, unknown>, body),
    );
    if (!("auth" in resolved)) return refuseActing(reply, resolved);
    const configured = await configureLiveKitMonitoring(resolved.auth);
    return reply.send({ monitoringSource: described(configured) });
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
        if (replayed.reason === "rate_limited") {
          return sendRefusal(
            reply,
            "too_many_requests",
            "Retell rate-limited this retry. Wait and try again.",
          );
        }
        if (replayed.reason === "invalid_credential") {
          return unprocessable(
            reply,
            "Retell rejected the current API key. Update the Retell Monitoring setup and try again.",
          );
        }
        if (replayed.reason === "provider_unavailable") {
          return sendRefusal(
            reply,
            "provider_unavailable",
            "Retell did not answer this retry. Try again.",
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

  registerPlatformOperation(app, monitoringOperations.deleteMonitoringSource, async (request, reply) => {
    const { auth } = requesterOf(request);
    const query = request.query as Record<string, unknown>;
    const { platform: rawPlatform } = request.params as { platform: string };
    const platform = platformIn(rawPlatform.replaceAll("-", "_"));
    if (platform === undefined) {
      return unprocessable(
        reply,
        "Monitoring platform must be retell or livekit-agents.",
      );
    }
    const resolved = await acting(auth, projectNamed(query, {}));
    if (!("auth" in resolved)) return refuseActing(reply, resolved);
    const removed = await removeMonitoringSetup(resolved.auth, platform);
    return removed ? reply.code(204).send() : reply.code(404).send({
      error: "not_found",
      message: `No ${rawPlatform} Monitoring setup exists in this project.`,
    });
  });

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
