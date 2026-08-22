import { randomUUID } from "node:crypto";

import { newId } from "@egma/ids";
import {
  and,
  asc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import type { AnyPgColumn, PgTable } from "drizzle-orm/pg-core";

import { db } from "../client.ts";
import { agent, type AgentPlatform } from "../schema/agents.ts";
import {
  monitoringFailure,
  monitoringState,
  type MonitoringScanKind,
} from "../schema/production.ts";
import { openCredentials, sealCredentials } from "../sealing.ts";
import { lostToConstraint } from "./agents.ts";
import type { AuthContext } from "./context.ts";
import { UnprocessableInputError } from "./errors.ts";
import { authorize, here } from "./permissions.ts";
import { within } from "./within.ts";

const HISTORY_MILLISECONDS = 30 * 24 * 60 * 60 * 1_000;
const REGULAR_OVERLAP_MILLISECONDS = 5 * 60 * 1_000;
const DEFAULT_POLL_MILLISECONDS = 30_000;
const DEFAULT_LEASE_MILLISECONDS = 90_000;
const HINT_CHARACTERS = 4;
const SHORTEST_KEY = 8;
const INTERNAL_USER = "production-monitoring";

/**
 * One initial attempt and three automatic retries, and nothing beyond it.
 *
 * The ceiling is stored rather than counted in a process, so a restart in the
 * middle of a budget resumes it instead of starting it again. A repeated
 * provider listing is the same observation, not a new one.
 */
export const MOST_PRODUCTION_CALL_ATTEMPTS = 4;

/**
 * How long after the terminal drop the identity-only marker stays.
 *
 * Three regular overlap windows: long enough that every repeat listing of that
 * call meets the marker, short enough that the row is gone well before anybody
 * could mistake it for a record of the loss. The loss itself is reported in one
 * structured event and one counter, which is where it belongs.
 */
const RECENT_DROP_MILLISECONDS = 3 * REGULAR_OVERLAP_MILLISECONDS;

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
      "The platform API key is shorter than any key a platform issues.",
    );
  }
  return key;
}

function platformAgentIdOf(value: unknown): string {
  const id = typeof value === "string" ? value.trim() : "";
  if (id === "") {
    throw new UnprocessableInputError(
      "Naming the agent on its platform is what makes it pollable.",
    );
  }
  return id;
}

/** What the pull switch answers: the binding it settled, and its state. */
export type PullSwitch = {
  readonly agentId: string;
  readonly agentPlatform: AgentPlatform | null;
  readonly platformAgentId: string | null;
  readonly monitoringApiKeyHint: string | null;
  readonly pullProductionCalls: boolean;
};

const SWITCH_COLUMNS = {
  agentId: agent.id,
  agentPlatform: agent.agentPlatform,
  platformAgentId: agent.platformAgentId,
  monitoringApiKeyHint: agent.monitoringApiKeyHint,
  pullProductionCalls: agent.pullProductionCalls,
} as const;

function switchOf(row: {
  agentId: string;
  agentPlatform: string | null;
  platformAgentId: string | null;
  monitoringApiKeyHint: string | null;
  pullProductionCalls: boolean;
}): PullSwitch {
  return {
    ...row,
    agentPlatform: row.agentPlatform as AgentPlatform | null,
  };
}

/**
 * Bind an agent to its platform, seal its monitoring key, and start polling.
 *
 * **Turning the switch on is always the request for one fixed 30-day import**,
 * on the first save and on every later one. That is the whole deep-backfill
 * story: there is no scheduled reconciliation and no automatic backfill deeper
 * than the regular five-minute overlap, so a customer who wants Egma to look
 * further back turns the switch on again and gets exactly that, deliberately.
 *
 * A re-arm is therefore a new **import generation**: the window, cursor and
 * trail are re-armed, and transient call state written under an earlier
 * generation stops applying. A call an earlier regular scan gave up on is
 * allowed one new bounded look, while an ordinary repeated poll — which is the
 * same observation rather than a new one — still is not.
 *
 * The key is a monitoring-only credential and is sealed on the agent's own row.
 * It is asked for even where a connection already holds one for the same
 * account: simulation custody and monitoring custody are two jobs, and they
 * never entangle.
 */
export async function startPullingProductionCalls(
  auth: AuthContext,
  input: {
    readonly agentId: string;
    readonly agentPlatform: AgentPlatform;
    readonly platformAgentId: unknown;
    readonly apiKey: unknown;
    readonly now?: Date | undefined;
  },
): Promise<PullSwitch | undefined> {
  authorize(auth, "configure_monitoring", here(auth));
  const projectId = projectOf(auth);
  const apiKey = monitoringKey(input.apiKey);
  const platformAgentId = platformAgentIdOf(input.platformAgentId);
  const now = input.now ?? new Date();
  const historyFrom = new Date(now.getTime() - HISTORY_MILLISECONDS);

  return db().transaction(async (tx) => {
    const [bound] = await tx
      .update(agent)
      .set({
        agentPlatform: input.agentPlatform,
        platformAgentId,
        monitoringApiKey: sealCredentials({ apiKey }),
        monitoringApiKeyHint: apiKey.slice(-HINT_CHARACTERS),
        pullProductionCalls: true,
        updatedAt: now,
      })
      .where(
        within(
          auth,
          agent,
          and(
            eq(agent.id, input.agentId),
            eq(agent.projectId, projectId),
            isNull(agent.archivedAt),
          ),
        ),
      )
      .returning(SWITCH_COLUMNS)
      .catch((error: unknown) => {
        if (lostToConstraint(error, "agent_pulled_platform_agent_unique")) {
          throw new UnprocessableInputError(
            `Another agent in this project is already pulling production ` +
              `calls for ${platformAgentId}. Turn its switch off first, or ` +
              `pick a different platform agent.`,
          );
        }
        throw error;
      });
    if (bound === undefined) return undefined;

    await tx
      .insert(monitoringState)
      .values({
        agentId: bound.agentId,
        organizationId: auth.organizationId,
        projectId,
        scanKind: "historical_import",
        scanFrom: historyFrom,
        scanThrough: now,
        nextPollAt: now,
      })
      .onConflictDoUpdate({
        target: monitoringState.agentId,
        set: {
          scanKind: "historical_import",
          scanFrom: historyFrom,
          scanThrough: now,
          paginationKey: null,
          paginationTrail: "[]",
          // A fixed window is being re-armed, so any lease over the old one is
          // void: whoever holds it is paging a scan that no longer exists, and
          // every write it makes is refused by its own owner check.
          leaseOwner: null,
          leaseExpiresAt: null,
          importGeneration: sql`${monitoringState.importGeneration} + 1`,
          nextPollAt: now,
          consecutiveFailures: 0,
          updatedAt: now,
        },
      });

    // The new generation cannot see the old one's transient rows, so leaving
    // them would leave rows nothing reads, nothing sweeps and nothing can ever
    // delete. They go with the window they belonged to, in the transaction
    // that replaces it.
    await tx
      .delete(monitoringFailure)
      .where(
        and(
          withinMonitoringProject(auth, monitoringFailure),
          eq(monitoringFailure.agentId, bound.agentId),
        ),
      );

    return switchOf(bound);
  });
}

/**
 * Stop polling one agent, and keep everything already stored.
 *
 * The state row survives on purpose. Its cursor is where this agent's reading
 * got to, and a switch turned back on for the same binding resumes from there
 * rather than asking the provider for a history Egma already holds.
 */
export async function stopPullingProductionCalls(
  auth: AuthContext,
  agentId: string,
): Promise<PullSwitch | undefined> {
  authorize(auth, "configure_monitoring", here(auth));
  const projectId = projectOf(auth);

  const [stopped] = await db()
    .update(agent)
    .set({ pullProductionCalls: false, updatedAt: new Date() })
    .where(
      within(
        auth,
        agent,
        and(eq(agent.id, agentId), eq(agent.projectId, projectId)),
      ),
    )
    .returning(SWITCH_COLUMNS);

  return stopped === undefined ? undefined : switchOf(stopped);
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

export type MonitoringTarget = {
  readonly agentId: string;
  readonly agentPlatform: AgentPlatform;
  readonly platformAgentId: string;
  /** Egma's own name for the agent, used where the provider names none. */
  readonly agentName: string;
  readonly apiKey: string;
  readonly scanKind: MonitoringScanKind;
  readonly scanFrom: Date;
  readonly scanThrough: Date;
  readonly paginationKey: string | null;
  readonly seenPaginationKeys: readonly string[];
  readonly importGeneration: number;
  /**
   * This agent has at least one transient call row of either shape.
   *
   * Answered inside the claim's own statement, so a poller can skip the retry
   * pass entirely without asking a second question. That matters because the
   * common case by far is an agent that owes nothing and a page that is empty,
   * and it has to cost one claim and one provider read — not a query per turn
   * looking for work that is almost never there.
   *
   * It asks about the agent rather than about its current import generation,
   * and it can: re-arming the switch deletes the rows belonging to the window
   * it replaces, so a row from a generation nothing reads cannot exist.
   */
  readonly hasTransientCallState: boolean;
  /** The retry clock this turn was claimed under. Backoff is per agent. */
  readonly consecutiveFailures: number;
  readonly leaseOwner: string;
  readonly leaseExpiresAt: Date;
  readonly auth: AuthContext;
};

/**
 * Claim one due agent before any provider request.
 *
 * The fixed window is decided here and then held: a scan already in flight is
 * resumed exactly as it was, and a new regular scan reaches five minutes back
 * from the last completed upper bound so that a call the provider exposed a
 * little late is still found.
 *
 * Due rows are joined to the agent that owns them, so the switch and the sealed
 * key are read in the same statement that takes the lease — an agent whose
 * switch went off between two turns is simply not claimed again.
 */
export async function claimDueMonitoringAgent(
  options: {
    readonly now?: Date | undefined;
    readonly leaseMilliseconds?: number | undefined;
  } = {},
): Promise<MonitoringTarget | undefined> {
  const now = options.now ?? new Date();
  const leaseMilliseconds =
    options.leaseMilliseconds ?? DEFAULT_LEASE_MILLISECONDS;
  const leaseOwner = randomUUID();
  const leaseExpiresAt = new Date(now.getTime() + leaseMilliseconds);

  const claimed = await db().transaction(async (tx) => {
    const [candidate] = await tx
      .select({
        agentId: monitoringState.agentId,
        organizationId: monitoringState.organizationId,
        projectId: monitoringState.projectId,
        scanKind: monitoringState.scanKind,
        scanFrom: monitoringState.scanFrom,
        scanThrough: monitoringState.scanThrough,
        paginationKey: monitoringState.paginationKey,
        paginationTrail: monitoringState.paginationTrail,
        completedThrough: monitoringState.completedThrough,
        importGeneration: monitoringState.importGeneration,
        consecutiveFailures: monitoringState.consecutiveFailures,
        hasTransientCallState: sql<boolean>`exists (
          select 1 from ${monitoringFailure}
           where ${monitoringFailure.agentId} = ${monitoringState.agentId}
        )`,
        agentPlatform: agent.agentPlatform,
        platformAgentId: agent.platformAgentId,
        agentName: agent.name,
        monitoringApiKey: agent.monitoringApiKey,
      })
      .from(monitoringState)
      .innerJoin(
        agent,
        and(
          eq(agent.id, monitoringState.agentId),
          eq(agent.projectId, monitoringState.projectId),
          eq(agent.organizationId, monitoringState.organizationId),
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
      .orderBy(asc(monitoringState.nextPollAt), asc(monitoringState.agentId))
      .limit(1)
      .for("update", { of: monitoringState, skipLocked: true });
    if (
      candidate === undefined ||
      candidate.monitoringApiKey === null ||
      candidate.agentPlatform === null ||
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
      scanKind = "regular";
      const completed = candidate.completedThrough ?? now;
      scanFrom = new Date(completed.getTime() - REGULAR_OVERLAP_MILLISECONDS);
      scanThrough = now;
      paginationKey = null;
      paginationTrail = "[]";
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
      .where(eq(monitoringState.agentId, candidate.agentId));

    return {
      ...candidate,
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
    agentPlatform: claimed.agentPlatform as AgentPlatform,
    platformAgentId: claimed.platformAgentId as string,
    agentName: claimed.agentName,
    apiKey: openedMonitoringKey(claimed.monitoringApiKey as string),
    scanKind: claimed.scanKind,
    scanFrom: claimed.scanFrom,
    scanThrough: claimed.scanThrough,
    paginationKey: claimed.paginationKey,
    seenPaginationKeys: claimed.seenPaginationKeys,
    importGeneration: claimed.importGeneration,
    hasTransientCallState: claimed.hasTransientCallState,
    consecutiveFailures: claimed.consecutiveFailures,
    leaseOwner: claimed.leaseOwner,
    leaseExpiresAt: claimed.leaseExpiresAt,
    auth: monitoringContext(claimed.organizationId, claimed.projectId),
  };
}

export async function renewMonitoringLease(
  auth: AuthContext,
  target: Pick<MonitoringTarget, "agentId" | "leaseOwner">,
  options: {
    readonly now?: Date | undefined;
    readonly leaseMilliseconds?: number | undefined;
  } = {},
): Promise<boolean> {
  const now = options.now ?? new Date();
  const expires = new Date(
    now.getTime() + (options.leaseMilliseconds ?? DEFAULT_LEASE_MILLISECONDS),
  );
  const renewed = await db()
    .update(monitoringState)
    .set({ leaseExpiresAt: expires, updatedAt: now })
    .where(
      and(
        withinMonitoringProject(auth, monitoringState),
        eq(monitoringState.agentId, target.agentId),
        eq(monitoringState.leaseOwner, target.leaseOwner),
      ),
    )
    .returning({ agentId: monitoringState.agentId });
  return renewed.length === 1;
}

/** Save an opaque provider cursor only after every call on that page is durable. */
export async function checkpointMonitoringPage(
  auth: AuthContext,
  target: Pick<MonitoringTarget, "agentId" | "leaseOwner">,
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
    .returning({ agentId: monitoringState.agentId });
  return updated.length === 1;
}

/** Yield bounded work without treating a healthy backlog as a failure. */
export async function yieldMonitoringLease(
  auth: AuthContext,
  target: Pick<MonitoringTarget, "agentId" | "leaseOwner">,
  input: {
    readonly retryAt: Date;
    readonly now?: Date | undefined;
  },
): Promise<boolean> {
  const now = input.now ?? new Date();
  const updated = await db()
    .update(monitoringState)
    .set({
      // The fixed window, the cursor and the trail all stay exactly where they
      // are: this is a pause inside one scan, and the next claim resumes it.
      nextPollAt: input.retryAt,
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
    .returning({ agentId: monitoringState.agentId });
  return updated.length === 1;
}

/**
 * Finish the fixed scan and release its lease.
 *
 * The completed upper bound moves here and only here, which is what makes the
 * next regular window start where this one stopped.
 */
export async function finishMonitoringScan(
  auth: AuthContext,
  target: MonitoringTarget,
  options: {
    readonly now?: Date | undefined;
    readonly pollMilliseconds?: number | undefined;
  } = {},
): Promise<boolean> {
  const now = options.now ?? new Date();
  const scheduledNextPollAt = new Date(
    now.getTime() + (options.pollMilliseconds ?? DEFAULT_POLL_MILLISECONDS),
  );
  const updated = await db()
    .update(monitoringState)
    .set({
      scanKind: null,
      scanFrom: null,
      scanThrough: null,
      paginationKey: null,
      paginationTrail: "[]",
      completedThrough: target.scanThrough,
      nextPollAt: scheduledNextPollAt,
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
    .returning({ agentId: monitoringState.agentId });
  return updated.length === 1;
}

export type MonitoringFailureKind =
  | "invalid_credential"
  | "rate_limited"
  | "provider_unavailable";

/**
 * Count one provider failure against this agent and release its lease.
 *
 * **Backoff is per agent, and there is no account-wide gate.** Five agents
 * sharing one rate-limited key discover that independently and each back off on
 * its own clock — the cost of custody being per agent, accepted knowingly,
 * because the alternative is a key-wide health machine and a surface nobody
 * asked for.
 *
 * A key rotated while this turn was in flight is not a failure of the new key.
 * The stored envelope is compared against the one this target polled with, and
 * a target holding the old key is simply re-armed for an immediate retry rather
 * than counted against.
 */
export async function failMonitoringTarget(
  auth: AuthContext,
  target: Pick<MonitoringTarget, "agentId" | "leaseOwner" | "apiKey">,
  input: {
    readonly errorKind: string;
    readonly retryAt: Date;
    readonly now?: Date | undefined;
  },
): Promise<{ readonly recorded: boolean; readonly failures: number }> {
  const now = input.now ?? new Date();
  return db().transaction(async (tx) => {
    const [held] = await tx
      .select({
        agentId: monitoringState.agentId,
        consecutiveFailures: monitoringState.consecutiveFailures,
        monitoringApiKey: agent.monitoringApiKey,
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
    if (held === undefined) return { recorded: false, failures: 0 };

    const rotated =
      held.monitoringApiKey === null ||
      openedMonitoringKey(held.monitoringApiKey) !== target.apiKey;
    const failures = rotated ? held.consecutiveFailures : held.consecutiveFailures + 1;

    await tx
      .update(monitoringState)
      .set({
        nextPollAt: rotated ? now : input.retryAt,
        leaseOwner: null,
        leaseExpiresAt: null,
        ...(rotated ? {} : { consecutiveFailures: failures }),
        updatedAt: now,
      })
      .where(
        and(
          withinMonitoringProject(auth, monitoringState),
          eq(monitoringState.agentId, target.agentId),
          eq(monitoringState.leaseOwner, target.leaseOwner),
        ),
      );

    return { recorded: !rotated, failures };
  });
}

/**
 * Move "last heard from" forward for one agent, and never backward.
 *
 * **One writer, because there is one fact**: this agent's production evidence
 * reached the store at this instant. A pulled call landing and a pulled claim
 * finishing after a restart are the same sentence, and one sentence with two
 * writers is two chances to say it differently.
 *
 * **The merge is monotone, and it has to be.** Evidence becomes durable in one
 * order and is drained in another, and the instant a caller passes is the one
 * the evidence was *received* rather than the one it is being written at — so a
 * replay or a historical import carries an older instant than the row already
 * holds. A plain assignment would answer a customer's "last production
 * conversation" by winding it back to a call from an hour ago. `greatest` keeps
 * whichever instant is later, and the `coalesce` is what makes the first write
 * work at all: a column that has never been written is null, and
 * `greatest(null, x)` is null in Postgres, so an agent that had never heard
 * from anybody would stay that way forever.
 *
 * **A pushing agent moves nothing here, by design.** Rows exist only where the
 * pull switch made one, so evidence arriving at the OTLP door matches no row
 * and writes none: push is observed through its traffic and gets no
 * bookkeeping. Batched by construction — the caller names a platform agent,
 * never a call — so one drained segment carrying two hundred conversations of
 * one agent is one statement.
 */
export async function recordProductionEvidenceReceived(
  auth: AuthContext,
  input: {
    readonly agentPlatform: AgentPlatform;
    readonly platformAgentId: string;
    readonly receivedAt: Date;
  },
): Promise<void> {
  if (auth.projectId === undefined) return;
  if (input.platformAgentId === "") return;
  const { receivedAt } = input;

  await db()
    .update(monitoringState)
    .set({
      lastReceivedAt: sql`greatest(coalesce(${monitoringState.lastReceivedAt}, ${receivedAt}), ${receivedAt})`,
      // When the row was touched, which is a different fact from when the
      // evidence was received: a replay or a historical import carries an old
      // `receivedAt` and is happening now, and a row stamped with the older of
      // the two would report that nothing has changed since.
      updatedAt: new Date(),
    })
    .where(
      and(
        withinMonitoringProject(auth, monitoringState),
        inArray(
          monitoringState.agentId,
          db()
            .select({ id: agent.id })
            .from(agent)
            .where(
              and(
                eq(agent.organizationId, auth.organizationId),
                eq(agent.projectId, auth.projectId),
                eq(agent.agentPlatform, input.agentPlatform),
                eq(agent.platformAgentId, input.platformAgentId),
              ),
            ),
        ),
      ),
    );
}

/* ------------------------------------------------------------------- *
 * Transient production call state: a bounded budget, then an expiring mark.
 *
 * Everything below is about calls that did **not** work. A call that lands
 * writes nothing here and nothing anywhere else in Postgres: its evidence is in
 * the object store and then in the trace store, and a receipt row for every
 * successful conversation is exactly the permanent telemetry store this design
 * refuses to keep.
 * ------------------------------------------------------------------- */

/** One listed call Egma is still trying, or has recently given up on. */
export type TransientProductionCall = {
  readonly providerCallId: string;
  /** Attempts already made, counting the initial one. */
  readonly attempts: number;
  readonly errorKind: string;
  /** When the next automatic retry is due. Null once the budget is spent. */
  readonly nextAttemptAt: Date | null;
  /** When a recent-drop marker stops applying. Null while retries remain. */
  readonly expiresAt: Date | null;
};

type TransientRow = {
  providerCallId: string;
  attempts: number;
  errorKind: string;
  nextAttemptAt: Date | null;
  expiresAt: Date | null;
};

const TRANSIENT_COLUMNS = {
  providerCallId: monitoringFailure.providerCallId,
  attempts: monitoringFailure.attempts,
  errorKind: monitoringFailure.errorKind,
  nextAttemptAt: monitoringFailure.nextAttemptAt,
  expiresAt: monitoringFailure.expiresAt,
};

/**
 * A row still says something about this scan.
 *
 * Two conditions, and both are about time rather than about shape: a retry row
 * always applies, because a call with retries left is a call Egma still owes;
 * a marker applies only until it expires, because its whole purpose is to
 * outlive the overlap that would otherwise re-list the call, and no longer.
 */
function transientStillApplies(now: Date): SQL {
  return or(
    isNotNull(monitoringFailure.nextAttemptAt),
    sql`${monitoringFailure.expiresAt} > ${now}`,
  ) as SQL;
}

function transientOf(row: TransientRow): TransientProductionCall {
  return {
    providerCallId: row.providerCallId,
    attempts: row.attempts,
    errorKind: row.errorKind,
    nextAttemptAt: row.nextAttemptAt,
    expiresAt: row.expiresAt,
  };
}

/**
 * What this page already knows about the calls it listed, in **one** statement.
 *
 * The poller asks this once per non-empty page and never once per call. What
 * comes back decides two different things: a call with a scheduled retry is
 * accounted for and must not be hydrated again this turn, and a call with an
 * active marker must not be hydrated at all — the five-minute overlap lists a
 * dropped call again on purpose, and treating that repeat as new work is how a
 * three-attempt budget quietly becomes an endless one.
 *
 * **Scoped to one import generation.** Turning the switch on again is a new,
 * deliberate observation of the provider's history, so state written under an
 * earlier generation is invisible here and the new import may take its own
 * bounded look. An ordinary repeated poll carries the same generation and sees
 * everything, which is the difference the whole rule turns on.
 */
export async function transientProductionCallState(
  auth: AuthContext,
  input: {
    readonly agentId: string;
    readonly providerCallIds: readonly string[];
    readonly importGeneration: number;
    readonly now?: Date | undefined;
  },
): Promise<ReadonlyMap<string, TransientProductionCall>> {
  if (input.providerCallIds.length === 0) return new Map();
  const now = input.now ?? new Date();
  const rows = await db()
    .select(TRANSIENT_COLUMNS)
    .from(monitoringFailure)
    .where(
      and(
        withinMonitoringProject(auth, monitoringFailure),
        eq(monitoringFailure.agentId, input.agentId),
        eq(monitoringFailure.importGeneration, input.importGeneration),
        inArray(monitoringFailure.providerCallId, [...input.providerCallIds]),
        transientStillApplies(now),
      ),
    );
  return new Map(
    rows.map((row) => [row.providerCallId, transientOf(row)] as const),
  );
}

/**
 * The calls whose next automatic retry is due for this leased agent.
 *
 * A retry does not wait to be listed again. An import's fixed window is paged
 * once and never re-read, so a call that failed during one would have no second
 * chance if the overlap were the only way back to it — and a budget that only
 * applies to regular polling is not the budget the product promises.
 */
export async function dueProductionCallRetries(
  auth: AuthContext,
  input: {
    readonly agentId: string;
    readonly importGeneration: number;
    readonly now?: Date | undefined;
    /**
     * How many to take on. Required, and the poller's to choose: it is the one
     * that knows how long a turn may hold a lease, and a second default here
     * would be a bound that could quietly disagree with it.
     */
    readonly limit: number;
  },
): Promise<readonly TransientProductionCall[]> {
  const now = input.now ?? new Date();
  const rows = await db()
    .select(TRANSIENT_COLUMNS)
    .from(monitoringFailure)
    .where(
      and(
        withinMonitoringProject(auth, monitoringFailure),
        eq(monitoringFailure.agentId, input.agentId),
        eq(monitoringFailure.importGeneration, input.importGeneration),
        isNotNull(monitoringFailure.nextAttemptAt),
        lte(monitoringFailure.nextAttemptAt, now),
      ),
    )
    .orderBy(asc(monitoringFailure.nextAttemptAt), asc(monitoringFailure.id))
    .limit(input.limit);
  return rows.map(transientOf);
}

/** What one counted attempt did. */
export type ProductionCallAttemptOutcome =
  | { readonly recorded: false }
  | {
      readonly recorded: true;
      /** Attempts now made, counting this one. */
      readonly attempts: number;
      /** The budget is spent: this row is now a recent-drop marker. */
      readonly dropped: boolean;
    };

/**
 * Count one failed attempt at a listed call, and either schedule the next
 * automatic retry or end the budget.
 *
 * **The count lives here rather than in a process**, which is the whole point:
 * a restart in the middle of a budget resumes it, and a provider listing the
 * same call again does not restart it. The ceiling is a stored check as well as
 * an arithmetic one, so no timing inside any implementation can produce a
 * fourth automatic retry.
 *
 * A row that no longer applies — an expired marker, or state from an earlier
 * import generation — is replaced rather than incremented. That is the same
 * rule the batched lookup uses, said once more where it decides a budget.
 */
export async function recordProductionCallAttempt(
  auth: AuthContext,
  target: Pick<MonitoringTarget, "agentId" | "leaseOwner" | "importGeneration">,
  input: {
    readonly providerCallId: string;
    readonly errorKind: string;
    /**
     * Milliseconds to wait before each automatic retry, in order. The caller
     * owns the timing; the ceiling on how many of them can be used is this
     * module's, and the table's.
     */
    readonly retryBackoffMilliseconds: readonly number[];
    readonly now?: Date | undefined;
  },
): Promise<ProductionCallAttemptOutcome> {
  const now = input.now ?? new Date();
  const projectId = projectOf(auth);
  return db().transaction(async (tx) => {
    const [owned] = await tx
      .select({ agentId: monitoringState.agentId })
      .from(monitoringState)
      .where(
        and(
          withinMonitoringProject(auth, monitoringState),
          eq(monitoringState.agentId, target.agentId),
          eq(monitoringState.leaseOwner, target.leaseOwner),
        ),
      )
      .for("update");
    if (owned === undefined) return { recorded: false } as const;

    const [held] = await tx
      .select({
        id: monitoringFailure.id,
        attempts: monitoringFailure.attempts,
        nextAttemptAt: monitoringFailure.nextAttemptAt,
        expiresAt: monitoringFailure.expiresAt,
        importGeneration: monitoringFailure.importGeneration,
      })
      .from(monitoringFailure)
      .where(
        and(
          withinMonitoringProject(auth, monitoringFailure),
          eq(monitoringFailure.providerCallId, input.providerCallId),
        ),
      )
      .for("update");

    const carries =
      held !== undefined &&
      held.importGeneration === target.importGeneration &&
      (held.nextAttemptAt !== null ||
        (held.expiresAt !== null && held.expiresAt > now));
    const attempts = carries ? held.attempts + 1 : 1;
    const dropped = attempts >= MOST_PRODUCTION_CALL_ATTEMPTS;
    const backoff =
      input.retryBackoffMilliseconds[
        Math.min(attempts - 1, input.retryBackoffMilliseconds.length - 1)
      ] ?? 0;
    const schedule = dropped
      ? {
          nextAttemptAt: null,
          expiresAt: new Date(now.getTime() + RECENT_DROP_MILLISECONDS),
        }
      : {
          nextAttemptAt: new Date(now.getTime() + backoff),
          expiresAt: null,
        };

    if (held === undefined) {
      await tx.insert(monitoringFailure).values({
        id: newId("mnf"),
        organizationId: auth.organizationId,
        projectId,
        agentId: target.agentId,
        providerCallId: input.providerCallId,
        errorKind: input.errorKind,
        attempts,
        lastAttemptAt: now,
        importGeneration: target.importGeneration,
        ...schedule,
      });
    } else {
      await tx
        .update(monitoringFailure)
        .set({
          agentId: target.agentId,
          errorKind: input.errorKind,
          attempts,
          lastAttemptAt: now,
          importGeneration: target.importGeneration,
          ...schedule,
        })
        .where(eq(monitoringFailure.id, held.id));
    }

    return { recorded: true, attempts, dropped } as const;
  });
}

/**
 * Forget one call's transient state, because its evidence is durable.
 *
 * Called after object-store acceptance and never before it. A row deleted on
 * hydration success would be a row deleted while the evidence was still only in
 * this process's memory, and a crash in that gap would leave a call nobody is
 * still trying and nobody has stored.
 *
 * Scoped to the project-and-call pair the row is unique on, which is the scope
 * `recordProductionCallAttempt` finds and reassigns it by: two agents that both
 * meet one provider call keep one row and one budget, so whichever agent makes
 * that call durable is the one that clears it.
 */
export async function deleteProductionCallFailure(
  auth: AuthContext,
  input: { readonly providerCallId: string },
): Promise<void> {
  await db()
    .delete(monitoringFailure)
    .where(
      and(
        withinMonitoringProject(auth, monitoringFailure),
        eq(monitoringFailure.providerCallId, input.providerCallId),
      ),
    );
}

/**
 * Remove recent-drop markers this agent has outlived.
 *
 * The lookup already ignores an expired marker, so this is housekeeping rather
 * than correctness — but a marker nobody deletes is a row that stays in a
 * control database forever, and this table's whole promise is that it does not
 * grow with a customer's traffic.
 */
export async function sweepExpiredProductionCallMarkers(
  auth: AuthContext,
  input: {
    readonly agentId: string;
    readonly now?: Date | undefined;
  },
): Promise<number> {
  const now = input.now ?? new Date();
  const swept = await db()
    .delete(monitoringFailure)
    .where(
      and(
        withinMonitoringProject(auth, monitoringFailure),
        eq(monitoringFailure.agentId, input.agentId),
        isNotNull(monitoringFailure.expiresAt),
        lte(monitoringFailure.expiresAt, now),
      ),
    )
    .returning({ id: monitoringFailure.id });
  return swept.length;
}
