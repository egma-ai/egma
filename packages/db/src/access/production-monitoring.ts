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
} from "drizzle-orm";

import { db } from "../client.ts";
import {
  monitoringSetup,
  productionTraceClaim,
  retellIngestionFailure,
  retellMonitoredAgent,
  type MonitoringHealthState,
  type MonitoringPlatform,
  type MonitoringStrategy,
  type RetellMonitoredAgentState,
  type RetellFailureStatus,
  type RetellScanKind,
} from "../schema/production.ts";
import { openCredentials, sealCredentials } from "../sealing.ts";
import type { AuthContext } from "./context.ts";
import { UnprocessableInputError } from "./errors.ts";
import { authorize, here } from "./permissions.ts";
import { within } from "./within.ts";

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
      "Monitoring setup belongs to one project. Select a project first.",
    );
  }
  return projectId;
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
  readonly providerAgentId: string;
  readonly providerAgentName: string;
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
    const providerAgentId = value.providerAgentId.trim();
    const providerAgentName = value.providerAgentName.trim();
    if (providerAgentId === "" || providerAgentName === "") {
      throw new UnprocessableInputError(
        "Every selected Retell agent needs its Retell id and name.",
      );
    }
    if (seen.has(providerAgentId)) {
      throw new UnprocessableInputError(
        `Retell agent ${providerAgentId} was selected more than once.`,
      );
    }
    seen.add(providerAgentId);
    return { providerAgentId, providerAgentName };
  });
}

export type RetellMonitoredAgent = {
  readonly id: string;
  readonly providerAgentId: string;
  readonly providerAgentName: string;
  readonly state: RetellMonitoredAgentState;
  readonly scanKind: RetellScanKind | null;
  readonly lastSuccessAt: Date | null;
  readonly lastCallReceivedAt: Date | null;
  readonly lastErrorKind: string | null;
  readonly lastErrorAt: Date | null;
  readonly consecutiveFailures: number;
  readonly failures: readonly RetellIngestionFailureSummary[];
};

export type RetellIngestionFailureSummary = {
  readonly id: string;
  readonly providerCallId: string;
  readonly errorKind: string;
  readonly attempts: number;
  readonly status: RetellFailureStatus;
  readonly lastAttemptAt: Date;
  readonly createdAt: Date;
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
    .where(within(auth, monitoringSetup))
    .orderBy(asc(monitoringSetup.agentPlatform));

  if (setups.length === 0) return [];
  const agents = await db()
    .select({
      id: retellMonitoredAgent.id,
      monitoringSetupId: retellMonitoredAgent.monitoringSetupId,
      providerAgentId: retellMonitoredAgent.providerAgentId,
      providerAgentName: retellMonitoredAgent.providerAgentName,
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
        within(auth, retellMonitoredAgent),
        inArray(
          retellMonitoredAgent.monitoringSetupId,
          setups.map((setup) => setup.id),
        ),
      ),
    )
    .orderBy(asc(retellMonitoredAgent.providerAgentName));

  const failures =
    agents.length === 0
      ? []
      : await db()
        .select({
          id: retellIngestionFailure.id,
          retellMonitoredAgentId:
            retellIngestionFailure.retellMonitoredAgentId,
          providerCallId: retellIngestionFailure.providerCallId,
          errorKind: retellIngestionFailure.errorKind,
          attempts: retellIngestionFailure.attempts,
          status: retellIngestionFailure.status,
          lastAttemptAt: retellIngestionFailure.lastAttemptAt,
          createdAt: retellIngestionFailure.createdAt,
        })
        .from(retellIngestionFailure)
        .where(
          and(
            within(auth, retellIngestionFailure),
            inArray(
              retellIngestionFailure.retellMonitoredAgentId,
              agents.map((agent) => agent.id),
            ),
            eq(retellIngestionFailure.status, "open"),
          ),
        )
          .orderBy(
            asc(retellIngestionFailure.createdAt),
            asc(retellIngestionFailure.id),
          );

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
        failures: failures
          .filter((failure) => failure.retellMonitoredAgentId === agent.id)
          .map(({ retellMonitoredAgentId: _agentId, ...failure }) => ({
            ...failure,
            status: failure.status as RetellFailureStatus,
          })),
      })),
  }));
}

/** Create or rotate Retell setup and synchronize its selected voice agents. */
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
  const reconcileAt = new Date(now.getTime() + RECONCILIATION_MILLISECONDS);

  await db().transaction(async (tx) => {
    const [held] = await tx
      .select({ id: monitoringSetup.id })
      .from(monitoringSetup)
      .where(
        and(
          within(auth, monitoringSetup),
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

    const selectedIds = agents.map((agent) => agent.providerAgentId);
    await tx
      .delete(retellMonitoredAgent)
      .where(
        and(
          eq(retellMonitoredAgent.monitoringSetupId, setupId),
          notInArray(retellMonitoredAgent.providerAgentId, selectedIds),
        ),
      );

    for (const selected of agents) {
      await tx
        .insert(retellMonitoredAgent)
        .values({
          id: newId("rma"),
          monitoringSetupId: setupId,
          organizationId: auth.organizationId,
          projectId,
          providerAgentId: selected.providerAgentId,
          providerAgentName: selected.providerAgentName,
          state: "importing",
          scanKind: "historical_import",
          scanFrom: historyFrom,
          scanThrough: now,
          nextRegularPollAt: now,
          nextPollAt: now,
          nextReconciliationAt: reconcileAt,
        })
        .onConflictDoUpdate({
          target: [
            retellMonitoredAgent.monitoringSetupId,
            retellMonitoredAgent.providerAgentId,
          ],
          set: {
            providerAgentName: selected.providerAgentName,
            nextPollAt: now,
            leaseOwner: null,
            leaseExpiresAt: null,
            consecutiveFailures: 0,
            lastErrorKind: null,
            lastErrorAt: null,
            updatedAt: now,
          },
        });
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
        within(auth, monitoringSetup),
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
  readonly providerAgentId: string;
  readonly providerAgentName: string;
  readonly apiKey: string;
  readonly scanKind: RetellScanKind;
  readonly scanFrom: Date;
  readonly scanThrough: Date;
  readonly paginationKey: string | null;
  readonly seenPaginationKeys: readonly string[];
  readonly setupConsecutiveFailures: number;
  readonly leaseOwner: string;
  readonly leaseExpiresAt: Date;
  readonly auth: AuthContext;
};

/** Claim one due Retell target before any provider request. */
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
        providerAgentId: retellMonitoredAgent.providerAgentId,
        providerAgentName: retellMonitoredAgent.providerAgentName,
        state: retellMonitoredAgent.state,
        scanKind: retellMonitoredAgent.scanKind,
        scanFrom: retellMonitoredAgent.scanFrom,
        scanThrough: retellMonitoredAgent.scanThrough,
        paginationKey: retellMonitoredAgent.paginationKey,
        paginationTrail: retellMonitoredAgent.paginationTrail,
        reconciliationFrom: retellMonitoredAgent.reconciliationFrom,
        reconciliationThrough: retellMonitoredAgent.reconciliationThrough,
        reconciliationPaginationKey:
          retellMonitoredAgent.reconciliationPaginationKey,
        reconciliationPaginationTrail:
          retellMonitoredAgent.reconciliationPaginationTrail,
        reconciliationNeedsRegular:
          retellMonitoredAgent.reconciliationNeedsRegular,
        completedThrough: retellMonitoredAgent.completedThrough,
        nextRegularPollAt: retellMonitoredAgent.nextRegularPollAt,
        nextReconciliationAt: retellMonitoredAgent.nextReconciliationAt,
        credentials: monitoringSetup.credentials,
        setupConsecutiveFailures: monitoringSetup.consecutiveFailures,
      })
      .from(retellMonitoredAgent)
      .innerJoin(
        monitoringSetup,
        eq(monitoringSetup.id, retellMonitoredAgent.monitoringSetupId),
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
    providerAgentId: claimed.providerAgentId,
    providerAgentName: claimed.providerAgentName,
    apiKey: openedRetellKey(claimed.credentials as string),
    scanKind: claimed.scanKind,
    scanFrom: claimed.scanFrom,
    scanThrough: claimed.scanThrough,
    paginationKey: claimed.paginationKey,
    seenPaginationKeys: claimed.seenPaginationKeys,
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
          within(auth, retellMonitoredAgent),
          within(auth, monitoringSetup),
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
          within(auth, retellMonitoredAgent),
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
        within(auth, retellMonitoredAgent),
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
  return db().transaction(async (tx) => {
    const [held] = await tx
      .select({
        scanKind: retellMonitoredAgent.scanKind,
        scanFrom: retellMonitoredAgent.scanFrom,
        scanThrough: retellMonitoredAgent.scanThrough,
        paginationKey: retellMonitoredAgent.paginationKey,
        paginationTrail: retellMonitoredAgent.paginationTrail,
        nextRegularPollAt: retellMonitoredAgent.nextRegularPollAt,
      })
      .from(retellMonitoredAgent)
      .where(
        and(
          within(auth, retellMonitoredAgent),
          eq(retellMonitoredAgent.id, target.monitoredAgentId),
          eq(retellMonitoredAgent.leaseOwner, target.leaseOwner),
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
      .update(retellMonitoredAgent)
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
          within(auth, retellMonitoredAgent),
          eq(retellMonitoredAgent.id, target.monitoredAgentId),
          eq(retellMonitoredAgent.leaseOwner, target.leaseOwner),
        ),
      )
      .returning({ id: retellMonitoredAgent.id });
    return updated.length === 1;
  });
}

/** Finish the fixed scan and release its lease. */
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
  const completedThrough =
    target.scanKind === "reconciliation" ? undefined : target.scanThrough;
  return db().transaction(async (tx) => {
    const [held] = await tx
      .select({
        reconciliationFrom: retellMonitoredAgent.reconciliationFrom,
        reconciliationThrough: retellMonitoredAgent.reconciliationThrough,
        reconciliationNeedsRegular:
          retellMonitoredAgent.reconciliationNeedsRegular,
        nextRegularPollAt: retellMonitoredAgent.nextRegularPollAt,
        nextReconciliationAt: retellMonitoredAgent.nextReconciliationAt,
      })
      .from(retellMonitoredAgent)
      .where(
        and(
          within(auth, retellMonitoredAgent),
          eq(retellMonitoredAgent.id, target.monitoredAgentId),
          eq(retellMonitoredAgent.leaseOwner, target.leaseOwner),
        ),
      )
      .for("update");
    if (held === undefined) return false;
    const [openFailure] = await tx
      .select({ id: retellIngestionFailure.id })
      .from(retellIngestionFailure)
      .where(
        and(
          within(auth, retellIngestionFailure),
          eq(
            retellIngestionFailure.retellMonitoredAgentId,
            target.monitoredAgentId,
          ),
          eq(retellIngestionFailure.status, "open"),
        ),
      )
      .limit(1);
    const degraded = openFailure !== undefined;
    const resumesReconciliation =
      target.scanKind === "regular" &&
      held.reconciliationNeedsRegular &&
      held.reconciliationFrom !== null &&
      held.reconciliationThrough !== null;
    const reconciliationReady =
      target.scanKind === "regular" &&
      (resumesReconciliation || held.nextReconciliationAt <= now);
    const updated = await tx
      .update(retellMonitoredAgent)
      .set({
        state: degraded ? "degraded" : "active",
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
        ...(degraded ? {} : { lastErrorKind: null, lastErrorAt: null }),
        lastSuccessAt: now,
        updatedAt: now,
      })
      .where(
        and(
          within(auth, retellMonitoredAgent),
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
        healthState: monitoringSetup.healthState,
        failureStartedAt: monitoringSetup.failureStartedAt,
        consecutiveFailures: monitoringSetup.consecutiveFailures,
      })
      .from(monitoringSetup)
      .where(
        and(within(auth, monitoringSetup), eq(monitoringSetup.id, target.setupId)),
      )
      .for("update");
    const changed = held?.healthState !== input.kind;
    const startedAt = held?.failureStartedAt ?? now;
    const failures = (held?.consecutiveFailures ?? 0) + 1;
    await tx
      .update(monitoringSetup)
      .set({
        healthState: input.kind,
        blockedUntil: input.retryAt,
        failureStartedAt: startedAt,
        consecutiveFailures: failures,
        lastErrorAt: now,
        updatedAt: now,
      })
      .where(
        and(within(auth, monitoringSetup), eq(monitoringSetup.id, target.setupId)),
      );
    await tx
      .update(retellMonitoredAgent)
      .set({
        nextPollAt: input.retryAt,
        leaseOwner: null,
        leaseExpiresAt: null,
        consecutiveFailures: sql`${retellMonitoredAgent.consecutiveFailures} + 1`,
        lastErrorKind: input.kind,
        lastErrorAt: now,
        updatedAt: now,
      })
      .where(
        and(
          within(auth, retellMonitoredAgent),
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
  target: Pick<RetellMonitoringTarget, "setupId">,
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
        healthState: monitoringSetup.healthState,
        failureStartedAt: monitoringSetup.failureStartedAt,
        consecutiveFailures: monitoringSetup.consecutiveFailures,
      })
      .from(monitoringSetup)
      .where(
        and(within(auth, monitoringSetup), eq(monitoringSetup.id, target.setupId)),
      )
      .for("update");
    if (held === undefined || held.healthState === "healthy") {
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
        and(within(auth, monitoringSetup), eq(monitoringSetup.id, target.setupId)),
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
  target: Pick<RetellMonitoringTarget, "monitoredAgentId" | "leaseOwner">,
  input: {
    readonly retryAt: Date;
    readonly errorKind: string;
    readonly now?: Date | undefined;
  },
): Promise<void> {
  const now = input.now ?? new Date();
  await db()
    .update(retellMonitoredAgent)
    .set({
      nextPollAt: input.retryAt,
      leaseOwner: null,
      leaseExpiresAt: null,
      consecutiveFailures: sql`${retellMonitoredAgent.consecutiveFailures} + 1`,
      lastErrorKind: input.errorKind,
      lastErrorAt: now,
      updatedAt: now,
    })
    .where(
      and(
        within(auth, retellMonitoredAgent),
        eq(retellMonitoredAgent.id, target.monitoredAgentId),
        eq(retellMonitoredAgent.leaseOwner, target.leaseOwner),
      ),
    );
}

export async function recordRetellCallReceived(
  auth: AuthContext,
  target: Pick<RetellMonitoringTarget, "setupId" | "monitoredAgentId">,
  receivedAt: Date,
): Promise<void> {
  await db().transaction(async (tx) => {
    await tx
      .update(monitoringSetup)
      .set({ lastReceivedAt: receivedAt, updatedAt: new Date() })
      .where(
        and(within(auth, monitoringSetup), eq(monitoringSetup.id, target.setupId)),
      );
    await tx
      .update(retellMonitoredAgent)
      .set({ lastCallReceivedAt: receivedAt, updatedAt: new Date() })
      .where(
        and(
          within(auth, retellMonitoredAgent),
          eq(retellMonitoredAgent.id, target.monitoredAgentId),
        ),
      );
  });
}

/** Keep setup health truthful when a stale claim finishes after a restart. */
export async function recordRetellMonitoringReceived(
  auth: AuthContext,
  input: {
    readonly providerAgentId: string;
    readonly receivedAt?: Date | undefined;
  },
): Promise<void> {
  const receivedAt = input.receivedAt ?? new Date();
  await db().transaction(async (tx) => {
    await tx
      .update(monitoringSetup)
      .set({ lastReceivedAt: receivedAt, updatedAt: receivedAt })
      .where(
        and(
          within(auth, monitoringSetup),
          eq(monitoringSetup.agentPlatform, "retell"),
        ),
      );
    await tx
      .update(retellMonitoredAgent)
      .set({ lastCallReceivedAt: receivedAt, updatedAt: receivedAt })
      .where(
        and(
          within(auth, retellMonitoredAgent),
          eq(retellMonitoredAgent.providerAgentId, input.providerAgentId),
        ),
      );
  });
}

/** Called after a valid LiveKit production export reaches the shared store. */
export async function recordLiveKitMonitoringReceived(
  auth: AuthContext,
  receivedAt = new Date(),
): Promise<void> {
  if (auth.projectId === undefined) return;
  await db()
    .update(monitoringSetup)
    .set({ lastReceivedAt: receivedAt, updatedAt: receivedAt })
    .where(
      and(
        within(auth, monitoringSetup),
        eq(monitoringSetup.agentPlatform, "livekit_agents"),
      ),
    );
}

/** A summary is already owned by a completed claim or a durable failure. */
export async function retellCallIsAccountedFor(
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
          within(auth, productionTraceClaim),
          eq(productionTraceClaim.projectId, projectId),
          eq(productionTraceClaim.providerCallId, providerCallId),
        ),
      )
      .limit(1),
    db()
      .select({ id: retellIngestionFailure.id })
      .from(retellIngestionFailure)
      .where(
        and(
          within(auth, retellIngestionFailure),
          eq(retellIngestionFailure.projectId, projectId),
          eq(retellIngestionFailure.providerCallId, providerCallId),
          eq(retellIngestionFailure.status, "open"),
        ),
      )
      .limit(1),
  ]);
  return claim.length > 0 || failure.length > 0;
}

export async function recordRetellIngestionFailure(
  auth: AuthContext,
  target: RetellMonitoringTarget,
  input: {
    readonly providerCallId: string;
    readonly errorKind: string;
    readonly safePayload?: string | undefined;
    readonly now?: Date | undefined;
  },
): Promise<{ readonly changed: boolean }> {
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
          within(auth, retellMonitoredAgent),
          eq(retellMonitoredAgent.id, target.monitoredAgentId),
        ),
      )
      .limit(1);
    if (owned === undefined) {
      throw new UnprocessableInputError(
        "The Retell Monitoring target is not in this project.",
      );
    }
    await tx
      .insert(retellIngestionFailure)
      .values({
        id: newId("rif"),
        organizationId: auth.organizationId,
        projectId,
        retellMonitoredAgentId: target.monitoredAgentId,
        providerCallId: input.providerCallId,
        errorKind: input.errorKind,
        payload: input.safePayload,
        status: "open",
        lastAttemptAt: now,
      })
      .onConflictDoUpdate({
        target: [
          retellIngestionFailure.projectId,
          retellIngestionFailure.providerCallId,
        ],
        set: {
          errorKind: input.errorKind,
          payload: input.safePayload,
          attempts: sql`${retellIngestionFailure.attempts} + 1`,
          status: "open",
          resolvedAt: null,
          lastAttemptAt: now,
        },
      });
    await tx
      .update(retellMonitoredAgent)
      .set({
        state: "degraded",
        lastErrorKind: input.errorKind,
        lastErrorAt: now,
        updatedAt: now,
      })
      .where(
        and(
          within(auth, retellMonitoredAgent),
          eq(retellMonitoredAgent.id, target.monitoredAgentId),
        ),
      );
    return { changed: owned.state !== "degraded" };
  });
}

export type RetellIngestionFailureReplayTarget = {
  readonly setupId: string;
  readonly monitoredAgentId: string;
  readonly failureId: string;
  readonly providerCallId: string;
  readonly providerAgentId: string;
  readonly providerAgentName: string;
  readonly apiKey: string;
  readonly setupConsecutiveFailures: number;
  readonly leaseOwner: string;
  readonly leaseExpiresAt: Date;
  readonly auth: AuthContext;
};

export type RetellIngestionFailureReplayClaim =
  | {
      readonly kind: "claimed";
      readonly target: RetellIngestionFailureReplayTarget;
    }
  | {
      readonly kind: "busy";
      readonly reason: MonitoringFailureKind | "replay_in_progress";
      readonly retryAt: Date;
    }
  | { readonly kind: "not_found" };

/**
 * Lease one customer-requested failed call and open the current setup key.
 *
 * The failure id is always resolved inside the caller's project. A failure in
 * another tenant therefore has the same result as an unknown failure id.
 */
export async function claimRetellIngestionFailureReplay(
  auth: AuthContext,
  failureId: string,
  options: {
    readonly now?: Date | undefined;
    readonly leaseMilliseconds?: number | undefined;
  } = {},
): Promise<RetellIngestionFailureReplayClaim> {
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
        failureId: retellIngestionFailure.id,
        providerCallId: retellIngestionFailure.providerCallId,
        replayLeaseExpiresAt: retellIngestionFailure.replayLeaseExpiresAt,
        monitoredAgentId: retellMonitoredAgent.id,
        providerAgentId: retellMonitoredAgent.providerAgentId,
        providerAgentName: retellMonitoredAgent.providerAgentName,
        setupId: monitoringSetup.id,
        organizationId: monitoringSetup.organizationId,
        projectId: monitoringSetup.projectId,
        credentials: monitoringSetup.credentials,
        healthState: monitoringSetup.healthState,
        blockedUntil: monitoringSetup.blockedUntil,
        setupConsecutiveFailures: monitoringSetup.consecutiveFailures,
      })
      .from(retellIngestionFailure)
      .innerJoin(
        retellMonitoredAgent,
        eq(
          retellMonitoredAgent.id,
          retellIngestionFailure.retellMonitoredAgentId,
        ),
      )
      .innerJoin(
        monitoringSetup,
        eq(monitoringSetup.id, retellMonitoredAgent.monitoringSetupId),
      )
      .where(
        and(
          within(auth, retellIngestionFailure),
          within(auth, retellMonitoredAgent),
          within(auth, monitoringSetup),
          eq(retellIngestionFailure.id, failureId),
          eq(retellIngestionFailure.status, "open"),
          eq(monitoringSetup.agentPlatform, "retell"),
        ),
      )
      .for("update", { of: retellIngestionFailure });
    if (candidate === undefined || candidate.credentials === null) {
      return { kind: "not_found" } as const;
    }
    if (candidate.blockedUntil !== null && candidate.blockedUntil > now) {
      const reason = candidate.healthState as MonitoringHealthState;
      return {
        kind: "busy",
        reason: reason === "healthy" ? "provider_unavailable" : reason,
        retryAt: candidate.blockedUntil,
      } as const;
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
    const apiKey = openedRetellKey(candidate.credentials);

    const updated = await tx
      .update(retellIngestionFailure)
      .set({
        replayLeaseOwner: leaseOwner,
        replayLeaseExpiresAt: leaseExpiresAt,
        attempts: sql`${retellIngestionFailure.attempts} + 1`,
        lastAttemptAt: now,
      })
      .where(
        and(
          within(auth, retellIngestionFailure),
          eq(retellIngestionFailure.id, candidate.failureId),
          eq(retellIngestionFailure.status, "open"),
        ),
      )
      .returning({ id: retellIngestionFailure.id });
    if (updated.length !== 1) return { kind: "not_found" } as const;
    return { kind: "claimed", candidate, apiKey } as const;
  });

  if (claimed.kind !== "claimed") return claimed;
  return {
    kind: "claimed",
    target: {
      setupId: claimed.candidate.setupId,
      monitoredAgentId: claimed.candidate.monitoredAgentId,
      failureId: claimed.candidate.failureId,
      providerCallId: claimed.candidate.providerCallId,
      providerAgentId: claimed.candidate.providerAgentId,
      providerAgentName: claimed.candidate.providerAgentName,
      apiKey: claimed.apiKey,
      setupConsecutiveFailures:
        claimed.candidate.setupConsecutiveFailures,
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
export async function releaseRetellIngestionFailureReplay(
  auth: AuthContext,
  target: Pick<
    RetellIngestionFailureReplayTarget,
    "failureId" | "leaseOwner"
  >,
  input: {
    readonly errorKind: string;
    readonly now?: Date | undefined;
  },
): Promise<boolean> {
  const now = input.now ?? new Date();
  const released = await db()
    .update(retellIngestionFailure)
    .set({
      errorKind: input.errorKind,
      lastAttemptAt: now,
      replayLeaseOwner: null,
      replayLeaseExpiresAt: null,
    })
    .where(
      and(
        within(auth, retellIngestionFailure),
        eq(retellIngestionFailure.id, target.failureId),
        eq(retellIngestionFailure.status, "open"),
        eq(retellIngestionFailure.replayLeaseOwner, target.leaseOwner),
      ),
    )
    .returning({ id: retellIngestionFailure.id });
  return released.length === 1;
}

export type RetellIngestionFailureReplayProviderResult = {
  readonly recorded: boolean;
  readonly changed: boolean;
  readonly failures: number;
  readonly startedAt: Date;
};

/** Record a setup-wide provider failure and release one manual replay lease. */
export async function failRetellIngestionFailureReplay(
  auth: AuthContext,
  target: Pick<
    RetellIngestionFailureReplayTarget,
    "setupId" | "failureId" | "leaseOwner"
  >,
  input: {
    readonly kind: MonitoringFailureKind;
    readonly retryAt: Date;
    readonly now?: Date | undefined;
  },
): Promise<RetellIngestionFailureReplayProviderResult> {
  const now = input.now ?? new Date();
  return db().transaction(async (tx) => {
    const [failure] = await tx
      .select({ id: retellIngestionFailure.id })
      .from(retellIngestionFailure)
      .innerJoin(
        retellMonitoredAgent,
        eq(
          retellMonitoredAgent.id,
          retellIngestionFailure.retellMonitoredAgentId,
        ),
      )
      .where(
        and(
          within(auth, retellIngestionFailure),
          within(auth, retellMonitoredAgent),
          eq(retellIngestionFailure.id, target.failureId),
          eq(retellIngestionFailure.status, "open"),
          eq(retellIngestionFailure.replayLeaseOwner, target.leaseOwner),
          eq(retellMonitoredAgent.monitoringSetupId, target.setupId),
        ),
      )
      .for("update", { of: retellIngestionFailure });
    const [held] = await tx
      .select({
        healthState: monitoringSetup.healthState,
        failureStartedAt: monitoringSetup.failureStartedAt,
        consecutiveFailures: monitoringSetup.consecutiveFailures,
      })
      .from(monitoringSetup)
      .where(
        and(
          within(auth, monitoringSetup),
          eq(monitoringSetup.id, target.setupId),
          eq(monitoringSetup.agentPlatform, "retell"),
        ),
      )
      .for("update");
    if (failure === undefined || held === undefined) {
      return {
        recorded: false,
        changed: false,
        failures: held?.consecutiveFailures ?? 0,
        startedAt: held?.failureStartedAt ?? now,
      };
    }

    const changed = held.healthState !== input.kind;
    const startedAt = held.failureStartedAt ?? now;
    const failures = held.consecutiveFailures + 1;
    await tx
      .update(monitoringSetup)
      .set({
        healthState: input.kind,
        blockedUntil: input.retryAt,
        failureStartedAt: startedAt,
        consecutiveFailures: failures,
        lastErrorAt: now,
        updatedAt: now,
      })
      .where(
        and(within(auth, monitoringSetup), eq(monitoringSetup.id, target.setupId)),
      );
    await tx
      .update(retellIngestionFailure)
      .set({
        replayLeaseOwner: null,
        replayLeaseExpiresAt: null,
        lastAttemptAt: now,
      })
      .where(
        and(
          within(auth, retellIngestionFailure),
          eq(retellIngestionFailure.id, target.failureId),
          eq(retellIngestionFailure.replayLeaseOwner, target.leaseOwner),
        ),
      );
    return { recorded: true, changed, failures, startedAt };
  });
}

/** Resolve one replayed failure and recover the agent only when none remain. */
export async function resolveRetellIngestionFailureReplay(
  auth: AuthContext,
  target: Pick<
    RetellIngestionFailureReplayTarget,
    "monitoredAgentId" | "failureId" | "leaseOwner"
  >,
  options: { readonly now?: Date | undefined } = {},
): Promise<{ readonly resolved: boolean; readonly agentRecovered: boolean }> {
  const now = options.now ?? new Date();
  return db().transaction(async (tx) => {
    const [agent] = await tx
      .select({
        state: retellMonitoredAgent.state,
        scanKind: retellMonitoredAgent.scanKind,
      })
      .from(retellMonitoredAgent)
      .where(
        and(
          within(auth, retellMonitoredAgent),
          eq(retellMonitoredAgent.id, target.monitoredAgentId),
        ),
      )
      .for("update");
    if (agent === undefined) {
      return { resolved: false, agentRecovered: false };
    }

    const resolved = await tx
      .update(retellIngestionFailure)
      .set({
        status: "resolved",
        resolvedAt: now,
        replayLeaseOwner: null,
        replayLeaseExpiresAt: null,
      })
      .where(
        and(
          within(auth, retellIngestionFailure),
          eq(retellIngestionFailure.id, target.failureId),
          eq(
            retellIngestionFailure.retellMonitoredAgentId,
            target.monitoredAgentId,
          ),
          eq(retellIngestionFailure.status, "open"),
          eq(retellIngestionFailure.replayLeaseOwner, target.leaseOwner),
        ),
      )
      .returning({ id: retellIngestionFailure.id });
    if (resolved.length !== 1) {
      return { resolved: false, agentRecovered: false };
    }

    const [remaining] = await tx
      .select({
        errorKind: retellIngestionFailure.errorKind,
        lastAttemptAt: retellIngestionFailure.lastAttemptAt,
      })
      .from(retellIngestionFailure)
      .where(
        and(
          within(auth, retellIngestionFailure),
          eq(
            retellIngestionFailure.retellMonitoredAgentId,
            target.monitoredAgentId,
          ),
          eq(retellIngestionFailure.status, "open"),
        ),
      )
      .orderBy(
        desc(retellIngestionFailure.lastAttemptAt),
        desc(retellIngestionFailure.id),
      )
      .limit(1);
    const agentRecovered =
      agent.state === "degraded" && remaining === undefined;
    await tx
      .update(retellMonitoredAgent)
      .set(
        remaining === undefined
          ? {
              state: agent.scanKind === null ? "active" : "importing",
              consecutiveFailures: 0,
              lastErrorKind: null,
              lastErrorAt: null,
              lastSuccessAt: now,
              updatedAt: now,
            }
          : {
              state: "degraded",
              lastErrorKind: remaining.errorKind,
              lastErrorAt: remaining.lastAttemptAt,
              updatedAt: now,
            },
      )
      .where(
        and(
          within(auth, retellMonitoredAgent),
          eq(retellMonitoredAgent.id, target.monitoredAgentId),
        ),
      );
    return { resolved: true, agentRecovered };
  });
}

export type ProductionTraceOffer = {
  readonly traceId: string;
  readonly providerCallId: string;
  readonly providerAgentId: string;
  readonly providerAgentName?: string | undefined;
  readonly providerAgentVersion?: string | undefined;
  readonly payload: string;
  readonly endedAt: Date;
};

export type ProductionTraceClaim = ProductionTraceOffer & {
  readonly id: string;
  readonly degraded: boolean;
  readonly auth: AuthContext;
};

/** Atomically own one Retell call before writing it to ClickHouse. */
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
      providerAgentId: offer.providerAgentId,
      providerAgentName: offer.providerAgentName,
      providerAgentVersion: offer.providerAgentVersion,
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
      within(
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
        providerAgentId: productionTraceClaim.providerAgentId,
        providerAgentName: productionTraceClaim.providerAgentName,
        providerAgentVersion: productionTraceClaim.providerAgentVersion,
        payload: productionTraceClaim.payload,
        endedAt: productionTraceClaim.endedAt,
        degraded: productionTraceClaim.degraded,
      });
  });
  return rows.map((row) => ({
    id: row.id,
    traceId: row.traceId,
    providerCallId: row.providerCallId,
    providerAgentId: row.providerAgentId,
    ...(row.providerAgentName === null
      ? {}
      : { providerAgentName: row.providerAgentName }),
    ...(row.providerAgentVersion === null
      ? {}
      : { providerAgentVersion: row.providerAgentVersion }),
    payload: row.payload,
    endedAt: row.endedAt,
    degraded: row.degraded,
    auth: monitoringContext(row.organizationId, row.projectId),
  }));
}
