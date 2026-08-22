import {
  authorize,
  NotPermittedError,
  startPullingProductionCalls,
  stopPullingProductionCalls,
  UnprocessableInputError,
  type PullSwitch,
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

/**
 * The two doors the start-monitoring flow needs, and nothing else.
 *
 * There is no monitoring setup object to create, read or delete: pull is
 * declared on the agent, and push is observed through its traffic alone. What
 * is left is reading a platform account with a key the flow has just been
 * given, and the per-agent switch itself.
 */
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

function described(held: PullSwitch): Record<string, unknown> {
  return {
    agentId: held.agentId,
    agentPlatform: held.agentPlatform,
    platformAgentId: held.platformAgentId,
    monitoringKeyHint: held.monitoringApiKeyHint,
    pullProductionCalls: held.pullProductionCalls,
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

  /**
   * Bind the agent to its platform, seal its monitoring key, and start polling.
   *
   * The key is checked against the two permissions polling actually needs
   * before anything is sealed: reading the account's agents, and reading its
   * production call history. A key that cannot do both would seal cleanly and
   * then fail on every poll with nothing to say which permission was missing.
   */
  registerPlatformOperation(app, monitoringOperations.startPullingProductionCalls, async (request, reply) => {
    const { auth } = requesterOf(request);
    const { agentId } = request.params as { agentId: string };
    const body = (request.body ?? {}) as Body;
    const resolved = await acting(
      auth,
      projectNamed(request.query as Record<string, unknown>, body),
    );
    if (!("auth" in resolved)) return refuseActing(reply, resolved);

    const apiKey = apiKeyIn(body);
    const platformAgentId = given(text(body.platformAgentId));
    if (apiKey === undefined || platformAgentId === undefined) {
      return unprocessable(
        reply,
        "Enter a Retell API key and name the agent it runs as on Retell.",
      );
    }
    if (given(text(body.agentPlatform)) !== "retell") {
      return unprocessable(
        reply,
        "Egma pulls production calls from Retell today. A LiveKit agent pushes them instead.",
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
    if (!discovered.agents.some((agent) => agent.id === platformAgentId)) {
      return unprocessable(
        reply,
        `This Retell account has no agent ${platformAgentId}. Load the account's agents again.`,
      );
    }

    const now = new Date();
    const history = await listTerminalCalls(
      apiKey,
      {
        retellAgentId: platformAgentId,
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

    const started = await startPullingProductionCalls(resolved.auth, {
      agentId,
      agentPlatform: "retell",
      platformAgentId,
      apiKey,
    });
    if (started === undefined) {
      return reply.code(404).send({
        error: "not_found",
        message: `There is no active agent ${agentId} in this project.`,
      });
    }
    return reply.send({ pullSwitch: described(started) });
  });

  /** Stop polling one agent. Everything already stored stays where it is. */
  registerPlatformOperation(app, monitoringOperations.stopPullingProductionCalls, async (request, reply) => {
    const { auth } = requesterOf(request);
    const { agentId } = request.params as { agentId: string };
    const query = request.query as Record<string, unknown>;
    const resolved = await acting(auth, projectNamed(query, {}));
    if (!("auth" in resolved)) return refuseActing(reply, resolved);

    const stopped = await stopPullingProductionCalls(resolved.auth, agentId);
    if (stopped === undefined) {
      return reply.code(404).send({
        error: "not_found",
        message: `There is no agent ${agentId} in this project.`,
      });
    }
    return reply.send({ pullSwitch: described(stopped) });
  });

  app.setErrorHandler(async (error, _request, reply) => {
    if (error instanceof UnprocessableInputError) {
      return unprocessable(reply, error.message);
    }
    if (error instanceof NotPermittedError) {
      return notPermitted(
        reply,
        "Your role cannot change Monitoring in this project.",
      );
    }
    throw error;
  });
}
