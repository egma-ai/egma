import {
  AgentWriteRefusedError,
  authorize,
  createAgent,
  disablePullProductionCalls,
  enablePullProductionCalls,
  getAgent,
  listAgents as listProjectAgents,
  NotPermittedError,
  readAgentPullState,
  UnprocessableInputError,
  type AgentPullState,
  type AuthContext,
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

/** The platform this flow supports. LiveKit is push and configures nothing. */
const RETELL = "retell";

/** What this project already knows about one platform's agents. */
type Registered = {
  readonly agentId: string;
  readonly agentName: string;
  readonly pullProductionCalls: boolean;
};

/**
 * Every active agent in this project that names a platform agent, keyed by the
 * platform's own id.
 *
 * This is what turns the account listing into a picker: an account agent this
 * project already registers is *recognized* rather than offered again, and an
 * unregistered one can be ticked to be registered and watched. The key is
 * (project, agent platform, platform agent id) — the pull-uniqueness index's
 * own triple, read through the acting project's own scoped list.
 *
 * **It decides nothing about whether a switch may be flipped.** At most one
 * agent per triple may hold the switch, and the database is what enforces
 * that; this map is for words on a screen.
 */
async function registeredByPlatformAgent(
  auth: AuthContext,
  agentPlatform: string,
): Promise<ReadonlyMap<string, Registered>> {
  const known = new Map<string, Registered>();
  let cursor: string | undefined;
  do {
    const page = await listProjectAgents(auth, {
      limit: 200,
      ...(cursor === undefined ? {} : { cursor }),
    });
    for (const one of page.items) {
      if (one.agentPlatform !== agentPlatform) continue;
      const platformAgentId = one.platformAgentId;
      if (platformAgentId === null) continue;
      const held = known.get(platformAgentId);
      // Two switched-off agents may lawfully name one platform agent. The one
      // that is actually watching is the one worth naming, so it wins the slot.
      if (held === undefined || (!held.pullProductionCalls && one.pullProductionCalls)) {
        known.set(platformAgentId, {
          agentId: one.id,
          agentName: one.name,
          pullProductionCalls: one.pullProductionCalls,
        });
      }
    }
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return known;
}

/**
 * Whether a write lost to the one-switched-on-agent rule.
 *
 * Read from the index's own name, walking the `cause` chain because the query
 * layer hands the driver's error back wrapped. **The database is the only
 * thing asked**: a read that checked first and wrote second would be a race
 * with the very next request, and the index exists precisely so the fight is
 * unrepresentable rather than usually avoided.
 */
function lostToPullUniqueness(error: unknown): boolean {
  for (
    let at: unknown = error, depth = 0;
    at !== undefined && at !== null && depth < 4;
    depth += 1
  ) {
    if (typeof at !== "object") break;
    const carrier = at as { constraint?: unknown; cause?: unknown };
    if (carrier.constraint === "agent_pulled_platform_agent_unique") return true;
    at = carrier.cause;
  }
  return false;
}

/** One platform agent a start-monitoring commit was asked to watch. */
type Wanted = {
  readonly platformAgentId: string;
  readonly name: string | undefined;
  readonly agentId: string | undefined;
};

/** What the commit answers about one agent it started. */
type Started = {
  readonly agentId: string;
  readonly agentName: string;
  readonly platformAgentId: string;
  readonly created: boolean;
  readonly pullProductionCalls: boolean;
};

/** Read the watch list, or say which entry could not be read. */
function watchListIn(body: Body): readonly Wanted[] | string {
  const asked = body.watch;
  if (!Array.isArray(asked) || asked.length === 0) {
    return "Choose at least one agent to watch, then try again.";
  }
  const wanted: Wanted[] = [];
  for (const entry of asked) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return "Each agent to watch is an object naming its platform agent id.";
    }
    const one = entry as Body;
    const platformAgentId = given(text(one.platformAgentId));
    if (platformAgentId === undefined) {
      return "Each agent to watch needs the platform's own id for it.";
    }
    wanted.push({
      platformAgentId,
      name: given(text(one.name)),
      agentId: given(text(one.agentId)),
    });
  }
  return wanted;
}

/** The pull state as the contract publishes it. No credential, no health. */
function statedAs(state: AgentPullState) {
  return {
    agentId: state.agentId,
    pullProductionCalls: state.pullProductionCalls,
    agentPlatform: state.agentPlatform,
    platformAgentId: state.platformAgentId,
    monitoringApiKeyHint: state.monitoringApiKeyHint,
    lastReceivedAt:
      state.lastReceivedAt === null ? null : state.lastReceivedAt.toISOString(),
  };
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
    // What this project already registers, so the list can say which of these
    // agents egma knows and which one a tick would bring into the roster.
    const known = await registeredByPlatformAgent(resolved.auth, RETELL);
    return reply.send({
      agents: listed.agents
        .filter((agent) => agent.modality === "voice")
        .map((agent) => {
          const held = known.get(agent.id);
          return {
            id: agent.id,
            name: agent.name || agent.id,
            registeredAgentId: held?.agentId ?? null,
            registeredAgentName: held?.agentName ?? null,
            pullProductionCalls: held?.pullProductionCalls ?? false,
          };
        })
        .sort((left, right) => left.name.localeCompare(right.name)),
    });
  });

  /**
   * Start pulling: seal the key onto every agent this names, flip each switch,
   * and open each notebook on the 30-day historical window.
   *
   * **A platform agent this project does not register yet is registered here.**
   * Watching an unregistered platform agent *means* registering it, because the
   * roster is the mirror of what egma knows (ADR-0015). One that is already
   * registered is recognized by (project, platform, platform agent id) and
   * updated in place.
   *
   * **One agent at a time, and a refusal does not undo what already started.**
   * Starting an agent is a whole act on its own, so a tick that loses to the
   * one-switched-on-agent rule is reported as itself and the rest still start.
   */
  registerPlatformOperation(app, monitoringOperations.startMonitoring, async (request, reply) => {
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

    if (given(text(body.agentPlatform)) !== RETELL) {
      return unprocessable(
        reply,
        "Egma pulls production calls from Retell. A LiveKit Agents agent " +
          "pushes its own spans and needs no setup here.",
      );
    }
    const apiKey = apiKeyIn(body);
    if (apiKey === undefined) {
      return unprocessable(reply, "Enter a Retell API key.");
    }
    const wanted = watchListIn(body);
    if (typeof wanted === "string") return unprocessable(reply, wanted);

    const started: Started[] = [];
    const contested: string[] = [];

    for (const one of wanted) {
      let agentId = one.agentId;
      let agentName = one.name ?? one.platformAgentId;
      let created = false;

      if (agentId !== undefined) {
        // The caller named an egma agent, so the answer says that agent's
        // name rather than the platform's word for it. A name the caller sent
        // alongside would be the platform's, and the two need not agree.
        const held = await getAgent(resolved.auth, agentId);
        if (held === undefined) {
          return sendRefusal(
            reply,
            "not_found",
            `There is no agent ${agentId} available in this project. ` +
              "Check the link, or choose it from the current project.",
          );
        }
        agentName = held.name;
      }

      if (agentId === undefined) {
        // No egma agent named, so the platform id decides: the agent already
        // bound to it, or a new roster entry for it.
        const known = await registeredByPlatformAgent(resolved.auth, RETELL);
        const held = known.get(one.platformAgentId);
        if (held === undefined) {
          try {
            const made = await createAgent(resolved.auth, { name: agentName });
            agentId = made.id;
            agentName = made.name;
            created = true;
          } catch (error) {
            if (
              error instanceof AgentWriteRefusedError &&
              error.reason === "name_taken"
            ) {
              return sendRefusal(
                reply,
                "name_taken",
                `This project already has an agent called “${agentName}”. ` +
                  "Open that agent and start monitoring from there, or rename " +
                  "the Retell agent.",
              );
            }
            throw error;
          }
        } else {
          agentId = held.agentId;
          agentName = held.agentName;
        }
      }

      try {
        const state = await enablePullProductionCalls(resolved.auth, {
          agentId,
          agentPlatform: RETELL,
          platformAgentId: one.platformAgentId,
          apiKey,
        });
        started.push({
          agentId,
          agentName,
          platformAgentId: one.platformAgentId,
          created,
          pullProductionCalls: state.pullProductionCalls,
        });
      } catch (error) {
        if (!lostToPullUniqueness(error)) throw error;
        contested.push(one.platformAgentId);
      }
    }

    if (contested.length > 0) {
      // Read only now, and only to name the agent already watching. The
      // answer was the database's; this is the sentence around it.
      const known = await registeredByPlatformAgent(resolved.auth, RETELL);
      const named = contested
        .map((platformAgentId) => {
          const held = known.get(platformAgentId);
          return held === undefined
            ? platformAgentId
            : `${platformAgentId} (watched by “${held.agentName}”)`;
        })
        .join(", ");
      return sendRefusal(
        reply,
        "conflict",
        `One Egma agent watches one Retell agent, and something in this ` +
          `project already watches ${named}. Turn that agent's switch off ` +
          "first, or start monitoring from it instead.",
      );
    }

    return reply.send({ watching: started });
  });

  /** Stop pulling. Everything stored stays stored, including the notebook. */
  registerPlatformOperation(app, monitoringOperations.stopMonitoring, async (request, reply) => {
    const { auth } = requesterOf(request);
    const { agentId } = request.params as { agentId: string };
    const resolved = await acting(
      auth,
      projectNamed(request.query as Record<string, unknown>, {}),
    );
    if (!("auth" in resolved)) return refuseActing(reply, resolved);
    authorize(resolved.auth, "configure_monitoring", {
      organizationId: resolved.auth.organizationId,
      projectId: resolved.auth.projectId,
    });

    await disablePullProductionCalls(resolved.auth, agentId);
    const state = await readAgentPullState(resolved.auth, agentId);
    if (state === undefined) {
      return sendRefusal(
        reply,
        "not_found",
        `There is no agent ${agentId} available in this project. ` +
          "Check the link, or choose it from the current project.",
      );
    }
    return reply.send({ monitoring: statedAs(state) });
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
      // Two reasons a replay is refused before it spends a provider request,
      // and only two: another replay already holds the lease, or the agent is
      // waiting out its own retry clock. There is no stored health state any
      // more, so nothing else can be known here — a branch for a rate limit or
      // a bad key would be answering a question the claim never asks.
      if (replayed.kind === "busy") {
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
          "Retell rejected this agent's monitoring key. Start monitoring " +
            "again with a current Retell API key, then retry this import.",
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
        "Your role cannot change monitoring in this project.",
      );
    }
    throw error;
  });
}
