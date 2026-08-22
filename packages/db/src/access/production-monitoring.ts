import { randomUUID } from "node:crypto";

import { newId } from "@egma/ids";
import {
  and,
  asc,
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
import {
  monitoringState,
  retellCallRetry,
  type MonitoringScanKind,
} from "../schema/production.ts";
import { openCredentials, sealCredentials } from "../sealing.ts";
import { insertAgentWithin } from "./agents.ts";
import type { AuthContext } from "./context.ts";
import { UnprocessableInputError } from "./errors.ts";
import { authorize, here } from "./permissions.ts";
import { within } from "./within.ts";

/**
 * Production monitoring, agent-shaped, on the durable ingestion boundary.
 *
 * There is no setup object and no account-wide health machine. An agent binds
 * to its platform, holds that platform's sealed monitoring key, and its
 * `pull_production_calls` switch is the only stored monitoring choice in the
 * product. The switch opens one machine notebook — `monitoring_state` — and
 * the poller works from that notebook joined to the agent's own key (ADR-0015).
 *
 * Once a call arrives, nothing here owns it. Its evidence goes to the
 * write-ahead log, the object store and then the trace store, where committed
 * span identity is the exactly-once rule; there is no receipt book and no
 * failure list. What is left in Postgres is a retry clock and, for a call that
 * could not be turned into evidence, a bounded budget followed by an expiring
 * marker (ADR-0014).
 *
 * Push is not here at all, by design: the OTLP door authenticates with the
 * project key, stores and grades, and writes nothing down about having done it.
 */

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
export const MOST_RETELL_CALL_ATTEMPTS = 4;

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

/** What the pull switch says about one agent. No health, no progress bar. */
export type AgentPullState = {
  readonly agentId: string;
  readonly pullProductionCalls: boolean;
  readonly agentPlatform: AgentPlatform | null;
  readonly platformAgentId: string | null;
  readonly monitoringApiKeyHint: string | null;
  readonly scanKind: MonitoringScanKind | null;
  readonly lastReceivedAt: Date | null;
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
 *
 * **The deep import happens once, on an agent's first ever switch-on, and only
 * for Retell.** Turning the switch on again is a new observation of the
 * provider from that moment: a fresh `import_generation`, a `regular_floor_at`
 * at the switch, and no backfill of what happened while it was off. Pause and
 * resume do no backfill, deliberately — a customer who wants Egma to look
 * further back has to say so, and in v1 there is no way to say it twice.
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

  // Only Retell has a history Egma can read. A first switch-on there opens the
  // one fixed 30-day import; anything else starts level with the switch.
  const historical = input.agentPlatform === "retell";
  const [opened] = await tx
    .insert(monitoringState)
    .values({
      id: newId("mst"),
      agentId: input.agentId,
      organizationId: auth.organizationId,
      projectId,
      ...(historical
        ? {
            scanKind: "historical_import" as const,
            scanFrom: new Date(input.now.getTime() - HISTORY_MILLISECONDS),
            scanThrough: input.now,
          }
        : { regularFloorAt: input.now }),
      nextPollAt: input.now,
    })
    // A notebook already here means the switch has been on before, so this is
    // a resume rather than a first start: a new observation floored at now,
    // with the cursor of the window it stopped in dropped rather than carried.
    .onConflictDoUpdate({
      target: [monitoringState.agentId],
      set: {
        scanKind: null,
        scanFrom: null,
        scanThrough: null,
        paginationKey: null,
        paginationTrail: "[]",
        completedThrough: input.now,
        regularFloorAt: input.now,
        importGeneration: sql`${monitoringState.importGeneration} + 1`,
        nextPollAt: input.now,
        // The customer acted, which is the one thing that ends a park: a key
        // Retell refused is being offered again, and the ladder starts over.
        consecutiveFailures: 0,
        failureStartedAt: null,
        lastErrorKind: null,
        lastErrorAt: null,
        updatedAt: input.now,
      },
    })
    .returning({ importGeneration: monitoringState.importGeneration });

  // Transient call state belongs to the observation that wrote it. A new
  // generation reads none of it, so leaving it behind would be rows nothing
  // can ever look at again — and the claim's own in-flight check reads the
  // agent rather than the generation, so it has to be true that every row
  // still here belongs to the generation running now.
  if (opened !== undefined) {
    await tx
      .delete(retellCallRetry)
      .where(
        and(
          eq(retellCallRetry.agentId, input.agentId),
          lt(retellCallRetry.importGeneration, opened.importGeneration),
        ),
      );
  }
}

function boundPlatformAgentId(value: string): string {
  const platformAgentId = value.trim();
  if (platformAgentId === "") {
    throw new UnprocessableInputError(
      "The platform's own id for this agent is required to pull its calls.",
    );
  }
  return platformAgentId;
}

/**
 * Turn pull on for one agent: bind it to its platform, seal its monitoring
 * key, and open its notebook.
 *
 * The key is asked for even when a connection already holds one for the same
 * account. Simulation custody and monitoring custody are two jobs with two
 * secrets on purpose.
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
  const platformAgentId = boundPlatformAgentId(input.platformAgentId);
  const now = input.now ?? new Date();

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
    });
  });

  const state = await readAgentPullState(auth, input.agentId);
  if (state === undefined) throw new Error("The pull switch was not written");
  return state;
}

/**
 * Register one platform agent Egma does not know yet, and start pulling it —
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
 * held-name refusal are decided in one place for every agent Egma writes.
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
  const platformAgentId = boundPlatformAgentId(input.platformAgentId);
  const now = input.now ?? new Date();

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
    });
    return written.id;
  });

  const state = await readAgentPullState(auth, agentId);
  if (state === undefined) throw new Error("The pull switch was not written");
  return state;
}

/**
 * Turn pull off for one agent. The notebook survives — it is what a later
 * switch-on bumps rather than re-creates — and the poller stops claiming the
 * row because the switch, not the notebook, is what makes an agent due.
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
    lastReceivedAt: row.lastReceivedAt ?? null,
  };
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
   * and it can: turning the switch on again deletes the rows belonging to the
   * observation it replaces, so a row from a generation nothing reads cannot
   * exist.
   */
  readonly hasTransientCallState: boolean;
  readonly consecutiveFailures: number;
  readonly leaseOwner: string;
  readonly leaseExpiresAt: Date;
  readonly auth: AuthContext;
};

/**
 * Claim one due pulled agent before any provider request.
 *
 * Due-ness is the switch joined to the notebook: an agent whose switch is off
 * keeps its notebook and is never claimed. Backoff is per agent, so a shared
 * key that starts refusing is discovered independently by each agent's poll —
 * there is no account-wide gate to consult, because there is no account-wide
 * anything.
 *
 * The fixed window is decided here and then held: a scan already in flight is
 * resumed exactly as it was, and a new regular scan reaches five minutes back
 * from the last completed upper bound so that a call the provider exposed a
 * little late is still found. That subtraction has one limit — a floor, while
 * one is set, which a switch-on uses to stop the first window after it reaching
 * behind the moment the customer turned it on.
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
        agentId: monitoringState.agentId,
        organizationId: monitoringState.organizationId,
        projectId: monitoringState.projectId,
        platformAgentId: agent.platformAgentId,
        platformAgentName: agent.name,
        scanKind: monitoringState.scanKind,
        scanFrom: monitoringState.scanFrom,
        scanThrough: monitoringState.scanThrough,
        paginationKey: monitoringState.paginationKey,
        paginationTrail: monitoringState.paginationTrail,
        completedThrough: monitoringState.completedThrough,
        regularFloorAt: monitoringState.regularFloorAt,
        importGeneration: monitoringState.importGeneration,
        consecutiveFailures: monitoringState.consecutiveFailures,
        hasTransientCallState: sql<boolean>`exists (
          select 1 from ${retellCallRetry}
           where ${retellCallRetry.agentId} = ${monitoringState.agentId}
        )`,
        credentials: agent.monitoringApiKey,
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
          eq(agent.agentPlatform, "retell"),
          isNotNull(agent.platformAgentId),
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
      scanKind = "regular";
      const completed = candidate.completedThrough ?? now;
      const overlapped = new Date(
        completed.getTime() - REGULAR_OVERLAP_MILLISECONDS,
      );
      const floor = candidate.regularFloorAt;
      scanFrom =
        floor !== null && floor > overlapped ? floor : overlapped;
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
      platformAgentId: candidate.platformAgentId,
      credentials: candidate.credentials,
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
    apiKey: openedMonitoringKey(claimed.credentials),
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
  target: Pick<MonitoringPullTarget, "agentId" | "leaseOwner">,
  options: {
    readonly now?: Date | undefined;
    readonly leaseMilliseconds?: number | undefined;
  } = {},
): Promise<boolean> {
  const now = options.now ?? new Date();
  const expires = new Date(
    now.getTime() +
      (options.leaseMilliseconds ?? DEFAULT_LEASE_MILLISECONDS),
  );
  return db().transaction(async (tx) => {
    const [requestable] = await tx
      .select({ id: monitoringState.id })
      .from(monitoringState)
      .where(
        and(
          withinMonitoringProject(auth, monitoringState),
          eq(monitoringState.agentId, target.agentId),
          eq(monitoringState.leaseOwner, target.leaseOwner),
          isNotNull(monitoringState.leaseExpiresAt),
        ),
      )
      .for("update");
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
  target: Pick<
    MonitoringPullTarget,
    "agentId" | "leaseOwner" | "scanKind"
  >,
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
    .returning({ id: monitoringState.id });
  return updated.length === 1;
}

/**
 * Finish the fixed scan and release its lease.
 *
 * The completed upper bound moves here and only here, which is what makes the
 * next regular window start where this one stopped. The floor is cleared at the
 * same moment: a window has now completed above it, so later polls regain the
 * ordinary five-minute overlap.
 *
 * A success ends this agent's cool-down: the retry clock returns to zero and
 * the last refusal is forgotten, which is what lets a parked key start pulling
 * again the moment the provider answers. Nothing about it is a health word — no
 * screen reads these columns.
 */
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
  return db().transaction(async (tx) => {
    const [held] = await tx
      .select({ id: monitoringState.id })
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
    const updated = await tx
      .update(monitoringState)
      .set({
        scanKind: null,
        scanFrom: null,
        scanThrough: null,
        paginationKey: null,
        paginationTrail: "[]",
        completedThrough: target.scanThrough,
        regularFloorAt: null,
        nextPollAt: scheduledNextPollAt,
        leaseOwner: null,
        leaseExpiresAt: null,
        consecutiveFailures: 0,
        failureStartedAt: null,
        lastErrorKind: null,
        lastErrorAt: null,
        lastSuccessAt: now,
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
 * Record one provider refusal against this agent and release its lease.
 *
 * **The cool-down is per agent, and it is a clock rather than a condition.**
 * `consecutive_failures` is the exponent of the backoff ladder and nothing
 * else; `next_poll_at` is where the ladder puts this agent. No screen reads
 * either, and there is no account-wide gate to raise — a sealed key on one
 * agent is unrecognizable as the same key sealed on another, so a shared key
 * that starts refusing is discovered independently by each agent's poll.
 *
 * **A refused key parks until the customer acts.** A lesser failure may not
 * shorten a longer park: once Retell has said the key is wrong, a rate limit
 * arriving afterwards cannot bring the next poll forward. Rotating the key or
 * turning the switch on again is what ends it, because that is the customer
 * doing the one thing that could make the answer different.
 */
export async function failMonitoringPull(
  auth: AuthContext,
  target: MonitoringPullTarget,
  input: {
    readonly kind: MonitoringFailureKind;
    readonly retryAt: Date;
    readonly now?: Date | undefined;
  },
): Promise<{
  readonly changed: boolean;
  readonly failures: number;
  readonly startedAt: Date;
}> {
  const now = input.now ?? new Date();
  return db().transaction(async (tx) => {
    const [held] = await tx
      .select({
        credentials: agent.monitoringApiKey,
        nextPollAt: monitoringState.nextPollAt,
        lastErrorKind: monitoringState.lastErrorKind,
        failureStartedAt: monitoringState.failureStartedAt,
        consecutiveFailures: monitoringState.consecutiveFailures,
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
    if (held === undefined) {
      return { changed: false, failures: 0, startedAt: now };
    }
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
      return {
        changed: false,
        failures: held.consecutiveFailures,
        startedAt: held.failureStartedAt ?? now,
      };
    }
    const keepExistingPark =
      input.kind !== "invalid_credential" &&
      (held.lastErrorKind === "invalid_credential" ||
        held.nextPollAt > input.retryAt);
    const lastErrorKind = keepExistingPark ? held.lastErrorKind : input.kind;
    const nextPollAt = keepExistingPark ? held.nextPollAt : input.retryAt;
    const changed = held.lastErrorKind !== lastErrorKind;
    const startedAt = held.failureStartedAt ?? now;
    const failures = held.consecutiveFailures + 1;
    await tx
      .update(monitoringState)
      .set({
        nextPollAt,
        leaseOwner: null,
        leaseExpiresAt: null,
        consecutiveFailures: failures,
        failureStartedAt: startedAt,
        lastErrorKind,
        lastErrorAt: now,
        updatedAt: now,
      })
      .where(
        and(
          withinMonitoringProject(auth, monitoringState),
          eq(monitoringState.agentId, target.agentId),
          eq(monitoringState.leaseOwner, target.leaseOwner),
        ),
      );
    return { changed, failures, startedAt };
  });
}

/**
 * Release a lease after a call-only failure without moving its fixed scan.
 *
 * **The retry clock does not climb here.** `consecutive_failures` means "the
 * provider refused this agent", and what reaches this function is neither
 * refusal nor rate limit — a broken page contract, an unreadable call id, an
 * internal fault. Counting it would push the ladder out for something the
 * provider never said no to. The plain retry the caller passes is the whole
 * answer.
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
              lastErrorKind: input.errorKind,
              lastErrorAt: now,
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

/**
 * Move "last heard from" forward for one pulled agent, and never backward.
 *
 * **The merge is monotone, and it has to be.** Evidence becomes durable in one
 * order and is drained in another, and the instant a caller passes is the one
 * the evidence was *received* rather than the one it is being written at — so a
 * replayed segment or a historical import carries an older instant than the row
 * already holds. A plain assignment would answer a customer's "last production
 * conversation" by winding it back to a call from an hour ago. `greatest` keeps
 * whichever instant is later, and the `coalesce` is what makes the first write
 * work at all: a column that has never been written is null, and
 * `greatest(null, x)` is null in Postgres.
 *
 * **Only pull has a row to stamp.** A pushing agent writes nothing down — the
 * OTLP door stores and grades and keeps no bookkeeping — so a drained segment
 * that names no pulled platform agent moves nothing here, deliberately.
 *
 * Batched by construction: the caller names a platform agent, never a call. One
 * drained segment carrying two hundred conversations of one agent is one
 * statement here.
 */
export async function recordPulledCallReceived(
  auth: AuthContext,
  input: {
    readonly agentPlatform: AgentPlatform;
    readonly platformAgentId?: string | undefined;
    readonly receivedAt: Date;
  },
): Promise<void> {
  if (auth.projectId === undefined) return;
  const platformAgentId = input.platformAgentId;
  if (platformAgentId === undefined || platformAgentId === "") return;
  const { receivedAt } = input;
  // When the row was touched, which is a different fact from when the evidence
  // was received: a replayed segment carries an old `receivedAt` and is
  // happening now, and a row stamped with the older of the two would report
  // that nothing has changed since.
  const touchedAt = new Date();

  await db()
    .update(monitoringState)
    .set({
      lastReceivedAt: sql`greatest(coalesce(${monitoringState.lastReceivedAt}, ${receivedAt}), ${receivedAt})`,
      updatedAt: touchedAt,
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
                within(auth, agent, eq(agent.projectId, auth.projectId)),
                eq(agent.agentPlatform, input.agentPlatform),
                eq(agent.platformAgentId, platformAgentId),
              ),
            ),
        ),
      ),
    );
}

/* ------------------------------------------------------------------- *
 * Transient Retell call state: a bounded budget, then an expiring mark.
 *
 * Everything below is about calls that did **not** work. A call that lands
 * writes nothing here and nothing anywhere else in Postgres: its evidence is in
 * the object store and then in the trace store, and a receipt row for every
 * successful conversation is exactly the second permanent telemetry store this
 * release removes.
 * ------------------------------------------------------------------- */

/** One listed call Egma is still trying, or has recently given up on. */
export type TransientRetellCall = {
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
  providerCallId: retellCallRetry.providerCallId,
  attempts: retellCallRetry.attempts,
  errorKind: retellCallRetry.errorKind,
  nextAttemptAt: retellCallRetry.nextAttemptAt,
  expiresAt: retellCallRetry.expiresAt,
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
    isNotNull(retellCallRetry.nextAttemptAt),
    sql`${retellCallRetry.expiresAt} > ${now}`,
  ) as SQL;
}

function transientOf(row: TransientRow): TransientRetellCall {
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
 * **Scoped to one import generation.** Selecting the agent again is a new,
 * deliberate observation of the provider's history, so state written under an
 * earlier generation is invisible here and the new import may take its own
 * bounded look. An ordinary repeated poll carries the same generation and sees
 * everything, which is the difference the whole rule turns on.
 */
export async function transientRetellCallState(
  auth: AuthContext,
  input: {
    readonly agentId: string;
    readonly providerCallIds: readonly string[];
    readonly importGeneration: number;
    readonly now?: Date | undefined;
  },
): Promise<ReadonlyMap<string, TransientRetellCall>> {
  if (input.providerCallIds.length === 0) return new Map();
  const now = input.now ?? new Date();
  const rows = await db()
    .select(TRANSIENT_COLUMNS)
    .from(retellCallRetry)
    .where(
      and(
        withinMonitoringProject(auth, retellCallRetry),
        eq(retellCallRetry.agentId, input.agentId),
        eq(retellCallRetry.importGeneration, input.importGeneration),
        inArray(retellCallRetry.providerCallId, [...input.providerCallIds]),
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
export async function dueRetellCallRetries(
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
): Promise<readonly TransientRetellCall[]> {
  const now = input.now ?? new Date();
  const rows = await db()
    .select(TRANSIENT_COLUMNS)
    .from(retellCallRetry)
    .where(
      and(
        withinMonitoringProject(auth, retellCallRetry),
        eq(retellCallRetry.agentId, input.agentId),
        eq(retellCallRetry.importGeneration, input.importGeneration),
        isNotNull(retellCallRetry.nextAttemptAt),
        lte(retellCallRetry.nextAttemptAt, now),
      ),
    )
    .orderBy(asc(retellCallRetry.nextAttemptAt), asc(retellCallRetry.id))
    .limit(input.limit);
  return rows.map(transientOf);
}

/** What one counted attempt did. */
export type RetellCallAttemptOutcome =
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
export async function recordRetellCallAttempt(
  auth: AuthContext,
  target: Pick<
    MonitoringPullTarget,
    "agentId" | "leaseOwner" | "importGeneration"
  >,
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
): Promise<RetellCallAttemptOutcome> {
  const now = input.now ?? new Date();
  const projectId = projectOf(auth);
  return db().transaction(async (tx) => {
    const [owned] = await tx
      .select({ id: monitoringState.id })
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
        id: retellCallRetry.id,
        attempts: retellCallRetry.attempts,
        nextAttemptAt: retellCallRetry.nextAttemptAt,
        expiresAt: retellCallRetry.expiresAt,
        importGeneration: retellCallRetry.importGeneration,
      })
      .from(retellCallRetry)
      .where(
        and(
          withinMonitoringProject(auth, retellCallRetry),
          eq(retellCallRetry.providerCallId, input.providerCallId),
        ),
      )
      .for("update");

    const carries =
      held !== undefined &&
      held.importGeneration === target.importGeneration &&
      (held.nextAttemptAt !== null ||
        (held.expiresAt !== null && held.expiresAt > now));
    const attempts = carries ? held.attempts + 1 : 1;
    const dropped = attempts >= MOST_RETELL_CALL_ATTEMPTS;
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
      await tx.insert(retellCallRetry).values({
        id: newId("rcr"),
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
        .update(retellCallRetry)
        .set({
          agentId: target.agentId,
          errorKind: input.errorKind,
          attempts,
          lastAttemptAt: now,
          importGeneration: target.importGeneration,
          ...schedule,
        })
        .where(eq(retellCallRetry.id, held.id));
    }

    // The notebook keeps the class of the last thing that went wrong, and
    // nothing more. There is no customer-visible condition to move: giving up
    // on one call is one structured event and one counter, and the product
    // surface says nothing about it (ADR-0014, ruling 3 and ruling 6).
    await tx
      .update(monitoringState)
      .set({
        lastErrorKind: input.errorKind,
        lastErrorAt: now,
        updatedAt: now,
      })
      .where(
        and(
          withinMonitoringProject(auth, monitoringState),
          eq(monitoringState.agentId, target.agentId),
          eq(monitoringState.leaseOwner, target.leaseOwner),
        ),
      );

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
 * `recordRetellCallAttempt` finds and reassigns it by: two pulled agents that
 * both meet one provider call keep one row and one budget, so whichever agent
 * makes that call durable is the one that clears it.
 */
export async function deleteRetellCallRetry(
  auth: AuthContext,
  input: { readonly providerCallId: string },
): Promise<void> {
  await db()
    .delete(retellCallRetry)
    .where(
      and(
        withinMonitoringProject(auth, retellCallRetry),
        eq(retellCallRetry.providerCallId, input.providerCallId),
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
export async function sweepExpiredRetellCallMarkers(
  auth: AuthContext,
  input: {
    readonly agentId: string;
    readonly now?: Date | undefined;
  },
): Promise<number> {
  const now = input.now ?? new Date();
  const swept = await db()
    .delete(retellCallRetry)
    .where(
      and(
        withinMonitoringProject(auth, retellCallRetry),
        eq(retellCallRetry.agentId, input.agentId),
        isNotNull(retellCallRetry.expiresAt),
        lte(retellCallRetry.expiresAt, now),
      ),
    )
    .returning({ id: retellCallRetry.id });
  return swept.length;
}
