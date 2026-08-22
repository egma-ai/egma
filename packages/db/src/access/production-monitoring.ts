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
  notInArray,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import type { AnyPgColumn, PgTable } from "drizzle-orm/pg-core";

import { db } from "../client.ts";
import {
  monitoringSetup,
  retellCallRetry,
  retellMonitoredAgent,
  type MonitoringHealthState,
  type MonitoringPlatform,
  type MonitoringStrategy,
  type RetellMonitoredAgentState,
  type RetellScanKind,
} from "../schema/production.ts";
import { openCredentials, sealCredentials } from "../sealing.ts";
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
      "Monitoring setup belongs to one project. Select a project first.",
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

function retellKey(value: unknown): string {
  if (typeof value !== "string") {
    throw new UnprocessableInputError("Retell API key must be text.");
  }
  const key = value.trim();
  if (key.length < SHORTEST_KEY) {
    throw new UnprocessableInputError(
      "Retell API key is shorter than any key Retell issues.",
    );
  }
  return key;
}

export type SelectedRetellAgent = {
  readonly platformAgentId: string;
  readonly platformAgentName: string;
};

function selectedAgents(
  values: readonly SelectedRetellAgent[],
): readonly SelectedRetellAgent[] {
  if (values.length === 0) {
    throw new UnprocessableInputError(
      "Select at least one Retell voice agent to monitor.",
    );
  }
  const seen = new Set<string>();
  return values.map((value) => {
    const platformAgentId = value.platformAgentId.trim();
    const platformAgentName = value.platformAgentName.trim();
    if (platformAgentId === "" || platformAgentName === "") {
      throw new UnprocessableInputError(
        "Every selected Retell agent needs its Retell id and name.",
      );
    }
    if (seen.has(platformAgentId)) {
      throw new UnprocessableInputError(
        `Retell agent ${platformAgentId} was selected more than once.`,
      );
    }
    seen.add(platformAgentId);
    return { platformAgentId, platformAgentName };
  });
}

export type RetellMonitoredAgent = {
  readonly id: string;
  readonly platformAgentId: string;
  readonly platformAgentName: string;
  readonly state: RetellMonitoredAgentState;
  readonly scanKind: RetellScanKind | null;
  readonly lastSuccessAt: Date | null;
  readonly lastCallReceivedAt: Date | null;
  readonly lastErrorKind: string | null;
  readonly lastErrorAt: Date | null;
  readonly consecutiveFailures: number;
};

export type MonitoringSetup = {
  readonly id: string;
  readonly projectId: string;
  readonly agentPlatform: MonitoringPlatform;
  readonly strategy: MonitoringStrategy;
  readonly credentialsHint: string | null;
  readonly healthState: MonitoringHealthState;
  readonly blockedUntil: Date | null;
  readonly consecutiveFailures: number;
  readonly lastErrorAt: Date | null;
  readonly lastRecoveredAt: Date | null;
  readonly lastReceivedAt: Date | null;
  readonly agents: readonly RetellMonitoredAgent[];
};

/** Read Monitoring setup state. No credential column is selected. */
export async function listMonitoringSetups(
  auth: AuthContext,
): Promise<readonly MonitoringSetup[]> {
  authorize(auth, "read", here(auth));
  const setups = await db()
    .select({
      id: monitoringSetup.id,
      projectId: monitoringSetup.projectId,
      agentPlatform: monitoringSetup.agentPlatform,
      strategy: monitoringSetup.strategy,
      credentialsHint: monitoringSetup.credentialsHint,
      healthState: monitoringSetup.healthState,
      blockedUntil: monitoringSetup.blockedUntil,
      consecutiveFailures: monitoringSetup.consecutiveFailures,
      lastErrorAt: monitoringSetup.lastErrorAt,
      lastRecoveredAt: monitoringSetup.lastRecoveredAt,
      lastReceivedAt: monitoringSetup.lastReceivedAt,
    })
    .from(monitoringSetup)
    .where(withinMonitoringProject(auth, monitoringSetup))
    .orderBy(asc(monitoringSetup.agentPlatform));

  if (setups.length === 0) return [];
  const agents = await db()
    .select({
      id: retellMonitoredAgent.id,
      monitoringSetupId: retellMonitoredAgent.monitoringSetupId,
      platformAgentId: retellMonitoredAgent.platformAgentId,
      platformAgentName: retellMonitoredAgent.platformAgentName,
      state: retellMonitoredAgent.state,
      scanKind: retellMonitoredAgent.scanKind,
      lastSuccessAt: retellMonitoredAgent.lastSuccessAt,
      lastCallReceivedAt: retellMonitoredAgent.lastCallReceivedAt,
      lastErrorKind: retellMonitoredAgent.lastErrorKind,
      lastErrorAt: retellMonitoredAgent.lastErrorAt,
      consecutiveFailures: retellMonitoredAgent.consecutiveFailures,
    })
    .from(retellMonitoredAgent)
    .where(
      and(
        withinMonitoringProject(auth, retellMonitoredAgent),
        inArray(
          retellMonitoredAgent.monitoringSetupId,
          setups.map((setup) => setup.id),
        ),
      ),
    )
    .orderBy(asc(retellMonitoredAgent.platformAgentName));

  return setups.map((setup) => ({
    ...setup,
    agentPlatform: setup.agentPlatform as MonitoringPlatform,
    strategy: setup.strategy as MonitoringStrategy,
    healthState: setup.healthState as MonitoringHealthState,
    agents: agents
      .filter((agent) => agent.monitoringSetupId === setup.id)
      .map(({ monitoringSetupId: _setupId, ...agent }) => ({
        ...agent,
        state: agent.state as RetellMonitoredAgentState,
        scanKind: agent.scanKind as RetellScanKind | null,
      })),
  }));
}

/**
 * Create or rotate Retell setup and synchronize its selected voice agents.
 *
 * **Selecting an agent is always the request for one fixed 30-day import**, on
 * the first save and on every later one. That is the whole deep-backfill story:
 * there is no scheduled reconciliation and no automatic backfill deeper than
 * the regular five-minute overlap, so a customer who wants Egma to look further
 * back selects the agent again and gets exactly that, deliberately.
 *
 * A re-selection is therefore a new **import generation**: the window, cursor
 * and trail are re-armed, and transient call state written under an earlier
 * generation stops applying. A call an earlier regular scan gave up on is
 * allowed one new bounded look, while an ordinary repeated poll — which is the
 * same observation rather than a new one — still is not.
 */
export async function configureRetellMonitoring(
  auth: AuthContext,
  input: {
    readonly apiKey: unknown;
    readonly agents: readonly SelectedRetellAgent[];
    readonly now?: Date | undefined;
  },
): Promise<MonitoringSetup> {
  authorize(auth, "configure_monitoring", here(auth));
  const projectId = projectOf(auth);
  const apiKey = retellKey(input.apiKey);
  const agents = selectedAgents(input.agents);
  const now = input.now ?? new Date();
  const historyFrom = new Date(now.getTime() - HISTORY_MILLISECONDS);

  await db().transaction(async (tx) => {
    // There is no setup row to lock on the first save. Serialize this one
    // project's Retell setup before the read, so two first saves do not both
    // decide that they must insert it. The lock ends with this transaction.
    const setupLock = `${auth.organizationId}:${projectId}:retell-monitoring`;
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${setupLock}::text, 0))`,
    );

    const [held] = await tx
      .select({ id: monitoringSetup.id })
      .from(monitoringSetup)
      .where(
        and(
          withinMonitoringProject(auth, monitoringSetup),
          eq(monitoringSetup.projectId, projectId),
          eq(monitoringSetup.agentPlatform, "retell"),
        ),
      )
      .for("update");

    const sealed = sealCredentials({ apiKey });
    const setupId = held?.id ?? newId("mns");
    if (held === undefined) {
      await tx.insert(monitoringSetup).values({
        id: setupId,
        organizationId: auth.organizationId,
        projectId,
        agentPlatform: "retell",
        strategy: "retell_api_polling",
        credentials: sealed,
        credentialsHint: apiKey.slice(-HINT_CHARACTERS),
        createdBy: auth.userId,
      });
    } else {
      await tx
        .update(monitoringSetup)
        .set({
          credentials: sealed,
          credentialsHint: apiKey.slice(-HINT_CHARACTERS),
          healthState: "healthy",
          blockedUntil: null,
          failureStartedAt: null,
          consecutiveFailures: 0,
          lastErrorAt: null,
          updatedAt: now,
        })
        .where(eq(monitoringSetup.id, setupId));
    }

    const selectedIds = agents.map((agent) => agent.platformAgentId);
    await tx
      .delete(retellMonitoredAgent)
      .where(
        and(
          eq(retellMonitoredAgent.monitoringSetupId, setupId),
          notInArray(retellMonitoredAgent.platformAgentId, selectedIds),
        ),
      );

    for (const selected of agents) {
      const rearmed = await tx
        .insert(retellMonitoredAgent)
        .values({
          id: newId("rma"),
          monitoringSetupId: setupId,
          organizationId: auth.organizationId,
          projectId,
          platformAgentId: selected.platformAgentId,
          platformAgentName: selected.platformAgentName,
          state: "importing",
          scanKind: "historical_import",
          scanFrom: historyFrom,
          scanThrough: now,
          nextPollAt: now,
        })
        .onConflictDoUpdate({
          target: [
            retellMonitoredAgent.monitoringSetupId,
            retellMonitoredAgent.platformAgentId,
          ],
          set: {
            platformAgentName: selected.platformAgentName,
            state: "importing",
            scanKind: "historical_import",
            scanFrom: historyFrom,
            scanThrough: now,
            paginationKey: null,
            paginationTrail: "[]",
            // A fixed window is being re-armed, so any lease over the old one
            // is void: whoever holds it is paging a scan that no longer exists,
            // and every write it makes is refused by its own owner check.
            leaseOwner: null,
            leaseExpiresAt: null,
            // The import ends above the floor by construction — it runs to
            // `now` — so a cutover floor left over from an earlier release has
            // nothing left to hold back.
            regularFloorAt: null,
            importGeneration: sql`${retellMonitoredAgent.importGeneration} + 1`,
            nextPollAt: now,
            consecutiveFailures: 0,
            lastErrorKind: null,
            lastErrorAt: null,
            updatedAt: now,
          },
        })
        .returning({ id: retellMonitoredAgent.id });

      // The new generation cannot see the old one's transient rows, so leaving
      // them would leave rows nothing reads, nothing sweeps and nothing can
      // ever delete — while the two existence checks below, which ask about
      // the agent rather than about a generation, would keep reporting a
      // selected agent as degraded for work no longer owed. They go with the
      // window they belonged to, in the transaction that replaces it.
      await tx
        .delete(retellCallRetry)
        .where(
          and(
            withinMonitoringProject(auth, retellCallRetry),
            eq(retellCallRetry.retellMonitoredAgentId, rearmed[0]?.id ?? ""),
          ),
        );
    }
  });

  const configured = (await listMonitoringSetups(auth)).find(
    (setup) => setup.agentPlatform === "retell",
  );
  if (configured === undefined) throw new Error("Retell Monitoring setup was not written");
  return configured;
}

/** Mark LiveKit Agents Monitoring as configured for this project. */
export async function configureLiveKitMonitoring(
  auth: AuthContext,
): Promise<MonitoringSetup> {
  authorize(auth, "configure_monitoring", here(auth));
  const projectId = projectOf(auth);
  await db()
    .insert(monitoringSetup)
    .values({
      id: newId("mns"),
      organizationId: auth.organizationId,
      projectId,
      agentPlatform: "livekit_agents",
      strategy: "livekit_otlp",
      createdBy: auth.userId,
    })
    .onConflictDoUpdate({
      target: [monitoringSetup.projectId, monitoringSetup.agentPlatform],
      set: { updatedAt: new Date() },
    });
  const configured = (await listMonitoringSetups(auth)).find(
    (setup) => setup.agentPlatform === "livekit_agents",
  );
  if (configured === undefined) throw new Error("LiveKit Monitoring setup was not written");
  return configured;
}

/** Remove setup and polling state. Stored traces and Retell call claims remain. */
export async function removeMonitoringSetup(
  auth: AuthContext,
  agentPlatform: MonitoringPlatform,
): Promise<boolean> {
  authorize(auth, "configure_monitoring", here(auth));
  const projectId = projectOf(auth);
  const deleted = await db()
    .delete(monitoringSetup)
    .where(
      and(
        withinMonitoringProject(auth, monitoringSetup),
        eq(monitoringSetup.projectId, projectId),
        eq(monitoringSetup.agentPlatform, agentPlatform),
      ),
    )
    .returning({ id: monitoringSetup.id });
  return deleted.length > 0;
}

function openedRetellKey(envelope: string): string {
  const opened = openCredentials(envelope);
  if (
    typeof opened !== "object" ||
    opened === null ||
    Array.isArray(opened) ||
    typeof (opened as { apiKey?: unknown }).apiKey !== "string"
  ) {
    throw new Error("Retell Monitoring credential is unreadable");
  }
  return (opened as { apiKey: string }).apiKey;
}

export type RetellMonitoringTarget = {
  readonly setupId: string;
  readonly monitoredAgentId: string;
  readonly platformAgentId: string;
  readonly platformAgentName: string;
  readonly apiKey: string;
  readonly scanKind: RetellScanKind;
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
   * and it can: re-selecting an agent deletes the rows belonging to the window
   * it replaces, so a row from a generation nothing reads cannot exist.
   */
  readonly hasTransientCallState: boolean;
  readonly setupConsecutiveFailures: number;
  readonly leaseOwner: string;
  readonly leaseExpiresAt: Date;
  readonly auth: AuthContext;
};

/**
 * Claim one due Retell target before any provider request.
 *
 * The fixed window is decided here and then held: a scan already in flight is
 * resumed exactly as it was, and a new regular scan reaches five minutes back
 * from the last completed upper bound so that a call the provider exposed a
 * little late is still found. That subtraction has one limit — a floor, while
 * one is set, which a cutover uses to stop the first window after it reaching
 * behind the release.
 */
export async function claimDueRetellMonitoringAgent(
  options: {
    readonly now?: Date | undefined;
    readonly leaseMilliseconds?: number | undefined;
  } = {},
): Promise<RetellMonitoringTarget | undefined> {
  const now = options.now ?? new Date();
  const leaseMilliseconds =
    options.leaseMilliseconds ?? DEFAULT_LEASE_MILLISECONDS;
  const leaseOwner = randomUUID();
  const leaseExpiresAt = new Date(now.getTime() + leaseMilliseconds);

  const claimed = await db().transaction(async (tx) => {
    const [candidate] = await tx
      .select({
        id: retellMonitoredAgent.id,
        setupId: retellMonitoredAgent.monitoringSetupId,
        organizationId: retellMonitoredAgent.organizationId,
        projectId: retellMonitoredAgent.projectId,
        platformAgentId: retellMonitoredAgent.platformAgentId,
        platformAgentName: retellMonitoredAgent.platformAgentName,
        state: retellMonitoredAgent.state,
        scanKind: retellMonitoredAgent.scanKind,
        scanFrom: retellMonitoredAgent.scanFrom,
        scanThrough: retellMonitoredAgent.scanThrough,
        paginationKey: retellMonitoredAgent.paginationKey,
        paginationTrail: retellMonitoredAgent.paginationTrail,
        completedThrough: retellMonitoredAgent.completedThrough,
        regularFloorAt: retellMonitoredAgent.regularFloorAt,
        importGeneration: retellMonitoredAgent.importGeneration,
        hasTransientCallState: sql<boolean>`exists (
          select 1 from ${retellCallRetry}
           where ${retellCallRetry.retellMonitoredAgentId} = ${retellMonitoredAgent.id}
        )`,
        credentials: monitoringSetup.credentials,
        setupConsecutiveFailures: monitoringSetup.consecutiveFailures,
      })
      .from(retellMonitoredAgent)
      .innerJoin(
        monitoringSetup,
        and(
          eq(monitoringSetup.id, retellMonitoredAgent.monitoringSetupId),
          eq(monitoringSetup.projectId, retellMonitoredAgent.projectId),
          eq(
            monitoringSetup.organizationId,
            retellMonitoredAgent.organizationId,
          ),
        ),
      )
      .where(
        and(
          eq(monitoringSetup.agentPlatform, "retell"),
          lte(retellMonitoredAgent.nextPollAt, now),
          or(
            isNull(retellMonitoredAgent.leaseExpiresAt),
            lte(retellMonitoredAgent.leaseExpiresAt, now),
          ),
          or(isNull(monitoringSetup.blockedUntil), lte(monitoringSetup.blockedUntil, now)),
        ),
      )
      .orderBy(asc(retellMonitoredAgent.nextPollAt), asc(retellMonitoredAgent.id))
      .limit(1)
      .for("update", { of: retellMonitoredAgent, skipLocked: true });
    if (candidate === undefined || candidate.credentials === null) return undefined;

    let scanKind = candidate.scanKind as RetellScanKind | null;
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
      .update(retellMonitoredAgent)
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
      .where(eq(retellMonitoredAgent.id, candidate.id));

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
    setupId: claimed.setupId,
    monitoredAgentId: claimed.id,
    platformAgentId: claimed.platformAgentId,
    platformAgentName: claimed.platformAgentName,
    apiKey: openedRetellKey(claimed.credentials as string),
    scanKind: claimed.scanKind,
    scanFrom: claimed.scanFrom,
    scanThrough: claimed.scanThrough,
    paginationKey: claimed.paginationKey,
    seenPaginationKeys: claimed.seenPaginationKeys,
    importGeneration: claimed.importGeneration,
    hasTransientCallState: claimed.hasTransientCallState,
    setupConsecutiveFailures: claimed.setupConsecutiveFailures,
    leaseOwner: claimed.leaseOwner,
    leaseExpiresAt: claimed.leaseExpiresAt,
    auth: monitoringContext(claimed.organizationId, claimed.projectId),
  };
}

export async function renewRetellMonitoringLease(
  auth: AuthContext,
  target: Pick<RetellMonitoringTarget, "monitoredAgentId" | "leaseOwner">,
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
      .select({ id: retellMonitoredAgent.id })
      .from(retellMonitoredAgent)
      .innerJoin(
        monitoringSetup,
        eq(monitoringSetup.id, retellMonitoredAgent.monitoringSetupId),
      )
      .where(
        and(
          withinMonitoringProject(auth, retellMonitoredAgent),
          withinMonitoringProject(auth, monitoringSetup),
          eq(retellMonitoredAgent.id, target.monitoredAgentId),
          eq(retellMonitoredAgent.leaseOwner, target.leaseOwner),
          isNotNull(retellMonitoredAgent.leaseExpiresAt),
          or(
            isNull(monitoringSetup.blockedUntil),
            lte(monitoringSetup.blockedUntil, now),
          ),
        ),
      )
      .for("update", { of: retellMonitoredAgent });
    if (requestable === undefined) return false;
    const renewed = await tx
      .update(retellMonitoredAgent)
      .set({ leaseExpiresAt: expires, updatedAt: now })
      .where(
        and(
          withinMonitoringProject(auth, retellMonitoredAgent),
          eq(retellMonitoredAgent.id, target.monitoredAgentId),
          eq(retellMonitoredAgent.leaseOwner, target.leaseOwner),
        ),
      )
      .returning({ id: retellMonitoredAgent.id });
    return renewed.length === 1;
  });
}

/** Save an opaque provider cursor only after every call on that page is durable. */
export async function checkpointRetellMonitoringPage(
  auth: AuthContext,
  target: Pick<RetellMonitoringTarget, "monitoredAgentId" | "leaseOwner">,
  input: {
    readonly paginationKey: string;
    readonly seenPaginationKeys: readonly string[];
  },
): Promise<boolean> {
  const updated = await db()
    .update(retellMonitoredAgent)
    .set({
      paginationKey: input.paginationKey,
      paginationTrail: JSON.stringify(input.seenPaginationKeys),
      updatedAt: new Date(),
    })
    .where(
      and(
        withinMonitoringProject(auth, retellMonitoredAgent),
        eq(retellMonitoredAgent.id, target.monitoredAgentId),
        eq(retellMonitoredAgent.leaseOwner, target.leaseOwner),
      ),
    )
    .returning({ id: retellMonitoredAgent.id });
  return updated.length === 1;
}

/** Yield bounded work without treating a healthy backlog as a failure. */
export async function yieldRetellMonitoringLease(
  auth: AuthContext,
  target: Pick<
    RetellMonitoringTarget,
    "monitoredAgentId" | "leaseOwner" | "scanKind"
  >,
  input: {
    readonly retryAt: Date;
    readonly now?: Date | undefined;
  },
): Promise<boolean> {
  const now = input.now ?? new Date();
  const updated = await db()
    .update(retellMonitoredAgent)
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
        withinMonitoringProject(auth, retellMonitoredAgent),
        eq(retellMonitoredAgent.id, target.monitoredAgentId),
        eq(retellMonitoredAgent.leaseOwner, target.leaseOwner),
      ),
    )
    .returning({ id: retellMonitoredAgent.id });
  return updated.length === 1;
}

/**
 * Finish the fixed scan and release its lease.
 *
 * The completed upper bound moves here and only here, which is what makes the
 * next regular window start where this one stopped. The floor is cleared at the
 * same moment: a window has now completed above it, so later polls regain the
 * ordinary five-minute overlap.
 */
export async function finishRetellMonitoringScan(
  auth: AuthContext,
  target: RetellMonitoringTarget,
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
      .select({ id: retellMonitoredAgent.id })
      .from(retellMonitoredAgent)
      .where(
        and(
          withinMonitoringProject(auth, retellMonitoredAgent),
          eq(retellMonitoredAgent.id, target.monitoredAgentId),
          eq(retellMonitoredAgent.leaseOwner, target.leaseOwner),
        ),
      )
      .for("update");
    if (held === undefined) return false;
    const degraded = await hasRetellCallInFlight(
      tx,
      auth,
      target.monitoredAgentId,
    );
    const updated = await tx
      .update(retellMonitoredAgent)
      .set({
        state: degraded ? "degraded" : "active",
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
        ...(degraded ? {} : { lastErrorKind: null, lastErrorAt: null }),
        lastSuccessAt: now,
        updatedAt: now,
      })
      .where(
        and(
          withinMonitoringProject(auth, retellMonitoredAgent),
          eq(retellMonitoredAgent.id, target.monitoredAgentId),
          eq(retellMonitoredAgent.leaseOwner, target.leaseOwner),
        ),
      )
      .returning({ id: retellMonitoredAgent.id });
    return updated.length === 1;
  });
}

export type MonitoringFailureKind =
  | "invalid_credential"
  | "rate_limited"
  | "provider_unavailable";

/** Record one setup-wide provider failure and release this target. */
export async function failRetellMonitoringTarget(
  auth: AuthContext,
  target: RetellMonitoringTarget,
  input: {
    readonly kind: MonitoringFailureKind;
    readonly retryAt: Date;
    readonly now?: Date | undefined;
  },
): Promise<{ readonly changed: boolean; readonly failures: number; readonly startedAt: Date }> {
  const now = input.now ?? new Date();
  return db().transaction(async (tx) => {
    const [held] = await tx
      .select({
        credentials: monitoringSetup.credentials,
        healthState: monitoringSetup.healthState,
        blockedUntil: monitoringSetup.blockedUntil,
        failureStartedAt: monitoringSetup.failureStartedAt,
        consecutiveFailures: monitoringSetup.consecutiveFailures,
      })
      .from(monitoringSetup)
      .where(
        and(withinMonitoringProject(auth, monitoringSetup), eq(monitoringSetup.id, target.setupId)),
      )
      .for("update");
    if (held === undefined) {
      return { changed: false, failures: 0, startedAt: now };
    }
    if (
      held.credentials === null ||
      openedRetellKey(held.credentials) !== target.apiKey
    ) {
      await tx
        .update(retellMonitoredAgent)
        .set({
          nextPollAt: now,
          leaseOwner: null,
          leaseExpiresAt: null,
          updatedAt: now,
        })
        .where(
          and(
            withinMonitoringProject(auth, retellMonitoredAgent),
            eq(retellMonitoredAgent.id, target.monitoredAgentId),
            eq(retellMonitoredAgent.monitoringSetupId, target.setupId),
            eq(retellMonitoredAgent.leaseOwner, target.leaseOwner),
          ),
        );
      return {
        changed: false,
        failures: held.consecutiveFailures,
        startedAt: held.failureStartedAt ?? now,
      };
    }
    const [leased] = await tx
      .select({ id: retellMonitoredAgent.id })
      .from(retellMonitoredAgent)
      .where(
        and(
          withinMonitoringProject(auth, retellMonitoredAgent),
          eq(retellMonitoredAgent.id, target.monitoredAgentId),
          eq(retellMonitoredAgent.monitoringSetupId, target.setupId),
          eq(retellMonitoredAgent.leaseOwner, target.leaseOwner),
        ),
      )
      .for("update");
    if (leased === undefined) {
      return {
        changed: false,
        failures: held.consecutiveFailures,
        startedAt: held.failureStartedAt ?? now,
      };
    }
    const keepExistingGate =
      input.kind !== "invalid_credential" &&
      (held.healthState === "invalid_credential" ||
        (held.blockedUntil !== null && held.blockedUntil > input.retryAt));
    const healthState = keepExistingGate ? held.healthState : input.kind;
    const blockedUntil = keepExistingGate
      ? (held.blockedUntil ?? input.retryAt)
      : input.retryAt;
    const changed = held.healthState !== healthState;
    const startedAt = held.failureStartedAt ?? now;
    const failures = held.consecutiveFailures + 1;
    await tx
      .update(monitoringSetup)
      .set({
        healthState,
        blockedUntil,
        failureStartedAt: startedAt,
        consecutiveFailures: failures,
        lastErrorAt: now,
        updatedAt: now,
      })
      .where(
        and(
          withinMonitoringProject(auth, monitoringSetup),
          eq(monitoringSetup.id, target.setupId),
        ),
      );
    await tx
      .update(retellMonitoredAgent)
      .set({
        nextPollAt: blockedUntil,
        leaseOwner: null,
        leaseExpiresAt: null,
        consecutiveFailures: sql`${retellMonitoredAgent.consecutiveFailures} + 1`,
        lastErrorKind: input.kind,
        lastErrorAt: now,
        updatedAt: now,
      })
      .where(
        and(
          withinMonitoringProject(auth, retellMonitoredAgent),
          eq(retellMonitoredAgent.id, target.monitoredAgentId),
          eq(retellMonitoredAgent.leaseOwner, target.leaseOwner),
        ),
      );
    return { changed, failures, startedAt };
  });
}

/** Clear a setup-wide outage. The caller decides whether to emit recovery log. */
export async function recoverRetellMonitoringSetup(
  auth: AuthContext,
  target: {
    readonly setupId: string;
    readonly monitoredAgentId: string;
    readonly leaseOwner: string;
    readonly apiKey: string;
    readonly setupConsecutiveFailures: number;
  },
  now = new Date(),
): Promise<
  | { readonly recovered: false }
  | {
      readonly recovered: true;
      readonly failures: number;
      readonly startedAt: Date;
    }
> {
  return db().transaction(async (tx) => {
    const [held] = await tx
      .select({
        credentials: monitoringSetup.credentials,
        healthState: monitoringSetup.healthState,
        blockedUntil: monitoringSetup.blockedUntil,
        failureStartedAt: monitoringSetup.failureStartedAt,
        consecutiveFailures: monitoringSetup.consecutiveFailures,
      })
      .from(monitoringSetup)
      .where(
        and(withinMonitoringProject(auth, monitoringSetup), eq(monitoringSetup.id, target.setupId)),
      )
      .for("update");
    if (
      held === undefined ||
      held.credentials === null ||
      openedRetellKey(held.credentials) !== target.apiKey ||
      held.consecutiveFailures !== target.setupConsecutiveFailures
    ) {
      return { recovered: false } as const;
    }
    const [leased] = await tx
      .select({ id: retellMonitoredAgent.id })
      .from(retellMonitoredAgent)
      .where(
        and(
          withinMonitoringProject(auth, retellMonitoredAgent),
          eq(retellMonitoredAgent.id, target.monitoredAgentId),
          eq(retellMonitoredAgent.monitoringSetupId, target.setupId),
          eq(retellMonitoredAgent.leaseOwner, target.leaseOwner),
        ),
      )
      .for("update");
    if (leased === undefined || held.healthState === "healthy") {
      return { recovered: false } as const;
    }
    await tx
      .update(monitoringSetup)
      .set({
        healthState: "healthy",
        blockedUntil: null,
        failureStartedAt: null,
        consecutiveFailures: 0,
        lastRecoveredAt: now,
        updatedAt: now,
      })
      .where(
        and(withinMonitoringProject(auth, monitoringSetup), eq(monitoringSetup.id, target.setupId)),
      );
    return {
      recovered: true,
      failures: held.consecutiveFailures,
      startedAt: held.failureStartedAt ?? now,
    } as const;
  });
}

/** Release a lease after a target-only failure without moving its fixed scan. */
export async function releaseRetellMonitoringLease(
  auth: AuthContext,
  target: Pick<
    RetellMonitoringTarget,
    "setupId" | "monitoredAgentId" | "leaseOwner" | "apiKey"
  >,
  input: {
    readonly retryAt: Date;
    readonly errorKind: string;
    readonly now?: Date | undefined;
  },
): Promise<void> {
  const now = input.now ?? new Date();
  await db().transaction(async (tx) => {
    const [setup] = await tx
      .select({ credentials: monitoringSetup.credentials })
      .from(monitoringSetup)
      .where(
        and(
          withinMonitoringProject(auth, monitoringSetup),
          eq(monitoringSetup.id, target.setupId),
          eq(monitoringSetup.agentPlatform, "retell"),
        ),
      )
      .for("update");
    if (setup === undefined || setup.credentials === null) return;

    const currentKey = openedRetellKey(setup.credentials);
    await tx
      .update(retellMonitoredAgent)
      .set(
        currentKey === target.apiKey
          ? {
              nextPollAt: input.retryAt,
              leaseOwner: null,
              leaseExpiresAt: null,
              consecutiveFailures: sql`${retellMonitoredAgent.consecutiveFailures} + 1`,
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
          withinMonitoringProject(auth, retellMonitoredAgent),
          eq(retellMonitoredAgent.id, target.monitoredAgentId),
          eq(retellMonitoredAgent.monitoringSetupId, target.setupId),
          eq(retellMonitoredAgent.leaseOwner, target.leaseOwner),
        ),
      );
  });
}

/**
 * Move "last heard from" forward for one agent platform, and never backward.
 *
 * **One writer, because there is one fact**: evidence for this platform reached
 * the store at this instant. A Retell call landing, a Retell claim finishing
 * after a restart and a LiveKit conversation arriving are the same sentence,
 * and one sentence with three writers is three chances to say it differently.
 *
 * **The merge is monotone, and it has to be.** Evidence becomes durable in one
 * order and is drained in another, and the instant a caller passes is the one
 * the evidence was *received* rather than the one it is being written at — so a
 * replay or a historical import carries an older instant than the row already
 * holds. A plain assignment would answer a customer's "last production
 * conversation" by winding it back to a call from an hour ago. `greatest` keeps
 * whichever instant is later, and the `coalesce` is what makes the first write
 * work at all: a column that has never been written is null, and
 * `greatest(null, x)` is null in Postgres, so a setup that had never heard from
 * anybody would stay that way forever.
 *
 * Batched by construction: the caller names a platform and, where the platform
 * has selected agents, one of them — never a call. One drained segment carrying
 * two hundred conversations of one agent is one statement here.
 */
export async function recordProductionEvidenceReceived(
  auth: AuthContext,
  input: {
    readonly agentPlatform: MonitoringPlatform;
    /** The selected agent, where the platform has them. Retell does. */
    readonly platformAgentId?: string | undefined;
    readonly receivedAt: Date;
  },
): Promise<void> {
  if (auth.projectId === undefined) return;
  const { receivedAt } = input;
  const monotone = (column: AnyPgColumn): SQL =>
    sql`greatest(coalesce(${column}, ${receivedAt}), ${receivedAt})`;
  // When the row was touched, which is a different fact from when the evidence
  // was received: a replay or a historical import carries an old `receivedAt`
  // and is happening now, and a row stamped with the older of the two would
  // report that nothing has changed since.
  const touchedAt = new Date();

  await db().transaction(async (tx) => {
    await tx
      .update(monitoringSetup)
      .set({
        lastReceivedAt: monotone(monitoringSetup.lastReceivedAt),
        updatedAt: touchedAt,
      })
      .where(
        and(
          withinMonitoringProject(auth, monitoringSetup),
          eq(monitoringSetup.agentPlatform, input.agentPlatform),
        ),
      );

    // Named agents only. A platform that has none — or a caller that did not
    // name one — moves the setup's own state and nothing else, rather than
    // every selected agent's.
    if (input.platformAgentId === undefined || input.platformAgentId === "") {
      return;
    }
    await tx
      .update(retellMonitoredAgent)
      .set({
        lastCallReceivedAt: monotone(retellMonitoredAgent.lastCallReceivedAt),
        updatedAt: touchedAt,
      })
      .where(
        and(
          withinMonitoringProject(auth, retellMonitoredAgent),
          eq(retellMonitoredAgent.platformAgentId, input.platformAgentId),
        ),
      );
  });
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
    readonly monitoredAgentId: string;
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
        eq(retellCallRetry.retellMonitoredAgentId, input.monitoredAgentId),
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
    readonly monitoredAgentId: string;
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
        eq(retellCallRetry.retellMonitoredAgentId, input.monitoredAgentId),
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
      /** The selected agent's customer-visible state changed. */
      readonly changed: boolean;
    };

type PgTransaction = Parameters<
  Parameters<ReturnType<typeof db>["transaction"]>[0]
>[0];

/**
 * The agent still owes at least one call an automatic retry.
 *
 * Asked of the agent rather than of one import generation, on the same terms as
 * the claim's own check: re-selecting an agent deletes the rows belonging to
 * the window it replaces, so every row still here belongs to the generation
 * running now.
 */
async function hasRetellCallInFlight(
  tx: PgTransaction,
  auth: AuthContext,
  monitoredAgentId: string,
): Promise<boolean> {
  const [inFlight] = await tx
    .select({ id: retellCallRetry.id })
    .from(retellCallRetry)
    .where(
      and(
        withinMonitoringProject(auth, retellCallRetry),
        eq(retellCallRetry.retellMonitoredAgentId, monitoredAgentId),
        isNotNull(retellCallRetry.nextAttemptAt),
      ),
    )
    .limit(1);
  return inFlight !== undefined;
}

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
    RetellMonitoringTarget,
    "setupId" | "monitoredAgentId" | "leaseOwner" | "importGeneration"
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
      .select({
        id: retellMonitoredAgent.id,
        state: retellMonitoredAgent.state,
      })
      .from(retellMonitoredAgent)
      .where(
        and(
          withinMonitoringProject(auth, retellMonitoredAgent),
          eq(retellMonitoredAgent.id, target.monitoredAgentId),
          eq(retellMonitoredAgent.monitoringSetupId, target.setupId),
          eq(retellMonitoredAgent.leaseOwner, target.leaseOwner),
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
        retellMonitoredAgentId: target.monitoredAgentId,
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
          retellMonitoredAgentId: target.monitoredAgentId,
          errorKind: input.errorKind,
          attempts,
          lastAttemptAt: now,
          importGeneration: target.importGeneration,
          ...schedule,
        })
        .where(eq(retellCallRetry.id, held.id));
    }

    // Degraded is the customer-visible word for "Egma is still trying", so it
    // follows what is in flight rather than what has been lost. A terminal drop
    // is not in flight: it is an evidence gap reported to an operator, and a
    // selected agent that keeps working must not wear it.
    const inFlight =
      !dropped ||
      (await hasRetellCallInFlight(tx, auth, target.monitoredAgentId));
    const state = inFlight ? "degraded" : "active";
    const changed = owned.state !== state && owned.state !== "importing";
    await tx
      .update(retellMonitoredAgent)
      .set({
        ...(owned.state === "importing" ? {} : { state }),
        lastErrorKind: input.errorKind,
        lastErrorAt: now,
        updatedAt: now,
      })
      .where(
        and(
          withinMonitoringProject(auth, retellMonitoredAgent),
          eq(retellMonitoredAgent.id, target.monitoredAgentId),
          eq(retellMonitoredAgent.leaseOwner, target.leaseOwner),
        ),
      );

    return { recorded: true, attempts, dropped, changed } as const;
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
 * `recordRetellCallAttempt` finds and reassigns it by: two selected agents that
 * both meet one provider call keep one row and one budget, so whichever agent
 * makes that call durable is the one that clears it.
 */
export async function deleteRetellCallRetry(
  auth: AuthContext,
  target: Pick<RetellMonitoringTarget, "monitoredAgentId">,
  input: { readonly providerCallId: string; readonly now?: Date | undefined },
): Promise<void> {
  const now = input.now ?? new Date();
  await db().transaction(async (tx) => {
    // The agent row first, in the same order every writer of its state takes
    // it. Two calls made durable at the same moment must not each see the
    // other's row still standing and both leave the restore to the other;
    // serialized here, whichever in-flight check runs last sees every
    // sibling's committed delete, so an agent owing nothing cannot stay
    // degraded.
    await tx
      .select({ id: retellMonitoredAgent.id })
      .from(retellMonitoredAgent)
      .where(
        and(
          withinMonitoringProject(auth, retellMonitoredAgent),
          eq(retellMonitoredAgent.id, target.monitoredAgentId),
        ),
      )
      .for("update");
    const deleted = await tx
      .delete(retellCallRetry)
      .where(
        and(
          withinMonitoringProject(auth, retellCallRetry),
          eq(retellCallRetry.providerCallId, input.providerCallId),
        ),
      )
      .returning({ id: retellCallRetry.id });
    if (deleted.length === 0) return;
    if (await hasRetellCallInFlight(tx, auth, target.monitoredAgentId)) return;
    await tx
      .update(retellMonitoredAgent)
      .set({ state: "active", updatedAt: now })
      .where(
        and(
          withinMonitoringProject(auth, retellMonitoredAgent),
          eq(retellMonitoredAgent.id, target.monitoredAgentId),
          eq(retellMonitoredAgent.state, "degraded"),
        ),
      );
  });
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
    readonly monitoredAgentId: string;
    readonly now?: Date | undefined;
  },
): Promise<number> {
  const now = input.now ?? new Date();
  const swept = await db()
    .delete(retellCallRetry)
    .where(
      and(
        withinMonitoringProject(auth, retellCallRetry),
        eq(retellCallRetry.retellMonitoredAgentId, input.monitoredAgentId),
        isNotNull(retellCallRetry.expiresAt),
        lte(retellCallRetry.expiresAt, now),
      ),
    )
    .returning({ id: retellCallRetry.id });
  return swept.length;
}
