import { randomUUID } from "node:crypto";

import { newId } from "@egma/ids";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import type { AnyPgColumn, PgTable } from "drizzle-orm/pg-core";

import { db, type Queryable } from "../client.ts";
import { agent, type AgentPlatform } from "../schema/agents.ts";
import { insertAgentWithin } from "./agents.ts";
import {
  monitoringFailure,
  monitoringState,
  productionTraceClaim,
  type MonitoringFailureStatus,
  type MonitoringScanKind,
} from "../schema/production.ts";
import { openCredentials, sealCredentials } from "../sealing.ts";
import type { AuthContext } from "./context.ts";
import { UnprocessableInputError } from "./errors.ts";
import { authorize, here } from "./permissions.ts";
import { within } from "./within.ts";

/**
 * Production monitoring, agent-shaped.
 *
 * There is no setup object and no account-wide health machine. An agent binds
 * to its platform, holds that platform's sealed monitoring key, and its
 * `pull_production_calls` switch is the only stored monitoring choice in the
 * product. The switch opens one machine notebook — `monitoring_state` — and
 * the poller works from that notebook joined to the agent's own key.
 *
 * Push is not here at all, by design: the OTLP door authenticates with the
 * project key, stores and grades, and writes nothing down about having done
 * it. See ADR-0015.
 */

const HISTORY_MILLISECONDS = 30 * 24 * 60 * 60 * 1_000;
const RECONCILIATION_MILLISECONDS = 24 * 60 * 60 * 1_000;
const REGULAR_OVERLAP_MILLISECONDS = 5 * 60 * 1_000;
const DEFAULT_POLL_MILLISECONDS = 30_000;
const DEFAULT_LEASE_MILLISECONDS = 90_000;
const FAILURE_REPLAY_LEASE_MILLISECONDS = 90_000;
const CLAIM_LEASE_MILLISECONDS = 120_000;
const MOST_REPLAYED_AT_ONCE = 50;
const HINT_CHARACTERS = 4;
const SHORTEST_KEY = 8;
const INTERNAL_USER = "production-monitoring";

function monitoringContext(
  organizationId: string,
  projectId: string,
): AuthContext {
  return {
    userId: INTERNAL_USER,
    organizationId,
    projectId,
    role: "member",
    via: "monitoring",
  };
}

function projectOf(auth: AuthContext): string {
  const projectId = auth.projectId;
  if (projectId === undefined) {
    throw new UnprocessableInputError(
      "Monitoring belongs to one project. Select a project first.",
    );
  }
  return projectId;
}

type MonitoringProjectTable = PgTable & {
  readonly organizationId: AnyPgColumn;
  readonly projectId: AnyPgColumn;
};

/** Every Monitoring row belongs to the one project in the acting context. */
function withinMonitoringProject(
  auth: AuthContext,
  table: MonitoringProjectTable,
  narrower?: SQL,
): SQL {
  return within(
    auth,
    table,
    and(eq(table.projectId, projectOf(auth)), narrower),
  );
}

function monitoringKey(value: unknown): string {
  if (typeof value !== "string") {
    throw new UnprocessableInputError("The platform API key must be text.");
  }
  const key = value.trim();
  if (key.length < SHORTEST_KEY) {
    throw new UnprocessableInputError(
      "The platform API key is shorter than any key the platform issues.",
    );
  }
  return key;
}

function openedMonitoringKey(envelope: string): string {
  const opened = openCredentials(envelope);
  if (
    typeof opened !== "object" ||
    opened === null ||
    Array.isArray(opened) ||
    typeof (opened as { apiKey?: unknown }).apiKey !== "string"
  ) {
    throw new Error("The agent's monitoring credential is unreadable");
  }
  return (opened as { apiKey: string }).apiKey;
}

export type MonitoringFailureSummary = {
  readonly id: string;
  readonly providerCallId: string;
  readonly errorKind: string;
  readonly attempts: number;
  readonly status: MonitoringFailureStatus;
  readonly lastAttemptAt: Date;
  readonly createdAt: Date;
};

/** What the pull switch says about one agent. No health, no progress. */
export type AgentPullState = {
  readonly agentId: string;
  readonly pullProductionCalls: boolean;
  readonly agentPlatform: AgentPlatform | null;
  readonly platformAgentId: string | null;
  readonly monitoringApiKeyHint: string | null;
  readonly scanKind: MonitoringScanKind | null;
  readonly completedThrough: Date | null;
  readonly lastReceivedAt: Date | null;
  readonly failures: readonly MonitoringFailureSummary[];
};

/**
 * Bind one agent to its platform, seal its key, flip the switch, and open the
 * notebook — inside whatever transaction the caller is already in.
 *
 * **It takes the transaction rather than opening one**, because the two callers
 * need different amounts of work to be one atomic act. Enabling an agent that
 * already exists is this and nothing else. Registering an unregistered platform
 * agent is *this plus the insert that made the row*, and splitting those two
 * across separate commits is what leaves an unbound agent behind when the
 * uniqueness index refuses the switch.
 */
async function bindAndOpen(
  tx: Queryable,
  auth: AuthContext,
  projectId: string,
  input: {
    readonly agentId: string;
    readonly agentPlatform: AgentPlatform;
    readonly platformAgentId: string;
    readonly apiKey: string;
    readonly now: Date;
    readonly historyFrom: Date;
    readonly reconcileAt: Date;
  },
): Promise<void> {
  await tx
    .update(agent)
    .set({
      agentPlatform: input.agentPlatform,
      platformAgentId: input.platformAgentId,
      monitoringApiKey: sealCredentials({ apiKey: input.apiKey }),
      monitoringApiKeyHint: input.apiKey.slice(-HINT_CHARACTERS),
      pullProductionCalls: true,
      updatedAt: input.now,
    })
    .where(eq(agent.id, input.agentId));

  // The notebook is created by the switch and, in v1, only by it. A second
  // enable resumes the notebook it already has rather than losing its cursor,
  // and only wakes it up.
  await tx
    .insert(monitoringState)
    .values({
      id: newId("mst"),
      agentId: input.agentId,
      organizationId: auth.organizationId,
      projectId,
      scanKind: "historical_import",
      scanFrom: input.historyFrom,
      scanThrough: input.now,
      nextRegularPollAt: input.now,
      nextPollAt: input.now,
      nextReconciliationAt: input.reconcileAt,
    })
    .onConflictDoUpdate({
      target: [monitoringState.agentId],
      set: { nextPollAt: input.now, consecutiveFailures: 0, updatedAt: input.now },
    });
}

/**
 * Turn pull on for one agent: bind it to its platform, seal its monitoring
 * key, and open the notebook with the historical-import window.
 *
 * The key is asked for even when a connection already holds one for the same
 * account. Simulation custody and monitoring custody are two jobs with two
 * secrets on purpose, and the double paste is a decision, not an oversight.
 */
export async function enablePullProductionCalls(
  auth: AuthContext,
  input: {
    readonly agentId: string;
    readonly agentPlatform: AgentPlatform;
    readonly platformAgentId: string;
    readonly apiKey: unknown;
    readonly now?: Date | undefined;
  },
): Promise<AgentPullState> {
  authorize(auth, "configure_monitoring", here(auth));
  const projectId = projectOf(auth);
  const apiKey = monitoringKey(input.apiKey);
  const platformAgentId = input.platformAgentId.trim();
  if (platformAgentId === "") {
    throw new UnprocessableInputError(
      "The platform's own id for this agent is required to pull its calls.",
    );
  }
  const now = input.now ?? new Date();
  const historyFrom = new Date(now.getTime() - HISTORY_MILLISECONDS);
  const reconcileAt = new Date(now.getTime() + RECONCILIATION_MILLISECONDS);

  await db().transaction(async (tx) => {
    const [held] = await tx
      .select({ id: agent.id })
      .from(agent)
      .where(
        and(
          within(auth, agent, eq(agent.projectId, projectId)),
          eq(agent.id, input.agentId),
          isNull(agent.archivedAt),
        ),
      )
      .for("update");
    if (held === undefined) {
      throw new UnprocessableInputError(
        "That agent is not in this project, or has been archived.",
      );
    }
    await bindAndOpen(tx, auth, projectId, {
      agentId: input.agentId,
      agentPlatform: input.agentPlatform,
      platformAgentId,
      apiKey,
      now,
      historyFrom,
      reconcileAt,
    });
  });

  const state = await readAgentPullState(auth, input.agentId);
  if (state === undefined) throw new Error("The pull switch was not written");
  return state;
}

/**
 * Register one platform agent egma does not know yet, and start pulling it —
 * as one act.
 *
 * **Why this exists rather than a create followed by an enable.** Two requests
 * that both tick the same unregistered platform agent can both write an agent
 * row before either reaches the uniqueness-enforced switch. Split across two
 * commits, the loser's row survives: an agent in the roster bound to nothing,
 * belonging to a request that was told it had failed. One transaction makes
 * the refusal undo the row it was about to be attached to.
 *
 * The insert is `agents.ts`'s own, so the identity, the tenancy stamp and the
 * held-name refusal are decided in one place for every agent egma writes.
 */
export async function registerAgentPullingProductionCalls(
  auth: AuthContext,
  input: {
    readonly name: string;
    readonly agentPlatform: AgentPlatform;
    readonly platformAgentId: string;
    readonly apiKey: unknown;
    readonly now?: Date | undefined;
  },
): Promise<AgentPullState> {
  // Both permissions, because this write is both things: it puts an agent in
  // the roster and it turns monitoring on for it.
  authorize(auth, "configure_agents", here(auth));
  authorize(auth, "configure_monitoring", here(auth));
  const projectId = projectOf(auth);
  const apiKey = monitoringKey(input.apiKey);
  const platformAgentId = input.platformAgentId.trim();
  if (platformAgentId === "") {
    throw new UnprocessableInputError(
      "The platform's own id for this agent is required to pull its calls.",
    );
  }
  const now = input.now ?? new Date();
  const historyFrom = new Date(now.getTime() - HISTORY_MILLISECONDS);
  const reconcileAt = new Date(now.getTime() + RECONCILIATION_MILLISECONDS);

  const agentId = await db().transaction(async (tx) => {
    const written = await insertAgentWithin(tx, auth, projectId, {
      name: input.name,
    });
    await bindAndOpen(tx, auth, projectId, {
      agentId: written.id,
      agentPlatform: input.agentPlatform,
      platformAgentId,
      apiKey,
      now,
      historyFrom,
      reconcileAt,
    });
    return written.id;
  });

  const state = await readAgentPullState(auth, agentId);
  if (state === undefined) throw new Error("The pull switch was not written");
  return state;
}

/**
 * Turn pull off for one agent. The notebook survives — its cursor is what a
 * later re-enable resumes from — and the poller stops claiming the row because
 * the switch, not the notebook, is what makes an agent due.
 */
export async function disablePullProductionCalls(
  auth: AuthContext,
  agentId: string,
  options: { readonly now?: Date | undefined } = {},
): Promise<boolean> {
  authorize(auth, "configure_monitoring", here(auth));
  const projectId = projectOf(auth);
  const now = options.now ?? new Date();
  const stopped = await db()
    .update(agent)
    .set({ pullProductionCalls: false, updatedAt: now })
    .where(
      and(
        within(auth, agent, eq(agent.projectId, projectId)),
        eq(agent.id, agentId),
        eq(agent.pullProductionCalls, true),
      ),
    )
    .returning({ id: agent.id });
  return stopped.length > 0;
}

/** Read one agent's pull state. No credential column is selected. */
export async function readAgentPullState(
  auth: AuthContext,
  agentId: string,
): Promise<AgentPullState | undefined> {
  authorize(auth, "read", here(auth));
  const projectId = projectOf(auth);
  const [row] = await db()
    .select({
      agentId: agent.id,
      pullProductionCalls: agent.pullProductionCalls,
      agentPlatform: agent.agentPlatform,
      platformAgentId: agent.platformAgentId,
      monitoringApiKeyHint: agent.monitoringApiKeyHint,
      scanKind: monitoringState.scanKind,
      completedThrough: monitoringState.completedThrough,
      lastReceivedAt: monitoringState.lastReceivedAt,
    })
    .from(agent)
    .leftJoin(monitoringState, eq(monitoringState.agentId, agent.id))
    .where(
      and(
        within(auth, agent, eq(agent.projectId, projectId)),
        eq(agent.id, agentId),
      ),
    )
    .limit(1);
  if (row === undefined) return undefined;
  return {
    ...row,
    agentPlatform: row.agentPlatform as AgentPlatform | null,
    scanKind: row.scanKind as MonitoringScanKind | null,
    completedThrough: row.completedThrough ?? null,
    lastReceivedAt: row.lastReceivedAt ?? null,
    failures: await listMonitoringFailures(auth, agentId),
  };
}

/** The open poison-call records for one agent, oldest first. */
export async function listMonitoringFailures(
  auth: AuthContext,
  agentId: string,
): Promise<readonly MonitoringFailureSummary[]> {
  authorize(auth, "read", here(auth));
  const rows = await db()
    .select({
      id: monitoringFailure.id,
      providerCallId: monitoringFailure.providerCallId,
      errorKind: monitoringFailure.errorKind,
      attempts: monitoringFailure.attempts,
      status: monitoringFailure.status,
      lastAttemptAt: monitoringFailure.lastAttemptAt,
      createdAt: monitoringFailure.createdAt,
    })
    .from(monitoringFailure)
    .where(
      and(
        withinMonitoringProject(auth, monitoringFailure),
        eq(monitoringFailure.agentId, agentId),
        eq(monitoringFailure.status, "open"),
      ),
    )
    .orderBy(asc(monitoringFailure.createdAt), asc(monitoringFailure.id));
  return rows.map((row) => ({
    ...row,
    status: row.status as MonitoringFailureStatus,
  }));
}

export type MonitoringPullTarget = {
  readonly agentId: string;
  readonly platformAgentId: string;
  readonly platformAgentName: string;
  readonly apiKey: string;
  readonly scanKind: MonitoringScanKind;
  readonly scanFrom: Date;
  readonly scanThrough: Date;
  readonly paginationKey: string | null;
  readonly seenPaginationKeys: readonly string[];
  readonly consecutiveFailures: number;
  readonly leaseOwner: string;
  readonly leaseExpiresAt: Date;
  readonly auth: AuthContext;
};

/**
 * Claim one due pulled agent before any provider request.
 *
 * Due-ness is the switch joined to the notebook: an agent whose switch is off
 * keeps its cursor and is never claimed. Backoff is per agent, so a shared key
 * that starts refusing is discovered independently by each agent's poll.
 */
export async function claimDueMonitoringPull(
  options: {
    readonly now?: Date | undefined;
    readonly leaseMilliseconds?: number | undefined;
  } = {},
): Promise<MonitoringPullTarget | undefined> {
  const now = options.now ?? new Date();
  const leaseMilliseconds =
    options.leaseMilliseconds ?? DEFAULT_LEASE_MILLISECONDS;
  const leaseOwner = randomUUID();
  const leaseExpiresAt = new Date(now.getTime() + leaseMilliseconds);

  const claimed = await db().transaction(async (tx) => {
    const [candidate] = await tx
      .select({
        id: monitoringState.id,
        agentId: monitoringState.agentId,
        organizationId: monitoringState.organizationId,
        projectId: monitoringState.projectId,
        platformAgentId: agent.platformAgentId,
        platformAgentName: agent.name,
        credentials: agent.monitoringApiKey,
        scanKind: monitoringState.scanKind,
        scanFrom: monitoringState.scanFrom,
        scanThrough: monitoringState.scanThrough,
        paginationKey: monitoringState.paginationKey,
        paginationTrail: monitoringState.paginationTrail,
        reconciliationFrom: monitoringState.reconciliationFrom,
        reconciliationThrough: monitoringState.reconciliationThrough,
        reconciliationPaginationKey: monitoringState.reconciliationPaginationKey,
        reconciliationPaginationTrail:
          monitoringState.reconciliationPaginationTrail,
        reconciliationNeedsRegular: monitoringState.reconciliationNeedsRegular,
        completedThrough: monitoringState.completedThrough,
        nextRegularPollAt: monitoringState.nextRegularPollAt,
        nextReconciliationAt: monitoringState.nextReconciliationAt,
        consecutiveFailures: monitoringState.consecutiveFailures,
      })
      .from(monitoringState)
      .innerJoin(
        agent,
        and(
          eq(agent.id, monitoringState.agentId),
          eq(agent.projectId, monitoringState.projectId),
        ),
      )
      .where(
        and(
          eq(agent.pullProductionCalls, true),
          isNull(agent.archivedAt),
          lte(monitoringState.nextPollAt, now),
          or(
            isNull(monitoringState.leaseExpiresAt),
            lte(monitoringState.leaseExpiresAt, now),
          ),
        ),
      )
      .orderBy(asc(monitoringState.nextPollAt), asc(monitoringState.id))
      .limit(1)
      .for("update", { of: monitoringState, skipLocked: true });
    if (
      candidate === undefined ||
      candidate.credentials === null ||
      candidate.platformAgentId === null
    ) {
      return undefined;
    }

    let scanKind = candidate.scanKind as MonitoringScanKind | null;
    let scanFrom = candidate.scanFrom;
    let scanThrough = candidate.scanThrough;
    let paginationKey = candidate.paginationKey;
    let paginationTrail = candidate.paginationTrail;
    if (scanKind === null || scanFrom === null || scanThrough === null) {
      if (
        candidate.reconciliationNeedsRegular ||
        candidate.nextRegularPollAt <= now
      ) {
        scanKind = "regular";
        const completed = candidate.completedThrough ?? now;
        scanFrom = new Date(completed.getTime() - REGULAR_OVERLAP_MILLISECONDS);
        scanThrough = now;
        paginationKey = null;
        paginationTrail = "[]";
      } else if (
        candidate.reconciliationFrom !== null &&
        candidate.reconciliationThrough !== null
      ) {
        scanKind = "reconciliation";
        scanFrom = candidate.reconciliationFrom;
        scanThrough = candidate.reconciliationThrough;
        paginationKey = candidate.reconciliationPaginationKey;
        paginationTrail = candidate.reconciliationPaginationTrail;
      } else if (candidate.nextReconciliationAt <= now) {
        scanKind = "reconciliation";
        scanFrom = new Date(now.getTime() - HISTORY_MILLISECONDS);
        scanThrough = now;
        paginationKey = null;
        paginationTrail = "[]";
      } else {
        scanKind = "regular";
        const completed = candidate.completedThrough ?? now;
        scanFrom = new Date(completed.getTime() - REGULAR_OVERLAP_MILLISECONDS);
        scanThrough = now;
        paginationKey = null;
        paginationTrail = "[]";
      }
    }

    let seenPaginationKeys: readonly string[] = [];
    try {
      const parsed: unknown = JSON.parse(paginationTrail);
      if (
        Array.isArray(parsed) &&
        parsed.every((value): value is string => typeof value === "string")
      ) {
        seenPaginationKeys = parsed;
      }
    } catch {
      // A malformed internal trail cannot be trusted. The current cursor still
      // guards the immediate repeat, and a new checkpoint repairs the row.
    }

    await tx
      .update(monitoringState)
      .set({
        scanKind,
        scanFrom,
        scanThrough,
        paginationKey,
        paginationTrail,
        leaseOwner,
        leaseExpiresAt,
        updatedAt: now,
      })
      .where(eq(monitoringState.id, candidate.id));

    return {
      ...candidate,
      platformAgentId: candidate.platformAgentId,
      scanKind,
      scanFrom,
      scanThrough,
      paginationKey,
      seenPaginationKeys,
      leaseOwner,
      leaseExpiresAt,
    };
  });
  if (claimed === undefined) return undefined;
  return {
    agentId: claimed.agentId,
    platformAgentId: claimed.platformAgentId,
    platformAgentName: claimed.platformAgentName,
    apiKey: openedMonitoringKey(claimed.credentials as string),
    scanKind: claimed.scanKind,
    scanFrom: claimed.scanFrom,
    scanThrough: claimed.scanThrough,
    paginationKey: claimed.paginationKey,
    seenPaginationKeys: claimed.seenPaginationKeys,
    consecutiveFailures: claimed.consecutiveFailures,
    leaseOwner: claimed.leaseOwner,
    leaseExpiresAt: claimed.leaseExpiresAt,
    auth: monitoringContext(claimed.organizationId, claimed.projectId),
  };
}

export async function renewMonitoringLease(
  auth: AuthContext,
  target: Pick<MonitoringPullTarget, "agentId" | "leaseOwner">,
  options: {
    readonly now?: Date | undefined;
    readonly leaseMilliseconds?: number | undefined;
  } = {},
): Promise<boolean> {
  const now = options.now ?? new Date();
  const expires = new Date(
    now.getTime() + (options.leaseMilliseconds ?? DEFAULT_LEASE_MILLISECONDS),
  );
  return db().transaction(async (tx) => {
    const [requestable] = await tx
      .select({ id: monitoringState.id })
      .from(monitoringState)
      .innerJoin(agent, eq(agent.id, monitoringState.agentId))
      .where(
        and(
          withinMonitoringProject(auth, monitoringState),
          eq(monitoringState.agentId, target.agentId),
          eq(monitoringState.leaseOwner, target.leaseOwner),
          isNotNull(monitoringState.leaseExpiresAt),
          eq(agent.pullProductionCalls, true),
        ),
      )
      .for("update", { of: monitoringState });
    if (requestable === undefined) return false;
    const renewed = await tx
      .update(monitoringState)
      .set({ leaseExpiresAt: expires, updatedAt: now })
      .where(
        and(
          withinMonitoringProject(auth, monitoringState),
          eq(monitoringState.agentId, target.agentId),
          eq(monitoringState.leaseOwner, target.leaseOwner),
        ),
      )
      .returning({ id: monitoringState.id });
    return renewed.length === 1;
  });
}

/** Save an opaque provider cursor only after every call on that page is durable. */
export async function checkpointMonitoringPage(
  auth: AuthContext,
  target: Pick<MonitoringPullTarget, "agentId" | "leaseOwner">,
  input: {
    readonly paginationKey: string;
    readonly seenPaginationKeys: readonly string[];
  },
): Promise<boolean> {
  const updated = await db()
    .update(monitoringState)
    .set({
      paginationKey: input.paginationKey,
      paginationTrail: JSON.stringify(input.seenPaginationKeys),
      updatedAt: new Date(),
    })
    .where(
      and(
        withinMonitoringProject(auth, monitoringState),
        eq(monitoringState.agentId, target.agentId),
        eq(monitoringState.leaseOwner, target.leaseOwner),
      ),
    )
    .returning({ id: monitoringState.id });
  return updated.length === 1;
}

/** Yield bounded work without treating a healthy backlog as a failure. */
export async function yieldMonitoringLease(
  auth: AuthContext,
  target: Pick<MonitoringPullTarget, "agentId" | "leaseOwner" | "scanKind">,
  input: {
    readonly retryAt: Date;
    readonly now?: Date | undefined;
  },
): Promise<boolean> {
  const now = input.now ?? new Date();
  return db().transaction(async (tx) => {
    const [held] = await tx
      .select({
        scanKind: monitoringState.scanKind,
        scanFrom: monitoringState.scanFrom,
        scanThrough: monitoringState.scanThrough,
        paginationKey: monitoringState.paginationKey,
        paginationTrail: monitoringState.paginationTrail,
        nextRegularPollAt: monitoringState.nextRegularPollAt,
      })
      .from(monitoringState)
      .where(
        and(
          withinMonitoringProject(auth, monitoringState),
          eq(monitoringState.agentId, target.agentId),
          eq(monitoringState.leaseOwner, target.leaseOwner),
        ),
      )
      .for("update");
    if (held === undefined) return false;

    const pausesReconciliation =
      target.scanKind === "reconciliation" &&
      held.scanKind === "reconciliation" &&
      held.scanFrom !== null &&
      held.scanThrough !== null;
    const updated = await tx
      .update(monitoringState)
      .set({
        ...(pausesReconciliation
          ? {
              reconciliationFrom: held.scanFrom,
              reconciliationThrough: held.scanThrough,
              reconciliationPaginationKey: held.paginationKey,
              reconciliationPaginationTrail: held.paginationTrail,
              reconciliationNeedsRegular: true,
              scanKind: null,
              scanFrom: null,
              scanThrough: null,
              paginationKey: null,
              paginationTrail: "[]",
            }
          : {}),
        nextPollAt: pausesReconciliation
          ? held.nextRegularPollAt
          : input.retryAt,
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: now,
      })
      .where(
        and(
          withinMonitoringProject(auth, monitoringState),
          eq(monitoringState.agentId, target.agentId),
          eq(monitoringState.leaseOwner, target.leaseOwner),
        ),
      )
      .returning({ id: monitoringState.id });
    return updated.length === 1;
  });
}

/** Finish the fixed scan and release its lease. */
export async function finishMonitoringScan(
  auth: AuthContext,
  target: MonitoringPullTarget,
  options: {
    readonly now?: Date | undefined;
    readonly pollMilliseconds?: number | undefined;
  } = {},
): Promise<boolean> {
  const now = options.now ?? new Date();
  const scheduledNextPollAt = new Date(
    now.getTime() + (options.pollMilliseconds ?? DEFAULT_POLL_MILLISECONDS),
  );
  const completedThrough =
    target.scanKind === "reconciliation" ? undefined : target.scanThrough;
  return db().transaction(async (tx) => {
    const [held] = await tx
      .select({
        reconciliationFrom: monitoringState.reconciliationFrom,
        reconciliationThrough: monitoringState.reconciliationThrough,
        reconciliationNeedsRegular: monitoringState.reconciliationNeedsRegular,
        nextRegularPollAt: monitoringState.nextRegularPollAt,
        nextReconciliationAt: monitoringState.nextReconciliationAt,
      })
      .from(monitoringState)
      .where(
        and(
          withinMonitoringProject(auth, monitoringState),
          eq(monitoringState.agentId, target.agentId),
          eq(monitoringState.leaseOwner, target.leaseOwner),
        ),
      )
      .for("update");
    if (held === undefined) return false;
    const resumesReconciliation =
      target.scanKind === "regular" &&
      held.reconciliationNeedsRegular &&
      held.reconciliationFrom !== null &&
      held.reconciliationThrough !== null;
    const reconciliationReady =
      target.scanKind === "regular" &&
      (resumesReconciliation || held.nextReconciliationAt <= now);
    const updated = await tx
      .update(monitoringState)
      .set({
        scanKind: null,
        scanFrom: null,
        scanThrough: null,
        paginationKey: null,
        paginationTrail: "[]",
        ...(completedThrough === undefined ? {} : { completedThrough }),
        ...(target.scanKind === "reconciliation"
          ? {}
          : { nextRegularPollAt: scheduledNextPollAt }),
        ...(target.scanKind === "reconciliation"
          ? {
              reconciliationFrom: null,
              reconciliationThrough: null,
              reconciliationPaginationKey: null,
              reconciliationPaginationTrail: "[]",
              reconciliationNeedsRegular: false,
              nextReconciliationAt: new Date(
                now.getTime() + RECONCILIATION_MILLISECONDS,
              ),
            }
          : resumesReconciliation
            ? { reconciliationNeedsRegular: false }
            : {}),
        nextPollAt:
          target.scanKind === "reconciliation"
            ? held.nextRegularPollAt
            : reconciliationReady
              ? now
              : scheduledNextPollAt,
        leaseOwner: null,
        leaseExpiresAt: null,
        consecutiveFailures: 0,
        updatedAt: now,
      })
      .where(
        and(
          withinMonitoringProject(auth, monitoringState),
          eq(monitoringState.agentId, target.agentId),
          eq(monitoringState.leaseOwner, target.leaseOwner),
        ),
      )
      .returning({ id: monitoringState.id });
    return updated.length === 1;
  });
}

export type MonitoringFailureKind =
  | "invalid_credential"
  | "rate_limited"
  | "provider_unavailable";

/**
 * Record one provider failure against this agent and release its lease.
 *
 * The counter is a retry clock, not a health surface: it pushes `next_poll_at`
 * out and nobody reads it on a screen. There is no key-wide gate to raise,
 * because a sealed key on one agent is unrecognizable as the same key sealed
 * on another.
 */
export async function failMonitoringPull(
  auth: AuthContext,
  target: MonitoringPullTarget,
  input: {
    readonly kind: MonitoringFailureKind;
    readonly retryAt: Date;
    readonly now?: Date | undefined;
  },
): Promise<{ readonly changed: boolean; readonly failures: number }> {
  const now = input.now ?? new Date();
  return db().transaction(async (tx) => {
    const [held] = await tx
      .select({
        credentials: agent.monitoringApiKey,
        consecutiveFailures: monitoringState.consecutiveFailures,
        nextPollAt: monitoringState.nextPollAt,
      })
      .from(monitoringState)
      .innerJoin(agent, eq(agent.id, monitoringState.agentId))
      .where(
        and(
          withinMonitoringProject(auth, monitoringState),
          eq(monitoringState.agentId, target.agentId),
          eq(monitoringState.leaseOwner, target.leaseOwner),
        ),
      )
      .for("update", { of: monitoringState });
    if (held === undefined) return { changed: false, failures: 0 };
    // The key rotated under this poll. Its verdict is about a key nobody holds
    // any more, so drop it and wake the agent to try the current one.
    if (
      held.credentials === null ||
      openedMonitoringKey(held.credentials) !== target.apiKey
    ) {
      await tx
        .update(monitoringState)
        .set({
          nextPollAt: now,
          leaseOwner: null,
          leaseExpiresAt: null,
          updatedAt: now,
        })
        .where(
          and(
            withinMonitoringProject(auth, monitoringState),
            eq(monitoringState.agentId, target.agentId),
            eq(monitoringState.leaseOwner, target.leaseOwner),
          ),
        );
      return { changed: false, failures: held.consecutiveFailures };
    }
    const failures = held.consecutiveFailures + 1;
    await tx
      .update(monitoringState)
      .set({
        nextPollAt: input.retryAt,
        leaseOwner: null,
        leaseExpiresAt: null,
        consecutiveFailures: failures,
        updatedAt: now,
      })
      .where(
        and(
          withinMonitoringProject(auth, monitoringState),
          eq(monitoringState.agentId, target.agentId),
          eq(monitoringState.leaseOwner, target.leaseOwner),
        ),
      );
    return { changed: held.consecutiveFailures === 0, failures };
  });
}

/**
 * Release a lease after a call-only failure without moving its fixed scan.
 *
 * **The retry clock does not climb here.** `consecutive_failures` means "the
 * provider refused this agent", and it does two jobs on that meaning: it is the
 * exponent of the backoff ladder, and it is half the gate that refuses an
 * explicit replay (the other half being a clock still in the future). What
 * reaches this function is neither refusal nor rate limit — a broken page
 * contract, an unreadable call id, an internal fault — so counting it would
 * spend a customer's Retry on a provider that never said no, and a repeating
 * breach would hold that gate shut for ever, because only a finished scan
 * clears the streak. The plain retry the caller passes is the whole answer.
 */
export async function releaseMonitoringLease(
  auth: AuthContext,
  target: Pick<MonitoringPullTarget, "agentId" | "leaseOwner" | "apiKey">,
  input: {
    readonly retryAt: Date;
    readonly errorKind: string;
    readonly now?: Date | undefined;
  },
): Promise<void> {
  const now = input.now ?? new Date();
  await db().transaction(async (tx) => {
    const [held] = await tx
      .select({ credentials: agent.monitoringApiKey })
      .from(monitoringState)
      .innerJoin(agent, eq(agent.id, monitoringState.agentId))
      .where(
        and(
          withinMonitoringProject(auth, monitoringState),
          eq(monitoringState.agentId, target.agentId),
          eq(monitoringState.leaseOwner, target.leaseOwner),
        ),
      )
      .for("update", { of: monitoringState });
    if (held === undefined || held.credentials === null) return;

    const currentKey = openedMonitoringKey(held.credentials);
    await tx
      .update(monitoringState)
      .set(
        currentKey === target.apiKey
          ? {
              nextPollAt: input.retryAt,
              leaseOwner: null,
              leaseExpiresAt: null,
              updatedAt: now,
            }
          : {
              nextPollAt: now,
              leaseOwner: null,
              leaseExpiresAt: null,
              updatedAt: now,
            },
      )
      .where(
        and(
          withinMonitoringProject(auth, monitoringState),
          eq(monitoringState.agentId, target.agentId),
          eq(monitoringState.leaseOwner, target.leaseOwner),
        ),
      );
  });
}

/** Stamp the notebook as pulled calls arrive. */
export async function recordPulledCallReceived(
  auth: AuthContext,
  target: Pick<MonitoringPullTarget, "agentId">,
  receivedAt: Date,
): Promise<void> {
  await db()
    .update(monitoringState)
    .set({ lastReceivedAt: receivedAt, updatedAt: new Date() })
    .where(
      and(
        withinMonitoringProject(auth, monitoringState),
        eq(monitoringState.agentId, target.agentId),
      ),
    );
}

/** A summary is already owned by a completed claim or a durable failure. */
export async function productionCallIsAccountedFor(
  auth: AuthContext,
  providerCallId: string,
): Promise<boolean> {
  const projectId = projectOf(auth);
  const [claim, failure] = await Promise.all([
    db()
      .select({ id: productionTraceClaim.id })
      .from(productionTraceClaim)
      .where(
        and(
          withinMonitoringProject(auth, productionTraceClaim),
          eq(productionTraceClaim.projectId, projectId),
          eq(productionTraceClaim.providerCallId, providerCallId),
        ),
      )
      .limit(1),
    db()
      .select({ id: monitoringFailure.id })
      .from(monitoringFailure)
      .where(
        and(
          withinMonitoringProject(auth, monitoringFailure),
          eq(monitoringFailure.projectId, projectId),
          eq(monitoringFailure.providerCallId, providerCallId),
          eq(monitoringFailure.status, "open"),
        ),
      )
      .limit(1),
  ]);
  return claim.length > 0 || failure.length > 0;
}

/**
 * Write the poison-call record: after bounded retries on one broken call,
 * record it, move the cursor, and keep the replay lease available.
 */
export async function recordMonitoringFailure(
  auth: AuthContext,
  target: MonitoringPullTarget,
  input: {
    readonly providerCallId: string;
    readonly errorKind: string;
    readonly safePayload?: string | undefined;
    readonly now?: Date | undefined;
  },
): Promise<{ readonly changed: boolean; readonly recorded?: false }> {
  const now = input.now ?? new Date();
  const projectId = projectOf(auth);
  return db().transaction(async (tx) => {
    const [owned] = await tx
      .select({ credentials: agent.monitoringApiKey })
      .from(monitoringState)
      .innerJoin(agent, eq(agent.id, monitoringState.agentId))
      .where(
        and(
          withinMonitoringProject(auth, monitoringState),
          eq(monitoringState.agentId, target.agentId),
          eq(monitoringState.leaseOwner, target.leaseOwner),
        ),
      )
      .for("update", { of: monitoringState });
    if (owned === undefined || owned.credentials === null) {
      return { recorded: false, changed: false };
    }
    if (openedMonitoringKey(owned.credentials) !== target.apiKey) {
      await tx
        .update(monitoringState)
        .set({
          nextPollAt: now,
          leaseOwner: null,
          leaseExpiresAt: null,
          updatedAt: now,
        })
        .where(
          and(
            withinMonitoringProject(auth, monitoringState),
            eq(monitoringState.agentId, target.agentId),
            eq(monitoringState.leaseOwner, target.leaseOwner),
          ),
        );
      return { recorded: false, changed: false };
    }

    const [existing] = await tx
      .select({ id: monitoringFailure.id })
      .from(monitoringFailure)
      .where(
        and(
          withinMonitoringProject(auth, monitoringFailure),
          eq(monitoringFailure.agentId, target.agentId),
          eq(monitoringFailure.status, "open"),
        ),
      )
      .limit(1);
    await tx
      .insert(monitoringFailure)
      .values({
        id: newId("mnf"),
        agentId: target.agentId,
        organizationId: auth.organizationId,
        projectId,
        providerCallId: input.providerCallId,
        errorKind: input.errorKind,
        payload: input.safePayload,
        status: "open",
        lastAttemptAt: now,
      })
      .onConflictDoUpdate({
        target: [monitoringFailure.projectId, monitoringFailure.providerCallId],
        set: {
          errorKind: input.errorKind,
          payload: input.safePayload,
          attempts: sql`${monitoringFailure.attempts} + 1`,
          status: "open",
          resolvedAt: null,
          lastAttemptAt: now,
        },
      });
    return { changed: existing === undefined };
  });
}

export type MonitoringFailureReplayTarget = {
  readonly agentId: string;
  readonly failureId: string;
  readonly providerCallId: string;
  readonly platformAgentId: string;
  readonly platformAgentName: string;
  readonly apiKey: string;
  /** The agent's own retry clock, so a replay backs off exactly as a poll does. */
  readonly consecutiveFailures: number;
  readonly leaseOwner: string;
  readonly leaseExpiresAt: Date;
  readonly auth: AuthContext;
};

export type MonitoringFailureReplayClaim =
  | {
      readonly kind: "claimed";
      readonly target: MonitoringFailureReplayTarget;
    }
  | {
      readonly kind: "busy";
      /**
       * Exactly the two reasons this function can give. `backing_off` is the
       * agent's own retry clock, and it is deliberately mute about what the
       * provider said: the account-wide health state that used to name the
       * cause is gone (ADR-0015), so all the server truthfully knows here is
       * *this agent is waiting until `retryAt`*.
       */
      readonly reason: "replay_in_progress" | "backing_off";
      readonly retryAt: Date;
    }
  | { readonly kind: "not_found" };

/**
 * Lease one customer-requested failed call and open the agent's current key.
 *
 * The failure id is always resolved inside the caller's project. A failure in
 * another tenant therefore has the same result as an unknown failure id.
 */
export async function claimMonitoringFailureReplay(
  auth: AuthContext,
  failureId: string,
  options: {
    readonly now?: Date | undefined;
    readonly leaseMilliseconds?: number | undefined;
  } = {},
): Promise<MonitoringFailureReplayClaim> {
  authorize(auth, "configure_monitoring", here(auth));
  projectOf(auth);
  const now = options.now ?? new Date();
  const leaseOwner = randomUUID();
  const leaseExpiresAt = new Date(
    now.getTime() +
      (options.leaseMilliseconds ?? FAILURE_REPLAY_LEASE_MILLISECONDS),
  );

  const claimed = await db().transaction(async (tx) => {
    const [candidate] = await tx
      .select({
        failureId: monitoringFailure.id,
        providerCallId: monitoringFailure.providerCallId,
        replayLeaseExpiresAt: monitoringFailure.replayLeaseExpiresAt,
        agentId: agent.id,
        organizationId: agent.organizationId,
        projectId: agent.projectId,
        platformAgentId: agent.platformAgentId,
        platformAgentName: agent.name,
        credentials: agent.monitoringApiKey,
        consecutiveFailures: monitoringState.consecutiveFailures,
        nextPollAt: monitoringState.nextPollAt,
      })
      .from(monitoringFailure)
      .innerJoin(
        agent,
        and(
          eq(agent.id, monitoringFailure.agentId),
          eq(agent.projectId, monitoringFailure.projectId),
        ),
      )
      .leftJoin(monitoringState, eq(monitoringState.agentId, agent.id))
      .where(
        and(
          withinMonitoringProject(auth, monitoringFailure),
          eq(monitoringFailure.id, failureId),
          eq(monitoringFailure.status, "open"),
        ),
      )
      .for("update", { of: monitoringFailure });
    if (
      candidate === undefined ||
      candidate.credentials === null ||
      candidate.platformAgentId === null
    ) {
      return { kind: "not_found" } as const;
    }
    if (
      candidate.replayLeaseExpiresAt !== null &&
      candidate.replayLeaseExpiresAt > now
    ) {
      return {
        kind: "busy",
        reason: "replay_in_progress",
        retryAt: candidate.replayLeaseExpiresAt,
      } as const;
    }
    // The agent's retry clock gates the explicit replay too, and it has to:
    // without this, a customer pressing Retry would spend the provider request
    // the backoff was taken to stop, and a rate limit would be answered by
    // asking again. The gate is the failure streak *and* the clock together —
    // `next_poll_at` also carries the ordinary 30-second cadence, and an
    // explicit replay must never wait for that.
    if (
      candidate.consecutiveFailures !== null &&
      candidate.consecutiveFailures > 0 &&
      candidate.nextPollAt !== null &&
      candidate.nextPollAt > now
    ) {
      return {
        kind: "busy",
        reason: "backing_off",
        retryAt: candidate.nextPollAt,
      } as const;
    }
    const apiKey = openedMonitoringKey(candidate.credentials);

    const updated = await tx
      .update(monitoringFailure)
      .set({
        replayLeaseOwner: leaseOwner,
        replayLeaseExpiresAt: leaseExpiresAt,
        attempts: sql`${monitoringFailure.attempts} + 1`,
        lastAttemptAt: now,
      })
      .where(
        and(
          withinMonitoringProject(auth, monitoringFailure),
          eq(monitoringFailure.id, candidate.failureId),
          eq(monitoringFailure.status, "open"),
        ),
      )
      .returning({ id: monitoringFailure.id });
    if (updated.length !== 1) return { kind: "not_found" } as const;
    return {
      kind: "claimed",
      candidate: { ...candidate, platformAgentId: candidate.platformAgentId },
      apiKey,
    } as const;
  });

  if (claimed.kind !== "claimed") return claimed;
  return {
    kind: "claimed",
    target: {
      agentId: claimed.candidate.agentId,
      failureId: claimed.candidate.failureId,
      providerCallId: claimed.candidate.providerCallId,
      platformAgentId: claimed.candidate.platformAgentId,
      platformAgentName: claimed.candidate.platformAgentName,
      apiKey: claimed.apiKey,
      consecutiveFailures: claimed.candidate.consecutiveFailures ?? 0,
      leaseOwner,
      leaseExpiresAt,
      auth: monitoringContext(
        claimed.candidate.organizationId,
        claimed.candidate.projectId,
      ),
    },
  };
}

/** Keep a durable failure open after an exact-call replay still cannot import. */
export async function releaseMonitoringFailureReplay(
  auth: AuthContext,
  target: Pick<
    MonitoringFailureReplayTarget,
    "agentId" | "failureId" | "leaseOwner" | "apiKey"
  >,
  input: {
    readonly errorKind: string;
    readonly now?: Date | undefined;
  },
): Promise<boolean> {
  const now = input.now ?? new Date();
  return db().transaction(async (tx) => {
    const [failure] = await tx
      .select({
        id: monitoringFailure.id,
        credentials: agent.monitoringApiKey,
      })
      .from(monitoringFailure)
      .innerJoin(agent, eq(agent.id, monitoringFailure.agentId))
      .where(
        and(
          withinMonitoringProject(auth, monitoringFailure),
          eq(monitoringFailure.id, target.failureId),
          eq(monitoringFailure.status, "open"),
          eq(monitoringFailure.replayLeaseOwner, target.leaseOwner),
          eq(agent.id, target.agentId),
        ),
      )
      .for("update", { of: monitoringFailure });
    if (failure === undefined || failure.credentials === null) return false;

    if (openedMonitoringKey(failure.credentials) !== target.apiKey) {
      await tx
        .update(monitoringFailure)
        .set({ replayLeaseOwner: null, replayLeaseExpiresAt: null })
        .where(
          and(
            withinMonitoringProject(auth, monitoringFailure),
            eq(monitoringFailure.id, target.failureId),
            eq(monitoringFailure.replayLeaseOwner, target.leaseOwner),
          ),
        );
      return false;
    }

    const released = await tx
      .update(monitoringFailure)
      .set({
        errorKind: input.errorKind,
        lastAttemptAt: now,
        replayLeaseOwner: null,
        replayLeaseExpiresAt: null,
      })
      .where(
        and(
          withinMonitoringProject(auth, monitoringFailure),
          eq(monitoringFailure.id, target.failureId),
          eq(monitoringFailure.replayLeaseOwner, target.leaseOwner),
        ),
      )
      .returning({ id: monitoringFailure.id });
    return released.length === 1;
  });
}

export type MonitoringFailureReplayProviderResult = {
  readonly recorded: boolean;
  readonly changed: boolean;
  readonly failures: number;
};

/** Record a provider failure against the agent and release one replay lease. */
export async function failMonitoringFailureReplay(
  auth: AuthContext,
  target: Pick<
    MonitoringFailureReplayTarget,
    "agentId" | "failureId" | "leaseOwner" | "apiKey"
  >,
  input: {
    readonly kind: MonitoringFailureKind;
    readonly retryAt: Date;
    readonly now?: Date | undefined;
  },
): Promise<MonitoringFailureReplayProviderResult> {
  const now = input.now ?? new Date();
  return db().transaction(async (tx) => {
    const [failure] = await tx
      .select({
        id: monitoringFailure.id,
        credentials: agent.monitoringApiKey,
      })
      .from(monitoringFailure)
      .innerJoin(agent, eq(agent.id, monitoringFailure.agentId))
      .where(
        and(
          withinMonitoringProject(auth, monitoringFailure),
          eq(monitoringFailure.id, target.failureId),
          eq(monitoringFailure.status, "open"),
          eq(monitoringFailure.replayLeaseOwner, target.leaseOwner),
          eq(agent.id, target.agentId),
        ),
      )
      .for("update", { of: monitoringFailure });
    if (failure === undefined) {
      return { recorded: false, changed: false, failures: 0 };
    }
    if (
      failure.credentials === null ||
      openedMonitoringKey(failure.credentials) !== target.apiKey
    ) {
      await tx
        .update(monitoringFailure)
        .set({
          replayLeaseOwner: null,
          replayLeaseExpiresAt: null,
          lastAttemptAt: now,
        })
        .where(
          and(
            withinMonitoringProject(auth, monitoringFailure),
            eq(monitoringFailure.id, target.failureId),
            eq(monitoringFailure.replayLeaseOwner, target.leaseOwner),
          ),
        );
      return { recorded: false, changed: false, failures: 0 };
    }

    const [held] = await tx
      .select({ consecutiveFailures: monitoringState.consecutiveFailures })
      .from(monitoringState)
      .where(
        and(
          withinMonitoringProject(auth, monitoringState),
          eq(monitoringState.agentId, target.agentId),
        ),
      )
      .for("update");
    const before = held?.consecutiveFailures ?? 0;
    const failures = before + 1;
    if (held !== undefined) {
      await tx
        .update(monitoringState)
        .set({
          nextPollAt: input.retryAt,
          consecutiveFailures: failures,
          updatedAt: now,
        })
        .where(
          and(
            withinMonitoringProject(auth, monitoringState),
            eq(monitoringState.agentId, target.agentId),
          ),
        );
    }
    await tx
      .update(monitoringFailure)
      .set({
        replayLeaseOwner: null,
        replayLeaseExpiresAt: null,
        lastAttemptAt: now,
      })
      .where(
        and(
          withinMonitoringProject(auth, monitoringFailure),
          eq(monitoringFailure.id, target.failureId),
          eq(monitoringFailure.replayLeaseOwner, target.leaseOwner),
        ),
      );
    return { recorded: true, changed: before === 0, failures };
  });
}

/** Resolve one replayed failure; report whether the agent has none left. */
export async function resolveMonitoringFailureReplay(
  auth: AuthContext,
  target: Pick<
    MonitoringFailureReplayTarget,
    "agentId" | "failureId" | "leaseOwner"
  >,
  options: { readonly now?: Date | undefined } = {},
): Promise<{ readonly resolved: boolean; readonly agentRecovered: boolean }> {
  const now = options.now ?? new Date();
  return db().transaction(async (tx) => {
    const resolved = await tx
      .update(monitoringFailure)
      .set({
        status: "resolved",
        resolvedAt: now,
        replayLeaseOwner: null,
        replayLeaseExpiresAt: null,
      })
      .where(
        and(
          withinMonitoringProject(auth, monitoringFailure),
          eq(monitoringFailure.id, target.failureId),
          eq(monitoringFailure.agentId, target.agentId),
          eq(monitoringFailure.status, "open"),
          eq(monitoringFailure.replayLeaseOwner, target.leaseOwner),
        ),
      )
      .returning({ id: monitoringFailure.id });
    if (resolved.length !== 1) {
      return { resolved: false, agentRecovered: false };
    }

    const [remaining] = await tx
      .select({ id: monitoringFailure.id })
      .from(monitoringFailure)
      .where(
        and(
          withinMonitoringProject(auth, monitoringFailure),
          eq(monitoringFailure.agentId, target.agentId),
          eq(monitoringFailure.status, "open"),
        ),
      )
      .orderBy(
        desc(monitoringFailure.lastAttemptAt),
        desc(monitoringFailure.id),
      )
      .limit(1);
    return { resolved: true, agentRecovered: remaining === undefined };
  });
}

export type ProductionTraceOffer = {
  readonly traceId: string;
  readonly providerCallId: string;
  readonly platformAgentId: string;
  readonly platformAgentName?: string | undefined;
  readonly platformAgentVersion?: string | undefined;
  readonly payload: string;
  readonly endedAt: Date;
};

export type ProductionTraceClaim = ProductionTraceOffer & {
  readonly id: string;
  readonly degraded: boolean;
  readonly auth: AuthContext;
};

/** Atomically own one production call before writing it to ClickHouse. */
export async function claimProductionTrace(
  auth: AuthContext,
  offer: ProductionTraceOffer,
): Promise<ProductionTraceClaim | undefined> {
  const projectId = projectOf(auth);
  const [row] = await db()
    .insert(productionTraceClaim)
    .values({
      id: newId("ptc"),
      organizationId: auth.organizationId,
      projectId,
      traceId: offer.traceId,
      providerCallId: offer.providerCallId,
      platformAgentId: offer.platformAgentId,
      platformAgentName: offer.platformAgentName,
      platformAgentVersion: offer.platformAgentVersion,
      payload: offer.payload,
      endedAt: offer.endedAt,
      status: "claimed",
      claimedAt: new Date(),
    })
    .onConflictDoNothing({
      target: [productionTraceClaim.projectId, productionTraceClaim.providerCallId],
    })
    .returning({ id: productionTraceClaim.id });
  if (row === undefined) return undefined;
  return { ...offer, id: row.id, degraded: false, auth };
}

export async function finishProductionTrace(
  auth: AuthContext,
  finished: { readonly traceId: string; readonly degraded: boolean },
): Promise<void> {
  await db()
    .update(productionTraceClaim)
    .set({
      status: "written",
      writtenAt: new Date(),
      degraded: finished.degraded,
    })
    .where(
      withinMonitoringProject(
        auth,
        productionTraceClaim,
        eq(productionTraceClaim.traceId, finished.traceId),
      ),
    );
}

/** Re-take claims left between Postgres and ClickHouse by a crashed process. */
export async function sweepStaleProductionClaims(
  options: { readonly now?: Date | undefined } = {},
): Promise<readonly ProductionTraceClaim[]> {
  const now = options.now ?? new Date();
  const staleSince = new Date(now.getTime() - CLAIM_LEASE_MILLISECONDS);
  const rows = await db().transaction(async (tx) => {
    const candidates = await tx
      .select({ id: productionTraceClaim.id })
      .from(productionTraceClaim)
      .where(
        and(
          eq(productionTraceClaim.status, "claimed"),
          lt(productionTraceClaim.claimedAt, staleSince),
        ),
      )
      .orderBy(asc(productionTraceClaim.id))
      .limit(MOST_REPLAYED_AT_ONCE)
      .for("update", { of: productionTraceClaim, skipLocked: true });
    if (candidates.length === 0) return [];
    return tx
      .update(productionTraceClaim)
      .set({ claimedAt: now })
      .where(
        inArray(
          productionTraceClaim.id,
          candidates.map((candidate) => candidate.id),
        ),
      )
      .returning({
        id: productionTraceClaim.id,
        organizationId: productionTraceClaim.organizationId,
        projectId: productionTraceClaim.projectId,
        traceId: productionTraceClaim.traceId,
        providerCallId: productionTraceClaim.providerCallId,
        platformAgentId: productionTraceClaim.platformAgentId,
        platformAgentName: productionTraceClaim.platformAgentName,
        platformAgentVersion: productionTraceClaim.platformAgentVersion,
        payload: productionTraceClaim.payload,
        endedAt: productionTraceClaim.endedAt,
        degraded: productionTraceClaim.degraded,
      });
  });
  return rows.map((row) => ({
    id: row.id,
    traceId: row.traceId,
    providerCallId: row.providerCallId,
    platformAgentId: row.platformAgentId,
    ...(row.platformAgentName === null
      ? {}
      : { platformAgentName: row.platformAgentName }),
    ...(row.platformAgentVersion === null
      ? {}
      : { platformAgentVersion: row.platformAgentVersion }),
    payload: row.payload,
    endedAt: row.endedAt,
    degraded: row.degraded,
    auth: monitoringContext(row.organizationId, row.projectId),
  }));
}
